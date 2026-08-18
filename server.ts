import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { rpcContract } from "./contract";
import { buildClaudeLoginCommand, runClaudeLogin } from "./login-terminal";
import { switchClaudeAccount } from "./switch-account";

export default function plugin(bb: BbPluginApi) {
  const hostLocks = new Set<string>();
  const activeLoginTerminals = new Map<string, string>();
  const activeSwitches = new Map<
    string,
    {
      controller: AbortController;
      settled: Promise<void>;
    }
  >();

  bb.rpc.register(rpcContract, {
    async cancelSwitch({ threadId }) {
      const active = activeSwitches.get(threadId);
      if (!active) return { cancelled: false };

      active.controller.abort();
      await active.settled;
      return { cancelled: true };
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

    async switchAccount({ email, threadId }) {
      if (activeSwitches.has(threadId)) {
        throw new Error("A Claude account switch is already open for this session.");
      }

      const controller = new AbortController();
      let markSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        markSettled = resolve;
      });
      const active = { controller, settled };
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
            getThread: (targetThreadId) =>
              bb.sdk.threads.get({ threadId: targetThreadId }),
            login: (targetThreadId, signal) =>
              runClaudeLogin(
                {
                  close: async (terminalId, mode) => {
                    await bb.sdk.terminals.close({ terminalId, mode });
                  },
                  create: async (targetId) => {
                    const terminal = await bb.sdk.terminals.create({
                      cols: 80,
                      rows: 24,
                      scope: { kind: "thread", threadId: targetId },
                      start: {
                        mode: "command",
                        command: buildClaudeLoginCommand(email),
                      },
                      title: "Switch Claude account",
                    });
                    activeLoginTerminals.set(targetId, terminal.id);
                    return terminal;
                  },
                  get: (terminalId) => bb.sdk.terminals.get({ terminalId }),
                  onSettled: (terminalId) => {
                    if (activeLoginTerminals.get(targetThreadId) === terminalId) {
                      activeLoginTerminals.delete(targetThreadId);
                    }
                  },
                },
                targetThreadId,
                { signal },
              ),
            stopThread: async (targetThreadId) => {
              await bb.sdk.threads.stop({ threadId: targetThreadId });
            },
          },
          threadId,
          hostLocks,
          controller.signal,
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
    for (const active of activeSwitches.values()) {
      active.controller.abort();
    }
    await Promise.all(
      [...activeLoginTerminals.values()].map(async (terminalId) => {
        try {
          await bb.sdk.terminals.close({ terminalId, mode: "force" });
        } catch {
          // The terminal may already have exited or the host may be offline.
        }
      }),
    );
    activeLoginTerminals.clear();
    hostLocks.clear();
    activeSwitches.clear();
  });
}
