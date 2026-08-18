import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../dist/server.js";

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
        get: async () => ({ providerId: "claude-code" }),
        rateLimitRecovery: async () => recovery,
      },
    },
  });
  await plugin(host.bb);
  let switching: Promise<unknown> | undefined;

  try {
    switching = host.harness.behavior.callRpc("switchAccount", {
      email: "second+claude@example.com",
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
          dataBase64: Buffer.from("test-authorization-code\n").toString(
            "base64",
          ),
          terminalId: "terminal_1",
        },
      ],
    ]);

    const result = await host.harness.behavior.callRpc("cancelSwitch", {
      threadId: "thread_1",
    });

    assert.deepEqual(result, { cancelled: true });
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
