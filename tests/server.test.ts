import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost as createSdkFakePluginHost } from "@get-bb/plugin-sdk/testing";
// @ts-expect-error The build artifact intentionally has no declaration file.
import plugin from "../dist/server.js";

const DEFAULT_OPERATION_ID = "a5a3434e-3728-4951-8c3f-a17ca2f5f234";
const STALE_OPERATION_ID = "00000000-0000-4000-8000-000000000000";

type InspectedSwitch =
  | { readonly status: "none" }
  | {
      readonly codeReady: boolean;
      readonly mode: "current" | "login";
      readonly operationId: string;
      readonly phase: "cancellable" | "cancelling" | "committed";
      readonly status: "running";
    };

const providerCliStatus = {
  claudeCode: {
    currentVersion: "2.1.235",
    displayName: "Claude Code",
    executableName: "claude",
    executablePath: "/opt/trusted claude/bin/claude",
    installAction: null,
    installSource: "external" as const,
    installed: true,
    latestVersion: null,
    minimumSupportedVersion: null,
    needsUpdate: false,
    npmGlobalPackageVersion: null,
    npmPackageName: null,
    versionUnsupported: false,
  },
  codex: {
    currentVersion: null,
    displayName: "Codex",
    executableName: "codex",
    executablePath: null,
    installAction: null,
    installSource: "notInstalled" as const,
    installed: false,
    latestVersion: null,
    minimumSupportedVersion: null,
    needsUpdate: false,
    npmGlobalPackageVersion: null,
    npmPackageName: null,
    versionUnsupported: false,
  },
  cursor: {
    currentVersion: null,
    displayName: "Cursor",
    executableName: "cursor-agent",
    executablePath: null,
    installAction: null,
    installSource: "notInstalled" as const,
    installed: false,
    latestVersion: null,
    minimumSupportedVersion: null,
    needsUpdate: false,
    npmGlobalPackageVersion: null,
    npmPackageName: null,
    versionUnsupported: false,
  },
};

function createFakePluginHost(
  options: NonNullable<Parameters<typeof createSdkFakePluginHost>[0]>,
) {
  return createSdkFakePluginHost({
    ...options,
    sdk: {
      ...options.sdk,
      hosts: {
        providerCliStatus: async () => providerCliStatus,
        ...options.sdk?.hosts,
      },
    },
  });
}

test("the current-login RPC verifies the exact host and releases an idle runtime", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 0,
          hostId: "host_1",
          id: "status_terminal",
          status: "exited" as const,
        }),
        create: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "status_terminal",
          status: "running" as const,
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
              ).toString("base64"),
              seq: 1,
            },
          ],
          nextSeq: 2,
          truncated: false,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
        stop: async () => ({ ok: true as const }),
      },
    },
  });
  await plugin(host.bb);

  try {
    const result = await host.harness.behavior.callRpc("switchAccount", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "current",
      threadId: "thread_1",
    });

    assert.deepEqual(result, { outcome: "ready-next-message" });
    const createRequest = host.harness.inspection.sdk.callsTo(
      "terminals.create",
    )[0]![0] as { readonly scope: unknown };
    assert.deepEqual(createRequest.scope, {
      cwd: null,
      hostId: "host_1",
      kind: "host_path",
    });
    assert.match(
      (createRequest as { readonly start?: { readonly command?: string } }).start
        ?.command ?? "",
      /\/opt\/trusted claude\/bin\/claude/,
    );
    assert.equal(host.harness.inspection.sdk.callsTo("system.usageLimits").length, 0);
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("authorization code delivery is gated, serialized, and retry-safe", async () => {
  let loginCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    loginCreated = resolve;
  });
  let releaseMarker!: () => void;
  const markerGate = new Promise<void>((resolve) => {
    releaseMarker = resolve;
  });
  let inputStarted!: () => void;
  const firstInputStarted = new Promise<void>((resolve) => {
    inputStarted = resolve;
  });
  let rejectFirstInput!: (error: Error) => void;
  const firstInput = new Promise<never>((_resolve, reject) => {
    rejectFirstInput = reject;
  });
  let inputAttempts = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 1,
          hostId: "host_1",
          id: "login_terminal",
          status: "exited" as const,
        }),
        create: async () => {
          loginCreated();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal",
          status: "running" as const,
        }),
        input: async () => {
          inputAttempts += 1;
          if (inputAttempts === 1) {
            inputStarted();
            await firstInput;
          }
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "running" as const,
          };
        },
        output: async () => {
          await markerGate;
          return {
            chunks: [
              {
                dataBase64: Buffer.from("BB_CLAUDE_LOGIN_INPUT_READY\n").toString(
                  "base64",
                ),
                seq: 1,
              },
            ],
            nextSeq: 2,
            truncated: false,
          };
        },
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const switching = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  const inspectCodeReady = async () => {
    const inspected = (await host.harness.behavior.callRpc("inspectSwitch", {
      threadId: "thread_1",
    })) as InspectedSwitch;
    assert.equal(inspected.status, "running");
    if (inspected.status !== "running") throw new Error("Expected active switch.");
    return inspected.codeReady;
  };

  try {
    await created;
    const loginRequest = host.harness.inspection.sdk.callsTo(
      "terminals.create",
    )[0]![0] as { readonly start?: { readonly command?: string } };
    const loginCommand = loginRequest.start?.command ?? "";
    assert.match(loginCommand, /BROWSER=/);
    assert.match(loginCommand, /--incognito/);
    assert.match(loginCommand, /--new-window/);
    assert.doesNotMatch(loginCommand, /--email|--user-data-dir|open -n|open -na/);
    await assert.rejects(
      host.harness.behavior.callRpc("submitLoginCode", {
        operationId: DEFAULT_OPERATION_ID,
        code: "one-time-code",
        threadId: "thread_1",
      }),
      /not waiting for an authorization code/,
    );

    releaseMarker();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(await inspectCodeReady(), true);
    await assert.rejects(
      host.harness.behavior.callRpc("submitLoginCode", {
        code: "stale-code",
        operationId: STALE_OPERATION_ID,
        threadId: "thread_1",
      }),
      /not waiting for an authorization code/,
    );
    const firstSubmission = host.harness.behavior.callRpc("submitLoginCode", {
      operationId: DEFAULT_OPERATION_ID,
      code: "first-code",
      threadId: "thread_1",
    });
    await firstInputStarted;
    assert.equal(await inspectCodeReady(), false);
    await assert.rejects(
      host.harness.behavior.callRpc("submitLoginCode", {
        operationId: DEFAULT_OPERATION_ID,
        code: "overlapping-code",
        threadId: "thread_1",
      }),
      /not waiting for an authorization code/,
    );
    const firstFailure = assert.rejects(firstSubmission, /terminal input failed/);
    rejectFirstInput(new Error("terminal input failed"));
    await firstFailure;
    assert.equal(await inspectCodeReady(), true);

    assert.deepEqual(
      await host.harness.behavior.callRpc("submitLoginCode", {
        operationId: DEFAULT_OPERATION_ID,
        code: "retry-code",
        threadId: "thread_1",
      }),
      { submitted: true },
    );
    assert.equal(await inspectCodeReady(), false);
    await assert.rejects(
      host.harness.behavior.callRpc("submitLoginCode", {
        operationId: DEFAULT_OPERATION_ID,
        code: "second-code",
        threadId: "thread_1",
      }),
      /not waiting for an authorization code/,
    );
    assert.deepEqual(host.harness.inspection.sdk.callsTo("terminals.input"), [
      [
        {
          dataBase64: Buffer.from("first-code\n").toString("base64"),
          terminalId: "login_terminal",
        },
      ],
      [
        {
          dataBase64: Buffer.from("retry-code\n").toString("base64"),
          terminalId: "login_terminal",
        },
      ],
    ]);
  } finally {
    releaseMarker();
    await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    });
    await switching.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("late code delivery cannot mutate a replacement switch", async () => {
  for (const lateOutcome of ["resolve", "reject"] as const) {
    let terminalCreates = 0;
    let firstInputStarted!: () => void;
    const inputStarted = new Promise<void>((resolve) => {
      firstInputStarted = resolve;
    });
    let resolveFirstInput!: (value: {
      exitCode: null;
      hostId: string;
      id: string;
      status: "running";
    }) => void;
    let rejectFirstInput!: (error: Error) => void;
    const firstInput = new Promise<{
      exitCode: null;
      hostId: string;
      id: string;
      status: "running";
    }>((resolve, reject) => {
      resolveFirstInput = resolve;
      rejectFirstInput = reject;
    });
    let inputAttempts = 0;
    const host = createFakePluginHost({
      pluginId: "claude-account-switcher",
      sdk: {
        terminals: {
          close: async (request) => ({
            exitCode: 1,
            hostId: "host_1",
            id: request.terminalId,
            status: "exited" as const,
          }),
          create: async () => {
            terminalCreates += 1;
            return {
              exitCode: null,
              hostId: "host_1",
              id: `login_terminal_${terminalCreates}`,
              status: "running" as const,
            };
          },
          get: async (request) => ({
            exitCode: null,
            hostId: "host_1",
            id: request.terminalId,
            status: "running" as const,
          }),
          input: async () => {
            inputAttempts += 1;
            if (inputAttempts === 1) {
              firstInputStarted();
              return firstInput;
            }
            throw new Error("Unexpected second terminal input.");
          },
          output: async () => ({
            chunks: [
              {
                dataBase64: Buffer.from("BB_CLAUDE_LOGIN_INPUT_READY\n").toString(
                  "base64",
                ),
                seq: 1,
              },
            ],
            nextSeq: 2,
            truncated: false,
          }),
        },
        threads: {
          get: async () => ({
            environment: { hostId: "host_1" },
            providerId: "claude-code",
            status: "idle" as const,
          }),
        },
      },
    });
    await plugin(host.bb);
    const waitForCode = async (operationId: string) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const inspected = (await host.harness.behavior.callRpc("inspectSwitch", {
          threadId: "thread_1",
        })) as InspectedSwitch;
        if (
          inspected.status === "running" &&
          inspected.operationId === operationId &&
          inspected.codeReady
        ) {
          return;
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      throw new Error(`Authorization code did not become ready for ${operationId}.`);
    };
    const firstSwitch = host.harness.behavior.callRpc("switchAccount", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "login",
      threadId: "thread_1",
    });
    let firstSubmission: Promise<unknown> | undefined;
    let secondSwitch: Promise<unknown> | undefined;

    try {
      await waitForCode(DEFAULT_OPERATION_ID);
      const pendingSubmission = host.harness.behavior.callRpc("submitLoginCode", {
        code: "first-code",
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      });
      firstSubmission = pendingSubmission;
      await inputStarted;

      assert.deepEqual(
        await host.harness.behavior.callRpc("cancelSwitch", {
          operationId: DEFAULT_OPERATION_ID,
          threadId: "thread_1",
        }),
        { outcome: "cancelled-before-login" },
      );
      assert.deepEqual(await firstSwitch, { outcome: "cancelled" });

      secondSwitch = host.harness.behavior.callRpc("switchAccount", {
        operationId: STALE_OPERATION_ID,
        mode: "login",
        threadId: "thread_1",
      });
      await waitForCode(STALE_OPERATION_ID);

      if (lateOutcome === "resolve") {
        resolveFirstInput({
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal_1",
          status: "running",
        });
        assert.deepEqual(await pendingSubmission, { submitted: true });
      } else {
        const rejected = assert.rejects(pendingSubmission, /late input failure/);
        rejectFirstInput(new Error("late input failure"));
        await rejected;
      }

      const inspected = (await host.harness.behavior.callRpc("inspectSwitch", {
        threadId: "thread_1",
      })) as InspectedSwitch;
      assert.equal(inspected.status, "running");
      if (inspected.status !== "running") throw new Error("Expected active switch.");
      assert.equal(inspected.operationId, STALE_OPERATION_ID);
      assert.equal(inspected.codeReady, true);
    } finally {
      resolveFirstInput({
        exitCode: null,
        hostId: "host_1",
        id: "login_terminal_1",
        status: "running",
      });
      await firstSubmission?.catch(() => undefined);
      await host.harness.behavior
        .callRpc("cancelSwitch", {
          operationId: STALE_OPERATION_ID,
          threadId: "thread_1",
        })
        .catch(() => undefined);
      await secondSwitch?.catch(() => undefined);
      await firstSwitch.catch(() => undefined);
      await host.harness.lifecycle.dispose();
    }
  }
});

test("a remounted client attaches to the active switch instead of starting another", async () => {
  let helperCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    helperCreated = resolve;
  });
  let releaseOutput!: () => void;
  const outputGate = new Promise<void>((resolve) => {
    releaseOutput = resolve;
  });
  let creates = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 0,
          hostId: "host_1",
          id: "status_terminal",
          status: "exited" as const,
        }),
        create: async () => {
          creates += 1;
          helperCreated();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "status_terminal",
            status: "running" as const,
          };
        },
        output: async () => {
          await outputGate;
          return {
            chunks: [
              {
                dataBase64: Buffer.from(
                  "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
                ).toString("base64"),
                seq: 1,
              },
            ],
            nextSeq: 2,
            truncated: false,
          };
        },
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
        stop: async () => ({ ok: true as const }),
      },
    },
  });
  await plugin(host.bb);
  const first = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "current",
    threadId: "thread_1",
  });

  try {
    await created;
    const inspected = (await host.harness.behavior.callRpc("inspectSwitch", {
      threadId: "thread_1",
    })) as
      | { readonly status: "none" }
      | {
          readonly codeReady: boolean;
          readonly mode: "current" | "login";
          readonly operationId: string;
          readonly phase: "cancellable" | "cancelling" | "committed";
          readonly status: "running";
        };
    assert.equal(inspected.status, "running");
    if (inspected.status !== "running") throw new Error("Expected active switch.");
    assert.deepEqual(
      {
        codeReady: inspected.codeReady,
        mode: inspected.mode,
        phase: inspected.phase,
        status: inspected.status,
      },
      {
        codeReady: false,
        mode: "current",
        phase: "cancellable",
        status: "running",
      },
    );
    assert.match(inspected.operationId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(
      await host.harness.behavior.callRpc("cancelSwitch", {
        operationId: STALE_OPERATION_ID,
        threadId: "thread_1",
      }),
      { outcome: "not-running" },
    );
    assert.deepEqual(
      await host.harness.behavior.callRpc("attachSwitch", {
        operationId: "00000000-0000-4000-8000-000000000000",
        threadId: "thread_1",
      }),
      { outcome: "not-running" },
    );
    const attached = host.harness.behavior.callRpc("attachSwitch", {
      operationId: inspected.operationId,
      threadId: "thread_1",
    });
    releaseOutput();
    assert.deepEqual(await first, { outcome: "ready-next-message" });
    assert.deepEqual(await attached, { outcome: "ready-next-message" });
    assert.equal(creates, 1);
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 1);
    assert.deepEqual(
      await host.harness.behavior.callRpc("inspectSwitch", {
        threadId: "thread_1",
      }),
      { status: "none" },
    );
    assert.deepEqual(
      await host.harness.behavior.callRpc("attachSwitch", {
        operationId: inspected.operationId,
        threadId: "thread_1",
      }),
      { outcome: "not-running" },
    );
    assert.equal(creates, 1);
  } finally {
    releaseOutput();
    await first.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("a helper opened on another machine is closed before the runtime can be released", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 1,
          hostId: "host_2",
          id: "status_terminal",
          status: "exited" as const,
        }),
        create: async () => ({
          exitCode: null,
          hostId: "host_2",
          id: "status_terminal",
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);

  try {
    await assert.rejects(
      host.harness.behavior.callRpc("switchAccount", {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_1",
      }),
      /different machine/,
    );
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 0);
    assert.deepEqual(host.harness.inspection.sdk.callsTo("terminals.close"), [
      [{ mode: "force", terminalId: "status_terminal" }],
    ]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a mismatched helper reserves its actual machine until cleanup finishes", async () => {
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let closeStarted!: () => void;
  const closing = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  let creates = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeStarted();
          await closeReleased;
          return {
            exitCode: 1,
            hostId: "host_2",
            id: "status_terminal",
            status: "exited" as const,
          };
        },
        create: async () => {
          creates += 1;
          if (creates > 1) throw new Error("second helper launched");
          return {
            exitCode: null,
            hostId: "host_2",
            id: "status_terminal",
            status: "running" as const,
          };
        },
      },
      threads: {
        get: async ({ threadId }) => ({
          environment: { hostId: threadId === "thread_1" ? "host_1" : "host_2" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const mismatchedSwitch = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "current",
    threadId: "thread_1",
  });

  try {
    await closing;
    await assert.rejects(
      host.harness.behavior.callRpc("switchAccount", {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_2",
      }),
      /already open on this machine/,
    );
    assert.equal(creates, 1);
  } finally {
    releaseClose();
    await assert.rejects(mismatchedSwitch, /different machine/);
    await host.harness.lifecycle.dispose();
  }
});

test("overlapping mismatched helpers retain independent actual-host reservations", async () => {
  let releaseFirstClose!: () => void;
  const firstCloseReleased = new Promise<void>((resolve) => {
    releaseFirstClose = resolve;
  });
  let firstCloseStarted!: () => void;
  const firstClosing = new Promise<void>((resolve) => {
    firstCloseStarted = resolve;
  });
  let releaseSecondClose!: () => void;
  const secondCloseReleased = new Promise<void>((resolve) => {
    releaseSecondClose = resolve;
  });
  let secondCloseStarted!: () => void;
  const secondClosing = new Promise<void>((resolve) => {
    secondCloseStarted = resolve;
  });
  let creates = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) => {
          if (terminalId === "status_terminal_1") {
            firstCloseStarted();
            await firstCloseReleased;
          } else {
            secondCloseStarted();
            await secondCloseReleased;
          }
          return {
            exitCode: 1,
            hostId: "host_2",
            id: terminalId,
            status: "exited" as const,
          };
        },
        create: async () => {
          creates += 1;
          if (creates > 2) throw new Error("third helper launched");
          return {
            exitCode: null,
            hostId: "host_2",
            id: `status_terminal_${creates}`,
            status: "running" as const,
          };
        },
      },
      threads: {
        get: async ({ threadId }) => ({
          environment: {
            hostId:
              threadId === "thread_1"
                ? "host_1"
                : threadId === "thread_2"
                  ? "host_3"
                  : "host_2",
          },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const firstSwitch = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "current",
    threadId: "thread_1",
  });
  let secondSwitch: Promise<unknown> | undefined;

  try {
    await firstClosing;
    secondSwitch = host.harness.behavior.callRpc("switchAccount", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "current",
      threadId: "thread_2",
    });
    await secondClosing;

    releaseFirstClose();
    await assert.rejects(firstSwitch, /different machine/);
    await assert.rejects(
      host.harness.behavior.callRpc("switchAccount", {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_3",
      }),
      /already open on this machine/,
    );
    assert.equal(creates, 2);

    releaseSecondClose();
    await assert.rejects(secondSwitch, /different machine/);
    await assert.rejects(
      host.harness.behavior.callRpc("switchAccount", {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_3",
      }),
      /third helper launched/,
    );
    assert.equal(creates, 3);
  } finally {
    releaseFirstClose();
    releaseSecondClose();
    await firstSwitch.catch(() => undefined);
    await secondSwitch?.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("failed mismatch persistence still allows cleanup reconciliation", async () => {
  let closeAttempts = 0;
  let creates = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("terminal host disconnected");
          return {
            exitCode: 1,
            hostId: "host_2",
            id: "status_terminal",
            status: "exited" as const,
          };
        },
        create: async () => {
          creates += 1;
          return {
            exitCode: creates === 1 ? null : 1,
            hostId: "host_2",
            id: "status_terminal",
            status: creates === 1 ? ("running" as const) : ("exited" as const),
          };
        },
      },
      threads: {
        get: async ({ threadId }) => ({
          environment: { hostId: threadId === "thread_1" ? "host_1" : "host_2" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const originalSet = host.bb.storage.kv.set.bind(host.bb.storage.kv);
  let persistenceAttempts = 0;
  Object.defineProperty(host.bb.storage.kv, "set", {
    configurable: true,
    value: async (key: string, value: unknown) => {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) {
        throw new Error("cleanup state could not be stored");
      }
      await originalSet(key, value);
    },
  });

  try {
    await assert.rejects(
      host.harness.behavior.callRpc("switchAccount", {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_1",
      }),
      /cleanup state could not be stored/,
    );
    await assert.rejects(
      host.harness.behavior.callRpc("switchAccount", {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_2",
      }),
      /subscription login could not be verified/,
    );
    assert.equal(creates, 2);
    assert.equal(closeAttempts, 3);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("valid Claude auth can release the runtime when BB usage lookup is unavailable", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      system: {
        usageLimits: async () => {
          throw new Error("Claude usage is rate limited right now.");
        },
      },
      terminals: {
        close: async () => ({
          exitCode: 0,
          hostId: "host_1",
          id: "status_terminal",
          status: "exited" as const,
        }),
        create: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "status_terminal",
          status: "running" as const,
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
              ).toString("base64"),
              seq: 1,
            },
          ],
          nextSeq: 2,
          truncated: false,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
        stop: async () => ({ ok: true as const }),
      },
    },
  });
  await plugin(host.bb);

  try {
    assert.deepEqual(
      await host.harness.behavior.callRpc("switchAccount", {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_1",
      }),
      { outcome: "ready-next-message" },
    );
    assert.equal(host.harness.inspection.sdk.callsTo("system.usageLimits").length, 0);
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("two sessions on one machine can rebind sequentially", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 0,
          hostId: "host_1",
          id: "status_terminal",
          status: "exited" as const,
        }),
        create: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "status_terminal",
          status: "running" as const,
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
              ).toString("base64"),
              seq: 1,
            },
          ],
          nextSeq: 2,
          truncated: false,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
        stop: async () => ({ ok: true as const }),
      },
    },
  });
  await plugin(host.bb);

  try {
    for (const threadId of ["thread_1", "thread_2"]) {
      assert.deepEqual(
        await host.harness.behavior.callRpc("switchAccount", {
          operationId: DEFAULT_OPERATION_ID,
          mode: "current",
          threadId,
        }),
        { outcome: "ready-next-message" },
      );
    }
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 2);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("current-login cancellation settles before releasing the runtime", async () => {
  let authStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    authStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "status_terminal",
          status: "disconnected" as const,
        }),
        create: async () => {
          authStarted();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "status_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "status_terminal",
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const switching = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "current",
    threadId: "thread_1",
  });

  try {
    await started;
    const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    });

    assert.deepEqual(cancelled, { outcome: "cancelled-before-release" });
    assert.deepEqual(await switching, { outcome: "cancelled" });
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 0);
  } finally {
    await switching.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("cancellation after login success reports that safe completion is in progress", async () => {
  let terminalCreates = 0;
  let authStarted!: () => void;
  let releaseAuth!: () => void;
  const started = new Promise<void>((resolve) => {
    authStarted = resolve;
  });
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 0,
          hostId: "host_1",
          id: "status_terminal",
          status: "exited" as const,
        }),
        create: async () => {
          terminalCreates += 1;
          return terminalCreates === 1
            ? {
                exitCode: 0,
                hostId: "host_1",
                id: "login_terminal",
                status: "exited" as const,
              }
            : {
                exitCode: null,
                hostId: "host_1",
                id: "status_terminal",
                status: "running" as const,
              };
        },
        output: async () => {
          authStarted();
          await authGate;
          return {
            chunks: [
              {
                dataBase64: Buffer.from(
                  "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
                ).toString("base64"),
                seq: 1,
              },
            ],
            nextSeq: 2,
            truncated: false,
          };
        },
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
        stop: async () => ({ ok: true as const }),
      },
    },
  });
  await plugin(host.bb);
  const switching = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });

  try {
    await started;
    const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    });
    assert.deepEqual(cancelled, { outcome: "completing" });

    releaseAuth();
    assert.deepEqual(await switching, { outcome: "ready-next-message" });
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 1);
  } finally {
    releaseAuth();
    await switching.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("cancellation reports completing when atomic close observes login success", async () => {
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 0,
          hostId: "host_1",
          id: "login_terminal",
          status: "exited" as const,
        }),
        create: async () => {
          loginStarted();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal",
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const switching = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });

  try {
    await started;
    const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    });

    assert.deepEqual(cancelled, { outcome: "completing" });
    assert.deepEqual(await switching, { outcome: "login-changed-not-rebound" });
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 0);
  } finally {
    await switching.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("plugin disposal cancels and closes an active login helper", async () => {
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => ({
          exitCode: 1,
          hostId: "host_1",
          id: "login_terminal",
          status: "exited" as const,
        }),
        create: async () => {
          loginStarted();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal",
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const switching = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await started;

  await host.harness.lifecycle.dispose();

  assert.deepEqual(await switching, { outcome: "cancelled" });
  assert.deepEqual(host.harness.inspection.sdk.callsTo("terminals.close"), [
    [{ mode: "force", terminalId: "login_terminal" }],
  ]);
});

test("plugin disposal retries terminal cleanup that failed during cancellation", async () => {
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  let closeAttempts = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("session machine disconnected");
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "disconnected" as const,
          };
        },
        create: async () => {
          loginStarted();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal",
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const switching = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await started;

  const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_1",
  });
  assert.deepEqual(cancelled, { outcome: "completing" });
  assert.deepEqual(await switching, { outcome: "login-changed-not-rebound" });
  assert.equal(closeAttempts, 1);

  await host.harness.lifecycle.dispose();

  assert.equal(closeAttempts, 2);
  assert.deepEqual(host.harness.inspection.sdk.callsTo("terminals.close"), [
    [{ mode: "force", terminalId: "login_terminal" }],
    [{ mode: "force", terminalId: "login_terminal" }],
  ]);
});

test("plugin disposal retries cleanup persistence after a completed login", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          throw new Error("session machine disconnected");
        },
        create: async () => ({
          exitCode: 0,
          hostId: "host_1",
          id: "login_terminal",
          status: "exited" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const originalSet = host.bb.storage.kv.set.bind(host.bb.storage.kv);
  let persistenceAttempts = 0;
  Object.defineProperty(host.bb.storage.kv, "set", {
    configurable: true,
    value: async (key: string, value: unknown) => {
      persistenceAttempts += 1;
      if (persistenceAttempts === 1) {
        throw new Error("cleanup state could not be stored");
      }
      await originalSet(key, value);
    },
  });

  const result = await host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });

  assert.deepEqual(result, { outcome: "login-changed-not-rebound" });
  assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 0);
  assert.equal(persistenceAttempts, 1);

  await host.harness.lifecycle.dispose();

  assert.equal(persistenceAttempts, 2);
});

test("a later switch reconciles failed login cleanup before it can start", async () => {
  let createCount = 0;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const first = new Promise<void>((resolve) => {
    firstStarted = resolve;
  });
  const second = new Promise<void>((resolve) => {
    secondStarted = resolve;
  });
  let closeAttempts = 0;
  let closeAttemptsAtSecondStart = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("session machine disconnected");
          return {
            exitCode: 1,
            hostId: "host_1",
            id: `login_terminal_${createCount}`,
            status: "exited" as const,
          };
        },
        create: async () => {
          createCount += 1;
          if (createCount === 1) firstStarted();
          else {
            closeAttemptsAtSecondStart = closeAttempts;
            secondStarted();
          }
          return {
            exitCode: null,
            hostId: "host_1",
            id: `login_terminal_${createCount}`,
            status: "running" as const,
          };
        },
        get: async ({ terminalId }) => ({
          exitCode: null,
          hostId: "host_1",
          id: terminalId,
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);

  const firstSwitch = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await first;
  assert.deepEqual(
    await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    }),
    { outcome: "completing" },
  );
  assert.deepEqual(await firstSwitch, { outcome: "login-changed-not-rebound" });
  assert.equal(closeAttempts, 1);

  const secondSwitch = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_2",
  });
  await second;
  assert.equal(createCount, 2);

  await host.harness.behavior.callRpc("cancelSwitch", {
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_2",
  });
  assert.deepEqual(await secondSwitch, { outcome: "cancelled" });
  await host.harness.lifecycle.dispose();
  assert.equal(closeAttemptsAtSecondStart, 2);
});

test("a later switch stays blocked while failed login cleanup is still unconfirmed", async () => {
  let createCount = 0;
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          throw new Error("session machine disconnected");
        },
        create: async () => {
          createCount += 1;
          loginStarted();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal",
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);

  const firstSwitch = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await started;
  assert.deepEqual(
    await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    }),
    { outcome: "completing" },
  );
  assert.deepEqual(await firstSwitch, { outcome: "login-changed-not-rebound" });
  await assert.rejects(
    host.harness.behavior.callRpc("switchAccount", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "login",
      threadId: "thread_2",
    }),
    /previous Claude login helper could not be stopped/,
  );
  assert.equal(createCount, 1);
  await host.harness.lifecycle.dispose();
});

test("failed cleanup survives plugin reload and blocks the same machine", async () => {
  let createCount = 0;
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          throw new Error("session machine disconnected");
        },
        create: async () => {
          createCount += 1;
          if (createCount === 1) loginStarted();
          return {
            exitCode: createCount === 1 ? null : 1,
            hostId: "host_1",
            id: `login_terminal_${createCount}`,
            status: createCount === 1 ? ("running" as const) : ("exited" as const),
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal_1",
          status: "running" as const,
        }),
      },
      threads: {
        get: async () => ({
          environment: { hostId: "host_1" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const firstSwitch = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await started;
  assert.deepEqual(
    await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    }),
    { outcome: "completing" },
  );
  assert.deepEqual(await firstSwitch, { outcome: "login-changed-not-rebound" });

  const reloaded = await host.harness.lifecycle.reload(plugin);
  await assert.rejects(
    reloaded.harness.behavior.callRpc("switchAccount", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "login",
      threadId: "thread_2",
    }),
    /previous Claude login helper could not be stopped/,
  );
  assert.equal(createCount, 1);
  await reloaded.harness.lifecycle.dispose();
});

test("failed cleanup follows the helper terminal's actual machine", async () => {
  let createCount = 0;
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          throw new Error("terminal host disconnected");
        },
        create: async () => {
          createCount += 1;
          if (createCount === 1) loginStarted();
          return {
            exitCode: createCount === 1 ? null : 1,
            hostId: "host_2",
            id: `login_terminal_${createCount}`,
            status: createCount === 1 ? ("running" as const) : ("exited" as const),
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_2",
          id: "login_terminal_1",
          status: "running" as const,
        }),
      },
      threads: {
        get: async ({ threadId }) => ({
          environment: { hostId: threadId === "thread_1" ? "host_1" : "host_2" },
          providerId: "claude-code",
          status: "idle" as const,
        }),
      },
    },
  });
  await plugin(host.bb);
  const firstSwitch = host.harness.behavior.callRpc("switchAccount", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await started;
  await assert.rejects(firstSwitch, /different machine/);

  await assert.rejects(
    host.harness.behavior.callRpc("switchAccount", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "login",
      threadId: "thread_2",
    }),
    /previous Claude login helper could not be stopped/,
  );
  assert.equal(createCount, 1);
  await host.harness.lifecycle.dispose();
});
