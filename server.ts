import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import {
  buildClaudeAuthStatusCommand,
  buildClaudeAuthorizationReopenCommand,
  buildClaudeLoginCommand,
} from "./login-host-command";
import {
  runClaudeAuthorizationReopen,
  runClaudeAuthStatus,
  runClaudeLogin,
  type LoginTerminal,
} from "./login-terminal";
import {
  HostReservations,
  SwitchAdmissionError,
  switchClaudeAccount,
  type SwitchStep,
} from "./switch-account";

type SwitchPhase = "cancellable" | "cancelling" | "committed";
type SwitchResult =
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "ready-next-message" }
  | { readonly outcome: "login-changed-not-rebound" };
type SwitchCompletion =
  | { readonly kind: "result"; readonly result: SwitchResult }
  | { readonly kind: "error"; readonly message: string };
type SwitchAdmission =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "host-busy" }
  | {
      readonly mode: "current" | "login";
      readonly operationId: string;
      readonly outcome: "thread-busy";
    }
  | {
      readonly outcome: "thread-not-ready";
      readonly reason:
        | "machine-unavailable"
        | "not-claude"
        | "thread-not-idle"
        | "thread-not-ready";
    };

const TERMINAL_OWNERSHIP_KEY = "unclean-login-terminals-v1";
const RESULT_RECEIPT_TTL_MS = 60_000;

interface OwnedTerminalRecord {
  readonly hostId: string;
  readonly terminalId: string;
}

interface ActiveSwitch {
  authorizationAction?: Promise<void>;
  authorizationActionsClosed: boolean;
  authorizationLauncher?: {
    readonly hostId: string;
    readonly loginTerminalId: string;
    readonly path: string;
  };
  authorizationTerminal?: { readonly hostId: string; readonly id: string };
  readonly controller: AbortController;
  readonly id: string;
  readonly mode: "current" | "login";
  readonly rejectAdmission: (error: unknown) => void;
  readonly result: Promise<SwitchResult>;
  readonly resolveAdmission: (admission: SwitchAdmission) => void;
  admitted: boolean;
  admissionSettled: boolean;
  loginCodeSubmitting: boolean;
  loginTerminal?: { readonly hostId: string; readonly id: string };
  phase: SwitchPhase;
  settled: Promise<void>;
  step: SwitchStep;
  readonly threadId: string;
}

interface FinishedSwitch {
  readonly completion: SwitchCompletion;
  readonly expiresAt: number;
  readonly id: string;
  readonly mode: "current" | "login";
  readonly threadId: string;
}

type AuthorizationLauncher = NonNullable<ActiveSwitch["authorizationLauncher"]>;
type LoginTerminalRef = NonNullable<ActiveSwitch["loginTerminal"]>;

function availableAuthorizationLauncher(
  active: ActiveSwitch | undefined,
): AuthorizationLauncher | undefined {
  if (
    !active ||
    active.mode !== "login" ||
    active.phase !== "cancellable" ||
    active.step !== "login" ||
    active.authorizationActionsClosed ||
    active.authorizationAction !== undefined ||
    active.loginCodeSubmitting ||
    !active.loginTerminal
  ) {
    return undefined;
  }
  return active.authorizationLauncher;
}

function availableLoginTerminal(
  active: ActiveSwitch | undefined,
): LoginTerminalRef | undefined {
  if (
    !active ||
    active.mode !== "login" ||
    active.phase !== "cancellable" ||
    active.authorizationAction !== undefined ||
    active.authorizationTerminal !== undefined ||
    active.loginCodeSubmitting
  ) {
    return undefined;
  }
  return active.loginTerminal;
}

function messageFrom(error: unknown): string {
  const message = error instanceof Error ? error.message : "The account switch failed.";
  return message.slice(0, 1_000) || "The account switch failed.";
}

function settledCancellationOutcome(active: ActiveSwitch) {
  if (active.phase === "committed") {
    return { outcome: "completing" as const };
  }
  return {
    outcome:
      active.mode === "login"
        ? ("cancelled-before-login" as const)
        : ("cancelled-before-release" as const),
  };
}

async function closeAuthorizationActions(active: ActiveSwitch): Promise<void> {
  active.authorizationActionsClosed = true;
  await active.authorizationAction?.catch(() => undefined);
}

function decodeTerminalOutput(
  chunks: readonly { readonly dataBase64: string }[],
): string {
  return chunks
    .map(({ dataBase64 }) => Buffer.from(dataBase64, "base64").toString("utf8"))
    .join("");
}

function parseTerminalOwnership(value: unknown): Map<string, string> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("Stored Claude login cleanup state is invalid.");
  }
  const records = new Map<string, string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("terminalId" in candidate) ||
      !("hostId" in candidate) ||
      typeof candidate.terminalId !== "string" ||
      !candidate.terminalId ||
      typeof candidate.hostId !== "string" ||
      !candidate.hostId
    ) {
      throw new Error("Stored Claude login cleanup state is invalid.");
    }
    if (records.has(candidate.terminalId)) {
      throw new Error("Stored Claude login cleanup state is invalid.");
    }
    records.set(candidate.terminalId, candidate.hostId);
  }
  return records;
}

export default async function plugin(bb: BbPluginApi) {
  const hostLocks = new HostReservations();
  const ownedTerminals = parseTerminalOwnership(
    await bb.storage.kv.get<unknown>(TERMINAL_OWNERSHIP_KEY),
  );
  const activeSwitches = new Map<string, ActiveSwitch>();
  const finishedSwitches = new Map<string, FinishedSwitch>();
  const latestFinishedByThread = new Map<string, string>();
  let ownershipRevision = 0;
  let durableOwnershipRevision = 0;
  let ownershipPersistence: Promise<void> = Promise.resolve();

  function purgeFinishedSwitches(now = Date.now()): void {
    for (const [operationId, finished] of finishedSwitches) {
      if (finished.expiresAt > now) continue;
      finishedSwitches.delete(operationId);
      if (latestFinishedByThread.get(finished.threadId) === operationId) {
        latestFinishedByThread.delete(finished.threadId);
      }
    }
  }

  function finishSwitch(active: ActiveSwitch, completion: SwitchCompletion): void {
    if (activeSwitches.get(active.threadId) === active) {
      activeSwitches.delete(active.threadId);
    }
    if (!active.admitted) return;
    const finished: FinishedSwitch = {
      completion,
      expiresAt: Date.now() + RESULT_RECEIPT_TTL_MS,
      id: active.id,
      mode: active.mode,
      threadId: active.threadId,
    };
    finishedSwitches.set(active.id, finished);
    latestFinishedByThread.set(active.threadId, active.id);
  }

  function settleAdmission(active: ActiveSwitch, admission: SwitchAdmission): void {
    if (active.admissionSettled) return;
    active.admissionSettled = true;
    if (admission.outcome !== "accepted") {
      if (activeSwitches.get(active.threadId) === active) {
        activeSwitches.delete(active.threadId);
      }
    }
    active.resolveAdmission(admission);
  }

  function failAdmission(active: ActiveSwitch, error: unknown): void {
    if (active.admissionSettled) return;
    active.admissionSettled = true;
    if (activeSwitches.get(active.threadId) === active) {
      activeSwitches.delete(active.threadId);
    }
    active.rejectAdmission(error);
  }

  function persistTerminalOwnership(): Promise<void> {
    const revision = ownershipRevision;
    const records: OwnedTerminalRecord[] = [...ownedTerminals]
      .map(([terminalId, hostId]) => ({ hostId, terminalId }))
      .sort((left, right) => left.terminalId.localeCompare(right.terminalId));
    ownershipPersistence = ownershipPersistence
      .catch(() => undefined)
      .then(async () => {
        if (records.length === 0) {
          await bb.storage.kv.delete(TERMINAL_OWNERSHIP_KEY);
        } else {
          await bb.storage.kv.set(TERMINAL_OWNERSHIP_KEY, records);
        }
        durableOwnershipRevision = Math.max(durableOwnershipRevision, revision);
      });
    return ownershipPersistence;
  }

  function terminalOwnershipIsDurable(): boolean {
    return durableOwnershipRevision >= ownershipRevision;
  }

  async function closeTerminal(
    terminalId: string,
    mode: "force" | "if-clean",
  ): Promise<LoginTerminal> {
    return bb.sdk.terminals.close({ terminalId, mode });
  }

  async function settleTerminal(terminalId: string): Promise<void> {
    for (const active of activeSwitches.values()) {
      if (active.loginTerminal?.id === terminalId) {
        active.loginTerminal = undefined;
        if (active.authorizationLauncher?.loginTerminalId === terminalId) {
          active.authorizationLauncher = undefined;
        }
      }
      if (active.authorizationTerminal?.id === terminalId) {
        active.authorizationTerminal = undefined;
      }
    }
    if (!ownedTerminals.delete(terminalId)) return;
    ownershipRevision += 1;
    await persistTerminalOwnership();
  }

  async function adoptTerminal(terminalId: string, hostId: string): Promise<void> {
    const existingHostId = ownedTerminals.get(terminalId);
    if (existingHostId !== undefined) {
      if (existingHostId !== hostId) {
        throw new Error("BB reported one Claude helper on two machines.");
      }
      if (!terminalOwnershipIsDurable()) await persistTerminalOwnership();
      return;
    }
    ownedTerminals.set(terminalId, hostId);
    ownershipRevision += 1;
    await persistTerminalOwnership();
  }

  async function releaseTerminalIfExited(
    terminalId: string,
    terminal: LoginTerminal,
  ): Promise<boolean> {
    if (terminal.status !== "exited") return false;
    await settleTerminal(terminalId);
    return true;
  }

  async function adoptCreatedTerminal(
    terminal: LoginTerminal,
    expectedHostId: string,
    onUncertainLogin?: () => void,
  ): Promise<LoginTerminal> {
    try {
      await adoptTerminal(terminal.id, terminal.hostId);
    } catch (error) {
      try {
        const closed = await closeTerminal(terminal.id, "force");
        if (closed.status === "exited") {
          if (ownedTerminals.delete(terminal.id)) ownershipRevision += 1;
          if (closed.exitCode === 0) onUncertainLogin?.();
        } else {
          onUncertainLogin?.();
        }
      } catch {
        onUncertainLogin?.();
      }
      throw error;
    }
    await verifyTerminalHost(terminal, expectedHostId);
    return terminal;
  }

  async function verifyTerminalHost(
    terminal: { readonly hostId: string; readonly id: string },
    expectedHostId: string,
  ): Promise<void> {
    if (terminal.hostId === expectedHostId) return;
    const cleanupLease = {};
    hostLocks.reserve(terminal.hostId, cleanupLease);
    try {
      const closed = await closeTerminal(terminal.id, "force");
      if (!(await releaseTerminalIfExited(terminal.id, closed))) {
        await adoptTerminal(terminal.id, terminal.hostId);
      }
    } catch {
      await adoptTerminal(terminal.id, terminal.hostId);
    } finally {
      hostLocks.release(terminal.hostId, cleanupLease);
    }
    throw new Error("BB opened the Claude helper on a different machine.");
  }

  async function reconcileFailedCleanup(
    hostId: string,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) {
      throw new Error("Claude login was cancelled. This BB session was not changed.");
    }
    while (true) {
      if (signal.aborted) {
        throw new Error("Claude login was cancelled. This BB session was not changed.");
      }
      const terminalIds = [...ownedTerminals]
        .filter(([, terminalHostId]) => terminalHostId === hostId)
        .map(([terminalId]) => terminalId);
      if (terminalIds.length === 0) return;

      let cleanupFailed = false;
      for (const terminalId of terminalIds) {
        try {
          const closed = await closeTerminal(terminalId, "force");
          if (!(await releaseTerminalIfExited(terminalId, closed))) {
            cleanupFailed = true;
          }
        } catch {
          cleanupFailed = true;
        }
      }
      if (cleanupFailed) {
        throw new Error(
          "A previous Claude login helper could not be stopped. Reconnect its machine, then try again.",
        );
      }
    }
  }

  async function resolveClaudeExecutable(
    hostId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const status = await bb.sdk.hosts.providerCliStatus({ hostId, signal });
    const providerStatuses = status as unknown as Record<
      string,
      | {
          readonly executablePath?: unknown;
          readonly installed?: unknown;
        }
      | undefined
    >;
    const claudeStatus = providerStatuses["claude-code"] ?? providerStatuses.claudeCode;
    const executablePath = claudeStatus?.executablePath;
    if (
      claudeStatus?.installed !== true ||
      typeof executablePath !== "string" ||
      !executablePath.startsWith("/")
    ) {
      throw new Error("BB could not resolve Claude Code on this session's machine.");
    }
    return executablePath;
  }

  bb.rpc.register(rpcContract, {
    async attachSwitch({ operationId, threadId }) {
      purgeFinishedSwitches();
      const active = activeSwitches.get(threadId);
      if (active?.id === operationId) {
        await active.settled;
        return active.result;
      }
      const finished = finishedSwitches.get(operationId);
      if (!finished || finished.threadId !== threadId) {
        return { outcome: "not-running" as const };
      }
      if (finished.completion.kind === "error") {
        throw new Error(finished.completion.message);
      }
      return finished.completion.result;
    },

    async cancelSwitch({ operationId, threadId }) {
      purgeFinishedSwitches();
      const active = activeSwitches.get(threadId);
      if (!active || active.id !== operationId) {
        return { outcome: "not-running" as const };
      }
      if (active.phase === "committed") {
        return { outcome: "completing" as const };
      }
      if (active.phase === "cancelling") {
        await active.settled;
        return settledCancellationOutcome(active);
      }

      active.phase = "cancelling";
      active.controller.abort();
      await active.settled;
      return settledCancellationOutcome(active);
    },

    async inspectThread({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      return { isClaude: thread.providerId === "claude-code" };
    },

    async inspectSwitch({ threadId }) {
      purgeFinishedSwitches();
      const active = activeSwitches.get(threadId);
      if (active) {
        return {
          canReturnToAuthorization:
            availableAuthorizationLauncher(active) !== undefined,
          codeReady: availableLoginTerminal(active) !== undefined,
          mode: active.mode,
          operationId: active.id,
          phase: active.phase,
          status: "running" as const,
          step: active.step,
        };
      }
      const operationId = latestFinishedByThread.get(threadId);
      const finished = operationId ? finishedSwitches.get(operationId) : undefined;
      if (!finished) return { status: "none" as const };
      return {
        completion: finished.completion,
        mode: finished.mode,
        operationId: finished.id,
        status: "finished" as const,
      };
    },

    async reopenAuthorization({ operationId, threadId }) {
      const active = activeSwitches.get(threadId);
      const authorization = availableAuthorizationLauncher(active);
      if (!active || active.id !== operationId || !authorization) {
        throw new Error("Claude login is not waiting to return to authorization.");
      }

      const authorizationLease = {};
      hostLocks.reserve(authorization.hostId, authorizationLease);
      const action = (async () => {
        const unresolved = active.authorizationTerminal;
        if (unresolved) {
          let closed: LoginTerminal;
          try {
            closed = await closeTerminal(unresolved.id, "force");
          } catch {
            throw new Error(
              "A previous authorization helper is still being cleaned up. Try again in a moment.",
            );
          }
          if (!(await releaseTerminalIfExited(unresolved.id, closed))) {
            throw new Error(
              "A previous authorization helper is still being cleaned up. Try again in a moment.",
            );
          }
        }

        await runClaudeAuthorizationReopen(
          {
            close: closeTerminal,
            create: async () => {
              const terminal = await bb.sdk.terminals.create({
                cols: 80,
                rows: 8,
                scope: {
                  cwd: null,
                  hostId: authorization.hostId,
                  kind: "host_path",
                },
                start: {
                  mode: "command",
                  command: buildClaudeAuthorizationReopenCommand(authorization.path),
                },
                title: "Return to Claude authorization",
              });
              if (activeSwitches.get(threadId) === active) {
                active.authorizationTerminal = {
                  hostId: terminal.hostId,
                  id: terminal.id,
                };
              }
              try {
                return await adoptCreatedTerminal(terminal, authorization.hostId);
              } catch (error) {
                if (
                  activeSwitches.get(threadId) === active &&
                  active.authorizationTerminal?.id === terminal.id &&
                  !ownedTerminals.has(terminal.id)
                ) {
                  active.authorizationTerminal = undefined;
                }
                throw error;
              }
            },
            get: (terminalId, signal) => bb.sdk.terminals.get({ signal, terminalId }),
            onCleanupFailed: adoptTerminal,
            onSettled: settleTerminal,
          },
          threadId,
          { signal: active.controller.signal },
        );
      })();
      active.authorizationAction = action;
      try {
        await action;
        return { opened: true as const };
      } finally {
        hostLocks.release(authorization.hostId, authorizationLease);
        if (
          activeSwitches.get(threadId) === active &&
          active.authorizationAction === action
        ) {
          active.authorizationAction = undefined;
        }
      }
    },

    async submitLoginCode({ code, operationId, threadId }) {
      const active = activeSwitches.get(threadId);
      const terminal = availableLoginTerminal(active);
      if (!active || active.id !== operationId || !terminal) {
        throw new Error("Claude login is not waiting for an authorization code.");
      }
      active.loginCodeSubmitting = true;
      try {
        await bb.sdk.terminals.input({
          dataBase64: Buffer.from(`${code}\n`, "utf8").toString("base64"),
          terminalId: terminal.id,
        });
        if (
          activeSwitches.get(threadId) === active &&
          active.loginTerminal === terminal
        ) {
          active.loginTerminal = undefined;
        }
        return { submitted: true as const };
      } finally {
        if (activeSwitches.get(threadId) === active) {
          active.loginCodeSubmitting = false;
        }
      }
    },

    async beginSwitch({ mode, operationId, threadId }) {
      purgeFinishedSwitches();
      const existing = activeSwitches.get(threadId);
      if (existing) {
        return {
          mode: existing.mode,
          operationId: existing.id,
          outcome: "thread-busy" as const,
        };
      }

      const controller = new AbortController();
      let resolveAdmission!: (admission: SwitchAdmission) => void;
      let rejectAdmission!: (error: unknown) => void;
      const admission = new Promise<SwitchAdmission>((resolve, reject) => {
        resolveAdmission = resolve;
        rejectAdmission = reject;
      });
      let resolveResult!: (result: SwitchResult) => void;
      let rejectResult!: (error: unknown) => void;
      const result = new Promise<SwitchResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const active: ActiveSwitch = {
        admitted: false,
        admissionSettled: false,
        authorizationActionsClosed: false,
        controller,
        id: operationId,
        loginCodeSubmitting: false,
        mode,
        phase: "cancellable",
        rejectAdmission,
        result,
        resolveAdmission,
        settled: Promise.resolve(),
        step: "admitting",
        threadId,
      };
      active.settled = result.then(
        async (switchResult) => {
          await closeAuthorizationActions(active);
          finishSwitch(active, { kind: "result", result: switchResult });
        },
        async (error: unknown) => {
          await closeAuthorizationActions(active);
          finishSwitch(active, { kind: "error", message: messageFrom(error) });
        },
      );
      activeSwitches.set(threadId, active);
      let executableHostId: string | undefined;
      let executablePath: Promise<string> | undefined;
      const getClaudeExecutable = (hostId: string, signal: AbortSignal) => {
        if (executableHostId !== undefined && executableHostId !== hostId) {
          throw new Error("This session changed before BB could run Claude Code.");
        }
        executableHostId = hostId;
        executablePath ??= resolveClaudeExecutable(hostId, signal);
        return executablePath;
      };

      void (async () => {
        try {
          resolveResult(
            await switchClaudeAccount(
              {
                getThread: async (targetThreadId, signal) => {
                  const target = await bb.sdk.threads.get({
                    include: "environment",
                    signal,
                    threadId: targetThreadId,
                  });
                  return {
                    environment:
                      "environment" in target && target.environment
                        ? { hostId: target.environment.hostId }
                        : null,
                    providerId: target.providerId,
                    status: target.status,
                  };
                },
                login: async (targetThreadId, hostId, signal, onSuccess) => {
                  const claudeExecutable = await getClaudeExecutable(hostId, signal);
                  await runClaudeLogin(
                    {
                      close: closeTerminal,
                      create: async (targetId) => {
                        const terminal = await bb.sdk.terminals.create({
                          cols: 80,
                          rows: 24,
                          scope: { cwd: null, hostId, kind: "host_path" },
                          start: {
                            mode: "command",
                            command: buildClaudeLoginCommand(claudeExecutable),
                          },
                          title: "Sign in to Claude",
                        });
                        return adoptCreatedTerminal(terminal, hostId, onSuccess);
                      },
                      get: (terminalId, signal) =>
                        bb.sdk.terminals.get({ signal, terminalId }),
                      onCleanupFailed: adoptTerminal,
                      onSettled: settleTerminal,
                      output: async (terminalId, signal) => {
                        const output = await bb.sdk.terminals.output({
                          limitChunks: 8,
                          signal,
                          tailBytes: 4_096,
                          terminalId,
                        });
                        if (output.truncated) {
                          throw new Error(
                            "Claude login readiness output was incomplete.",
                          );
                        }
                        return decodeTerminalOutput(output.chunks);
                      },
                    },
                    targetThreadId,
                    {
                      onAuthorizationReady: (terminalId, path) => {
                        if (
                          activeSwitches.get(threadId) === active &&
                          active.phase === "cancellable"
                        ) {
                          active.authorizationLauncher = {
                            hostId,
                            loginTerminalId: terminalId,
                            path,
                          };
                        }
                      },
                      onInputReady: (terminalId) => {
                        active.loginTerminal = { hostId, id: terminalId };
                      },
                      onSuccess,
                      signal,
                    },
                  );
                },
                reconcileCleanup: reconcileFailedCleanup,
                stopThread: async (targetThreadId) => {
                  await closeAuthorizationActions(active);
                  await bb.sdk.threads.stop({ threadId: targetThreadId });
                },
                verifySubscription: async (targetThreadId, hostId, signal) => {
                  const claudeExecutable = await getClaudeExecutable(hostId, signal);
                  await runClaudeAuthStatus(
                    {
                      close: closeTerminal,
                      create: async (targetId) => {
                        const terminal = await bb.sdk.terminals.create({
                          cols: 80,
                          rows: 8,
                          scope: { cwd: null, hostId, kind: "host_path" },
                          start: {
                            mode: "command",
                            command: buildClaudeAuthStatusCommand(claudeExecutable),
                          },
                          title: "Verify Claude login",
                        });
                        return adoptCreatedTerminal(terminal, hostId);
                      },
                      get: (terminalId, signal) =>
                        bb.sdk.terminals.get({ signal, terminalId }),
                      onCleanupFailed: adoptTerminal,
                      onSettled: settleTerminal,
                      output: async (terminalId, signal) => {
                        const output = await bb.sdk.terminals.output({
                          limitChunks: 8,
                          signal,
                          tailBytes: 4_096,
                          terminalId,
                        });
                        if (output.truncated) {
                          throw new Error("Claude auth status output was incomplete.");
                        }
                        return decodeTerminalOutput(output.chunks);
                      },
                    },
                    targetThreadId,
                    { signal, timeoutMs: 15_000 },
                  );
                },
              },
              { mode, threadId },
              hostLocks,
              controller.signal,
              {
                markAdmitted: () => {
                  active.admitted = true;
                  settleAdmission(active, { outcome: "accepted" });
                },
                markCommitted: () => {
                  active.phase = "committed";
                },
                setStep: (step) => {
                  active.step = step;
                },
              },
            ),
          );
        } catch (error) {
          if (!active.admissionSettled) {
            if (controller.signal.aborted) {
              settleAdmission(active, { outcome: "cancelled" });
            } else if (error instanceof SwitchAdmissionError) {
              if (error.reason === "host-busy") {
                settleAdmission(active, { outcome: "host-busy" });
              } else {
                settleAdmission(active, {
                  outcome: "thread-not-ready",
                  reason: error.reason,
                });
              }
            } else {
              failAdmission(active, error);
            }
          }
          if (controller.signal.aborted && active.phase !== "committed") {
            resolveResult({ outcome: "cancelled" });
          } else {
            rejectResult(error);
          }
        }
      })();

      return admission;
    },
  });

  bb.onDispose(async () => {
    const switches = [...activeSwitches.values()];
    for (const active of switches) {
      if (active.phase === "cancellable") active.phase = "cancelling";
      active.controller.abort();
    }
    await Promise.all(switches.map(({ settled }) => settled));
    await Promise.all(
      [...ownedTerminals].map(async ([terminalId, hostId]) => {
        try {
          const closed = await closeTerminal(terminalId, "force");
          if (
            !(await releaseTerminalIfExited(terminalId, closed)) &&
            !terminalOwnershipIsDurable()
          ) {
            await adoptTerminal(terminalId, hostId);
          }
        } catch {
          // The terminal may already have exited or its host may be offline.
        }
      }),
    );
    while (ownedTerminals.size > 0 && !terminalOwnershipIsDurable()) {
      try {
        await persistTerminalOwnership();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    if (ownedTerminals.size === 0 && !terminalOwnershipIsDurable()) {
      await persistTerminalOwnership().catch(() => undefined);
    }
    hostLocks.clear();
    activeSwitches.clear();
    finishedSwitches.clear();
    latestFinishedByThread.clear();
  });
}
