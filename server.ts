import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import {
  buildClaudeAuthStatusCommand,
  buildClaudeLoginCommand,
  runClaudeAuthStatus,
  runClaudeLogin,
} from "./login-terminal";
import { switchClaudeAccount } from "./switch-account";

type SwitchPhase = "cancellable" | "committed";

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

export default function plugin(bb: BbPluginApi) {
  const hostLocks = new Set<string>();
  const activeLoginTerminals = new Map<string, string>();
  const activeTerminals = new Set<string>();
  const activeSwitches = new Map<string, ActiveSwitch>();

  async function closeTerminal(
    terminalId: string,
    mode: "force" | "if-clean",
  ): Promise<void> {
    await bb.sdk.terminals.close({ terminalId, mode });
  }

  function settleTerminal(threadId: string, terminalId: string): void {
    activeTerminals.delete(terminalId);
    if (activeLoginTerminals.get(threadId) === terminalId) {
      activeLoginTerminals.delete(threadId);
    }
  }

  bb.rpc.register(rpcContract, {
    async cancelSwitch({ threadId }) {
      const active = activeSwitches.get(threadId);
      if (!active) return { outcome: "not-running" as const };
      if (active.phase === "committed") {
        return { outcome: "completing" as const };
      }

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
      const terminalId = activeLoginTerminals.get(threadId);
      if (!terminalId) {
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
            continueThread: async (targetThreadId, failedRequestId) => {
              await bb.sdk.threads.continueAfterRateLimit({
                threadId: targetThreadId,
                failedRequestId,
                mode: "manual",
              });
            },
            getRecovery: (targetThreadId) =>
              bb.sdk.threads.rateLimitRecovery({ threadId: targetThreadId }),
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
            login: async (targetThreadId, signal, onSuccess) => {
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
                  onSettled: (terminalId) => settleTerminal(targetThreadId, terminalId),
                },
                targetThreadId,
                { onSuccess, signal },
              );
            },
            stopThread: async (targetThreadId) => {
              await bb.sdk.threads.stop({ threadId: targetThreadId });
            },
            verifySubscription: async (targetThreadId, hostId) => {
              const usage = await bb.sdk.system.usageLimits({ hostId });
              if (usage.claudeCode.status !== "ok" || !usage.claudeCode.planLabel) {
                throw new Error(
                  "BB could not verify an active Claude subscription on this session's machine.",
                );
              }

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
                  onSettled: (terminalId) => settleTerminal(targetThreadId, terminalId),
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
    for (const active of switches) active.controller.abort();
    await Promise.all(switches.map(({ settled }) => settled));
    await Promise.all(
      [...activeTerminals].map(async (terminalId) => {
        try {
          await closeTerminal(terminalId, "force");
        } catch {
          // The terminal may already have exited or its host may be offline.
        }
      }),
    );
    activeLoginTerminals.clear();
    activeTerminals.clear();
    hostLocks.clear();
    activeSwitches.clear();
  });
}
