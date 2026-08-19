import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import {
  buildClaudeAuthStatusCommand,
  buildClaudeLoginCommand,
  runClaudeAuthStatus,
  runClaudeLogin,
} from "./login-terminal";
import { switchClaudeAccount } from "./switch-account";

type SwitchPhase = "cancellable" | "cancelling" | "committed";

const UNCLEAN_TERMINALS_KEY = "unclean-login-terminals-v1";

interface UncleanTerminalRecord {
  readonly hostId: string;
  readonly terminalId: string;
}

interface ActiveSwitch {
  readonly controller: AbortController;
  readonly mode: "current" | "login";
  readonly settled: Promise<void>;
  phase: SwitchPhase;
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
  const hostLocks = new Set<string>();
  const activeLoginTerminals = new Map<string, string>();
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
  ): Promise<void> {
    await bb.sdk.terminals.close({ terminalId, mode });
  }

  async function settleTerminal(terminalId: string): Promise<void> {
    activeTerminals.delete(terminalId);
    const wasUnclean = uncleanTerminals.delete(terminalId);
    for (const [threadId, activeTerminalId] of activeLoginTerminals) {
      if (activeTerminalId === terminalId) activeLoginTerminals.delete(threadId);
    }
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

  async function reconcileFailedCleanup(hostId: string): Promise<void> {
    const activeReconciliation = cleanupReconciliations.get(hostId);
    if (activeReconciliation) return activeReconciliation;

    const reconciliation = (async () => {
      while (true) {
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

  bb.rpc.register(rpcContract, {
    async cancelSwitch({ threadId }) {
      const active = activeSwitches.get(threadId);
      if (!active) return { outcome: "not-running" as const };
      if (active.phase === "committed") {
        return { outcome: "completing" as const };
      }
      if (active.phase === "cancelling") {
        await active.settled;
        return {
          outcome:
            active.mode === "login"
              ? ("cancelled-before-login" as const)
              : ("cancelled-before-release" as const),
        };
      }

      active.phase = "cancelling";
      active.controller.abort();
      await active.settled;
      return {
        outcome:
          active.mode === "login"
            ? ("cancelled-before-login" as const)
            : ("cancelled-before-release" as const),
      };
    },

    async inspectThread({ threadId }) {
      const thread = await bb.sdk.threads.get({ threadId });
      return { isClaude: thread.providerId === "claude-code" };
    },

    async submitLoginCode({ code, threadId }) {
      const active = activeSwitches.get(threadId);
      const terminalId = activeLoginTerminals.get(threadId);
      if (
        !terminalId ||
        !active ||
        active.mode !== "login" ||
        active.phase !== "cancellable"
      ) {
        throw new Error("No Claude login is waiting for an authorization code.");
      }
      await bb.sdk.terminals.input({
        terminalId,
        dataBase64: Buffer.from(`${code}\n`, "utf8").toString("base64"),
      });
      return { submitted: true as const };
    },

    async switchAccount({ email, mode, threadId }) {
      if (activeSwitches.has(threadId)) {
        throw new Error("A Claude account switch is already open for this session.");
      }
      if (mode === "current" && email !== undefined) {
        throw new Error("Email is only used when signing in to another account.");
      }

      const controller = new AbortController();
      let markSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        markSettled = resolve;
      });
      const active: ActiveSwitch = {
        controller,
        mode,
        phase: "cancellable",
        settled,
      };
      activeSwitches.set(threadId, active);

      try {
        return await switchClaudeAccount(
          {
            getThread: async (targetThreadId) => {
              const target = await bb.sdk.threads.get({
                include: "environment",
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
              await runClaudeLogin(
                {
                  close: closeTerminal,
                  create: async (targetId) => {
                    const terminal = await bb.sdk.terminals.create({
                      cols: 80,
                      rows: 24,
                      scope: { kind: "thread", threadId: targetId },
                      start: {
                        mode: "command",
                        command: buildClaudeLoginCommand(email),
                      },
                      title: "Sign in to Claude",
                    });
                    activeTerminals.add(terminal.id);
                    activeLoginTerminals.set(targetId, terminal.id);
                    return terminal;
                  },
                  get: (terminalId) => bb.sdk.terminals.get({ terminalId }),
                  onCleanupFailed: markUncleanTerminal,
                  onSettled: settleTerminal,
                },
                targetThreadId,
                { onSuccess, signal },
              );
            },
            reconcileCleanup: reconcileFailedCleanup,
            stopThread: async (targetThreadId) => {
              await bb.sdk.threads.stop({ threadId: targetThreadId });
            },
            verifySubscription: async (targetThreadId, hostId) => {
              await runClaudeAuthStatus(
                {
                  close: closeTerminal,
                  create: async (targetId) => {
                    const terminal = await bb.sdk.terminals.create({
                      cols: 80,
                      rows: 8,
                      scope: { kind: "thread", threadId: targetId },
                      start: {
                        mode: "command",
                        command: buildClaudeAuthStatusCommand(),
                      },
                      title: "Verify Claude login",
                    });
                    activeTerminals.add(terminal.id);
                    return terminal;
                  },
                  get: (terminalId) => bb.sdk.terminals.get({ terminalId }),
                  onCleanupFailed: markUncleanTerminal,
                  onSettled: settleTerminal,
                  output: async (terminalId) => {
                    const output = await bb.sdk.terminals.output({
                      limitChunks: 8,
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
                { signal: controller.signal, timeoutMs: 15_000 },
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
        );
      } finally {
        if (activeSwitches.get(threadId) === active) {
          activeSwitches.delete(threadId);
        }
        markSettled();
      }
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
    activeLoginTerminals.clear();
    activeTerminals.clear();
    cleanupReconciliations.clear();
    hostLocks.clear();
    activeSwitches.clear();
  });
}
