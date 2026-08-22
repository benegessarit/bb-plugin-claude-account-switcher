import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import {
  buildClaudeAuthStatusCommand,
  buildClaudeLoginCommand,
  runClaudeAuthStatus,
  runClaudeLogin,
  type LoginTerminal,
} from "./login-terminal";
import { HostReservations, switchClaudeAccount } from "./switch-account";

type SwitchPhase = "cancellable" | "cancelling" | "committed";
type SwitchResult =
  | { readonly outcome: "cancelled" }
  | { readonly outcome: "ready-next-message" }
  | { readonly outcome: "login-changed-not-rebound" };

const UNCLEAN_TERMINALS_KEY = "unclean-login-terminals-v1";

interface UncleanTerminalRecord {
  readonly hostId: string;
  readonly terminalId: string;
}

interface ActiveSwitch {
  readonly controller: AbortController;
  readonly id: string;
  readonly mode: "current" | "login";
  readonly result: Promise<SwitchResult>;
  readonly settled: Promise<void>;
  loginTerminal?: { readonly hostId: string; readonly id: string };
  phase: SwitchPhase;
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

function decodeTerminalOutput(
  chunks: readonly { readonly dataBase64: string }[],
): string {
  return chunks
    .map(({ dataBase64 }) => Buffer.from(dataBase64, "base64").toString("utf8"))
    .join("");
}

function parseUncleanTerminals(value: unknown): Map<string, string> {
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
    records.set(candidate.terminalId, candidate.hostId);
  }
  return records;
}

export default async function plugin(bb: BbPluginApi) {
  const hostLocks = new HostReservations();
  const uncleanTerminals = parseUncleanTerminals(
    await bb.storage.kv.get<unknown>(UNCLEAN_TERMINALS_KEY),
  );
  const activeTerminals = new Set(uncleanTerminals.keys());
  const activeSwitches = new Map<string, ActiveSwitch>();
  const cleanupReconciliations = new Map<string, Promise<void>>();
  let cleanupPersistence: Promise<void> = Promise.resolve();

  function persistUncleanTerminals(): Promise<void> {
    cleanupPersistence = cleanupPersistence
      .catch(() => undefined)
      .then(async () => {
        const records: UncleanTerminalRecord[] = [...uncleanTerminals].map(
          ([terminalId, hostId]) => ({ hostId, terminalId }),
        );
        if (records.length === 0) {
          await bb.storage.kv.delete(UNCLEAN_TERMINALS_KEY);
        } else {
          await bb.storage.kv.set(UNCLEAN_TERMINALS_KEY, records);
        }
      });
    return cleanupPersistence;
  }

  async function closeTerminal(
    terminalId: string,
    mode: "force" | "if-clean",
  ): Promise<LoginTerminal> {
    return bb.sdk.terminals.close({ terminalId, mode });
  }

  async function settleTerminal(terminalId: string): Promise<void> {
    activeTerminals.delete(terminalId);
    for (const active of activeSwitches.values()) {
      if (active.loginTerminal?.id === terminalId) active.loginTerminal = undefined;
    }
    const wasUnclean = uncleanTerminals.delete(terminalId);
    if (wasUnclean) await persistUncleanTerminals();
  }

  async function markUncleanTerminal(
    terminalId: string,
    hostId: string,
  ): Promise<void> {
    uncleanTerminals.set(terminalId, hostId);
    activeTerminals.add(terminalId);
    await persistUncleanTerminals();
  }

  async function verifyTerminalHost(
    terminal: { readonly hostId: string; readonly id: string },
    expectedHostId: string,
  ): Promise<void> {
    if (terminal.hostId === expectedHostId) return;
    hostLocks.add(terminal.hostId);
    activeTerminals.add(terminal.id);
    try {
      await closeTerminal(terminal.id, "force");
      await settleTerminal(terminal.id);
    } catch {
      await markUncleanTerminal(terminal.id, terminal.hostId);
    } finally {
      hostLocks.delete(terminal.hostId);
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
    const activeReconciliation = cleanupReconciliations.get(hostId);
    if (activeReconciliation) return activeReconciliation;

    const reconciliation = (async () => {
      while (true) {
        if (signal.aborted) {
          throw new Error(
            "Claude login was cancelled. This BB session was not changed.",
          );
        }
        const terminalIds = [...uncleanTerminals]
          .filter(([, terminalHostId]) => terminalHostId === hostId)
          .map(([terminalId]) => terminalId);
        if (terminalIds.length === 0) return;

        let cleanupFailed = false;
        for (const terminalId of terminalIds) {
          try {
            await closeTerminal(terminalId, "force");
            await settleTerminal(terminalId);
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
    })();
    cleanupReconciliations.set(hostId, reconciliation);
    try {
      await reconciliation;
    } finally {
      if (cleanupReconciliations.get(hostId) === reconciliation) {
        cleanupReconciliations.delete(hostId);
      }
    }
  }

  async function resolveClaudeExecutable(
    hostId: string,
    signal: AbortSignal,
  ): Promise<string> {
    const status = await bb.sdk.hosts.providerCliStatus({ hostId, signal });
    const executablePath = status.claudeCode.executablePath;
    if (
      !status.claudeCode.installed ||
      !executablePath ||
      !executablePath.startsWith("/")
    ) {
      throw new Error("BB could not resolve Claude Code on this session's machine.");
    }
    return executablePath;
  }

  bb.rpc.register(rpcContract, {
    async attachSwitch({ operationId, threadId }) {
      const active = activeSwitches.get(threadId);
      if (!active || active.id !== operationId) {
        return { outcome: "not-running" as const };
      }
      return active.result;
    },

    async cancelSwitch({ operationId, threadId }) {
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
      const active = activeSwitches.get(threadId);
      if (!active) return { status: "none" as const };
      return {
        codeReady: active.loginTerminal !== undefined,
        mode: active.mode,
        operationId: active.id,
        phase: active.phase,
        status: "running" as const,
      };
    },

    async submitLoginCode({ code, operationId, threadId }) {
      const active = activeSwitches.get(threadId);
      const terminalId = active?.loginTerminal?.id;
      if (
        !active ||
        active.id !== operationId ||
        active.mode !== "login" ||
        active.phase !== "cancellable" ||
        !terminalId
      ) {
        throw new Error("Claude login is not waiting for an authorization code.");
      }
      active.loginTerminal = undefined;
      await bb.sdk.terminals.input({
        dataBase64: Buffer.from(`${code}\n`, "utf8").toString("base64"),
        terminalId,
      });
      return { submitted: true as const };
    },

    async switchAccount({ mode, operationId, threadId }) {
      const existing = activeSwitches.get(threadId);
      if (existing) {
        if (existing.id !== operationId || existing.mode !== mode) {
          throw new Error("A different Claude account switch is already open.");
        }
        return existing.result;
      }

      const controller = new AbortController();
      let resolveResult!: (result: SwitchResult) => void;
      let rejectResult!: (error: unknown) => void;
      const result = new Promise<SwitchResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const settled = result.then(
        () => undefined,
        () => undefined,
      );
      const active: ActiveSwitch = {
        controller,
        id: operationId,
        mode,
        phase: "cancellable",
        result,
        settled,
      };
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
                        await verifyTerminalHost(terminal, hostId);
                        activeTerminals.add(terminal.id);
                        return terminal;
                      },
                      get: (terminalId, signal) =>
                        bb.sdk.terminals.get({ signal, terminalId }),
                      onCleanupFailed: markUncleanTerminal,
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
                        await verifyTerminalHost(terminal, hostId);
                        activeTerminals.add(terminal.id);
                        return terminal;
                      },
                      get: (terminalId, signal) =>
                        bb.sdk.terminals.get({ signal, terminalId }),
                      onCleanupFailed: markUncleanTerminal,
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
                markCommitted: () => {
                  active.phase = "committed";
                },
              },
            ),
          );
        } catch (error) {
          if (controller.signal.aborted && active.phase !== "committed") {
            resolveResult({ outcome: "cancelled" });
          } else {
            rejectResult(error);
          }
        } finally {
          if (activeSwitches.get(threadId) === active) {
            activeSwitches.delete(threadId);
          }
        }
      })();

      return result;
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
      [...activeTerminals].map(async (terminalId) => {
        try {
          await closeTerminal(terminalId, "force");
          await settleTerminal(terminalId);
        } catch {
          // The terminal may already have exited or its host may be offline.
        }
      }),
    );
    await persistUncleanTerminals();
    activeTerminals.clear();
    cleanupReconciliations.clear();
    hostLocks.clear();
    activeSwitches.clear();
  });
}
