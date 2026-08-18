import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../dist/server.js";

test("the current-login RPC verifies the exact host and releases an idle runtime", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      system: {
        usageLimits: async () => ({
          claudeCode: {
            accountEmail: null,
            planLabel: "Max",
            status: "ok",
            windows: [],
          },
          codex: { status: "unauthenticated" },
          cursor: { status: "unauthenticated" },
        }),
      },
      terminals: {
        close: async () => ({
          exitCode: 0,
          id: "status_terminal",
          status: "exited" as const,
        }),
        create: async () => ({
          exitCode: null,
          id: "status_terminal",
          status: "running" as const,
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\n",
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
    assert.deepEqual(host.harness.inspection.sdk.callsTo("system.usageLimits"), [
      [{ hostId: "host_1" }],
    ]);
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("two sessions on one machine can rebind sequentially", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      system: {
        usageLimits: async () => ({
          claudeCode: {
            accountEmail: null,
            planLabel: "Max",
            status: "ok",
            windows: [],
          },
          codex: { status: "unauthenticated" },
          cursor: { status: "unauthenticated" },
        }),
      },
      terminals: {
        close: async () => undefined,
        create: async () => ({
          exitCode: null,
          id: "status_terminal",
          status: "running" as const,
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\n",
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
      system: {
        usageLimits: async () => ({
          claudeCode: {
            accountEmail: null,
            planLabel: "Max",
            status: "ok",
            windows: [],
          },
          codex: { status: "unauthenticated" },
          cursor: { status: "unauthenticated" },
        }),
      },
      terminals: {
        close: async () => undefined,
        create: async () => {
          authStarted();
          return {
            exitCode: null,
            id: "status_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
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
  let usageStarted!: () => void;
  let releaseUsage!: () => void;
  const started = new Promise<void>((resolve) => {
    usageStarted = resolve;
  });
  const usageGate = new Promise<void>((resolve) => {
    releaseUsage = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      system: {
        usageLimits: async () => {
          usageStarted();
          await usageGate;
          return {
            claudeCode: {
              accountEmail: null,
              planLabel: "Max",
              status: "ok" as const,
              windows: [],
            },
            codex: { status: "unauthenticated" as const },
            cursor: { status: "unauthenticated" as const },
          };
        },
      },
      terminals: {
        close: async () => undefined,
        create: async () => {
          terminalCreates += 1;
          return terminalCreates === 1
            ? {
                exitCode: 0,
                id: "login_terminal",
                status: "exited" as const,
              }
            : {
                exitCode: null,
                id: "status_terminal",
                status: "running" as const,
              };
        },
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\n",
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

    releaseUsage();
    assert.deepEqual(await switching, { outcome: "ready-next-message" });
    assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 1);
  } finally {
    releaseUsage();
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
        close: async () => undefined,
        create: async () => {
          loginStarted();
          return {
            exitCode: null,
            id: "login_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
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

test("manual code submission and cancellation reach the active login", async () => {
  let terminalStatus: "running" | "disconnected" = "running";
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const recovery = {
    candidate: {
      failedRequestId: "req_1",
      rateLimits: { providerId: "claude-code" },
    },
    hostId: "host_1",
    reason: "manual-only",
  };
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          terminalStatus = "disconnected";
        },
        create: async () => {
          loginStarted();
          return {
            exitCode: null,
            id: "terminal_1",
            status: terminalStatus,
          };
        },
        get: async () => ({
          exitCode: null,
          id: "terminal_1",
          status: terminalStatus,
        }),
        input: async () => ({
          exitCode: null,
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
        rateLimitRecovery: async () => recovery,
      },
    },
  });
  await plugin(host.bb);
  let switching: Promise<unknown> | undefined;

  try {
    switching = host.harness.behavior.callRpc("switchAccount", {
      email: "second+claude@example.com",
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
