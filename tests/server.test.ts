import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
// @ts-expect-error The build artifact intentionally has no declaration file.
import plugin from "../dist/server.js";

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
    assert.equal(host.harness.inspection.sdk.callsTo("system.usageLimits").length, 0);
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 1);
  } finally {
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
    mode: "current",
    threadId: "thread_1",
  });

  try {
    await closing;
    await assert.rejects(
      host.harness.behavior.callRpc("switchAccount", {
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
    mode: "current",
    threadId: "thread_1",
  });

  try {
    await started;
    const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
      threadId: "thread_1",
    });

    assert.deepEqual(cancelled, { outcome: "cancelled-before-release" });
    await assert.rejects(switching, /subscription login could not be verified/);
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
    mode: "login",
    threadId: "thread_1",
  });

  try {
    await started;
    const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
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
    mode: "login",
    threadId: "thread_1",
  });

  try {
    await started;
    const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
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
          exitCode: null,
          hostId: "host_1",
          id: "login_terminal",
          status: "disconnected" as const,
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
    mode: "login",
    threadId: "thread_1",
  });
  await started;

  await host.harness.lifecycle.dispose();

  await assert.rejects(switching, /cancelled/);
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
    mode: "login",
    threadId: "thread_1",
  });
  await started;

  const cancelled = await host.harness.behavior.callRpc("cancelSwitch", {
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
            exitCode: null,
            hostId: "host_1",
            id: `login_terminal_${createCount}`,
            status: "disconnected" as const,
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
    mode: "login",
    threadId: "thread_1",
  });
  await first;
  assert.deepEqual(
    await host.harness.behavior.callRpc("cancelSwitch", {
      threadId: "thread_1",
    }),
    { outcome: "completing" },
  );
  assert.deepEqual(await firstSwitch, { outcome: "login-changed-not-rebound" });
  assert.equal(closeAttempts, 1);

  const secondSwitch = host.harness.behavior.callRpc("switchAccount", {
    mode: "login",
    threadId: "thread_2",
  });
  await second;
  assert.equal(createCount, 2);

  await host.harness.behavior.callRpc("cancelSwitch", { threadId: "thread_2" });
  await assert.rejects(secondSwitch, /cancelled/);
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
    mode: "login",
    threadId: "thread_1",
  });
  await started;
  assert.deepEqual(
    await host.harness.behavior.callRpc("cancelSwitch", {
      threadId: "thread_1",
    }),
    { outcome: "completing" },
  );
  assert.deepEqual(await firstSwitch, { outcome: "login-changed-not-rebound" });
  await assert.rejects(
    host.harness.behavior.callRpc("submitLoginCode", {
      code: "stale-code",
      threadId: "thread_1",
    }),
    /No Claude login is waiting/,
  );

  await assert.rejects(
    host.harness.behavior.callRpc("switchAccount", {
      mode: "login",
      threadId: "thread_2",
    }),
    /previous Claude login helper could not be stopped/,
  );
  assert.equal(createCount, 1);
  await host.harness.lifecycle.dispose();
});

test("cancellation stops accepting authorization codes before terminal cleanup finishes", async () => {
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  let closeStarted!: () => void;
  const closing = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  let releaseClose!: () => void;
  const closeReleased = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  let inputCount = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeStarted();
          await closeReleased;
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
        input: async () => {
          inputCount += 1;
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
    mode: "login",
    threadId: "thread_1",
  });
  await started;

  const cancelling = host.harness.behavior.callRpc("cancelSwitch", {
    threadId: "thread_1",
  });
  await closing;
  await assert.rejects(
    host.harness.behavior.callRpc("submitLoginCode", {
      code: "too-late",
      threadId: "thread_1",
    }),
    /No Claude login is waiting/,
  );
  assert.equal(inputCount, 0);

  releaseClose();
  assert.deepEqual(await cancelling, { outcome: "cancelled-before-login" });
  await assert.rejects(switching, /cancelled/);
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
    mode: "login",
    threadId: "thread_1",
  });
  await started;
  assert.deepEqual(
    await host.harness.behavior.callRpc("cancelSwitch", {
      threadId: "thread_1",
    }),
    { outcome: "completing" },
  );
  assert.deepEqual(await firstSwitch, { outcome: "login-changed-not-rebound" });

  const reloaded = await host.harness.lifecycle.reload(plugin);
  await assert.rejects(
    reloaded.harness.behavior.callRpc("switchAccount", {
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
    mode: "login",
    threadId: "thread_1",
  });
  await started;
  await assert.rejects(firstSwitch, /different machine/);

  await assert.rejects(
    host.harness.behavior.callRpc("switchAccount", {
      mode: "login",
      threadId: "thread_2",
    }),
    /previous Claude login helper could not be stopped/,
  );
  assert.equal(createCount, 1);
  await host.harness.lifecycle.dispose();
});

test("manual code submission and cancellation reach the active login", async () => {
  let terminalStatus: "running" | "disconnected" = "running";
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          terminalStatus = "disconnected";
          return {
            exitCode: null,
            hostId: "host_1",
            id: "terminal_1",
            status: terminalStatus,
          };
        },
        create: async () => {
          loginStarted();
          return {
            exitCode: null,
            hostId: "host_1",
            id: "terminal_1",
            status: terminalStatus,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "terminal_1",
          status: terminalStatus,
        }),
        input: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "terminal_1",
          status: terminalStatus,
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
  let switching: Promise<unknown> | undefined;

  try {
    switching = host.harness.behavior.callRpc("switchAccount", {
      mode: "login",
      threadId: "thread_1",
    });
    await started;

    const submitted = await host.harness.behavior.callRpc("submitLoginCode", {
      code: "test-authorization-code",
      threadId: "thread_1",
    });
    assert.deepEqual(submitted, { submitted: true });
    assert.deepEqual(host.harness.inspection.sdk.callsTo("terminals.input"), [
      [
        {
          dataBase64: Buffer.from("test-authorization-code\n").toString("base64"),
          terminalId: "terminal_1",
        },
      ],
    ]);

    const result = await host.harness.behavior.callRpc("cancelSwitch", {
      threadId: "thread_1",
    });

    assert.deepEqual(result, { outcome: "cancelled-before-login" });
    await assert.rejects(switching, /cancelled/);
    assert.deepEqual(host.harness.inspection.sdk.callsTo("terminals.close"), [
      [
        {
          mode: "force",
          terminalId: "terminal_1",
        },
      ],
    ]);
  } finally {
    terminalStatus = "disconnected";
    await switching?.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});
