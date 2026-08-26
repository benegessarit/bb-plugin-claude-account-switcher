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
      readonly canReturnToAuthorization: boolean;
      readonly codeReady: boolean;
      readonly mode: "current" | "login";
      readonly operationId: string;
      readonly phase: "cancellable" | "cancelling" | "committed";
      readonly status: "running";
    };

const providerCliStatus = {
  "claude-code": {
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
  "acp-cursor": {
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

async function beginAndAttach(
  host: ReturnType<typeof createFakePluginHost>,
  input: {
    readonly mode: "current" | "login";
    readonly operationId: string;
    readonly threadId: string;
  },
) {
  const admission = (await host.harness.behavior.callRpc("beginSwitch", input)) as
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
  if (admission.outcome === "host-busy") {
    throw new Error("A Claude account switch is already open on this machine.");
  }
  if (admission.outcome === "thread-not-ready") {
    throw new Error(
      admission.reason === "thread-not-idle"
        ? "Wait for this session to become idle before switching its Claude login."
        : "This session is not ready to rebind.",
    );
  }
  if (admission.outcome === "cancelled") return { outcome: "cancelled" as const };
  const operationId =
    admission.outcome === "thread-busy" ? admission.operationId : input.operationId;
  return host.harness.behavior.callRpc("attachSwitch", {
    operationId,
    threadId: input.threadId,
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
    const admission = await host.harness.behavior.callRpc("beginSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "current",
      threadId: "thread_1",
    });
    assert.deepEqual(admission, { outcome: "accepted" });
    const result = await host.harness.behavior.callRpc("attachSwitch", {
      operationId: DEFAULT_OPERATION_ID,
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

test("thread admission is claimed before the first thread read settles", async () => {
  let releaseThread!: () => void;
  let threadReadStarted!: () => void;
  const threadGate = new Promise<void>((resolve) => {
    releaseThread = resolve;
  });
  const started = new Promise<void>((resolve) => {
    threadReadStarted = resolve;
  });
  let threadReads = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      threads: {
        get: async () => {
          threadReads += 1;
          threadReadStarted();
          await threadGate;
          return {
            environment: { hostId: "host_1" },
            providerId: "claude-code",
            status: "idle" as const,
          };
        },
      },
    },
  });
  await plugin(host.bb);
  const firstAdmission = host.harness.behavior.callRpc("beginSwitch", {
    operationId: DEFAULT_OPERATION_ID,
    mode: "current",
    threadId: "thread_1",
  });
  await started;

  assert.deepEqual(
    await host.harness.behavior.callRpc("beginSwitch", {
      operationId: STALE_OPERATION_ID,
      mode: "login",
      threadId: "thread_1",
    }),
    {
      mode: "current",
      operationId: DEFAULT_OPERATION_ID,
      outcome: "thread-busy",
    },
  );
  assert.equal(threadReads, 1);

  const cancelling = host.harness.behavior.callRpc("cancelSwitch", {
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_1",
  });
  releaseThread();
  assert.deepEqual(await firstAdmission, { outcome: "cancelled" });
  assert.deepEqual(await cancelling, { outcome: "cancelled-before-release" });
  await host.harness.lifecycle.dispose();
});

test("a rejected admission releases the exact thread claim", async () => {
  let status: "active" | "idle" = "active";
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
          status,
        }),
        stop: async () => ({ ok: true as const }),
      },
    },
  });
  await plugin(host.bb);

  assert.deepEqual(
    await host.harness.behavior.callRpc("beginSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      mode: "current",
      threadId: "thread_1",
    }),
    { outcome: "thread-not-ready", reason: "thread-not-idle" },
  );
  status = "idle";
  assert.deepEqual(
    await beginAndAttach(host, {
      operationId: STALE_OPERATION_ID,
      mode: "current",
      threadId: "thread_1",
    }),
    { outcome: "ready-next-message" },
  );
  await host.harness.lifecycle.dispose();
});

test("a second thread on the same machine receives a typed host-busy admission", async () => {
  let verificationStarted!: () => void;
  let releaseVerification!: () => void;
  const started = new Promise<void>((resolve) => {
    verificationStarted = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    releaseVerification = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) => ({
          exitCode: 0,
          hostId: "host_1",
          id: terminalId,
          status: "exited" as const,
        }),
        create: async () => ({
          exitCode: null,
          hostId: "host_1",
          id: "status_terminal",
          status: "running" as const,
        }),
        output: async () => {
          verificationStarted();
          await gate;
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
      },
    },
  });
  await plugin(host.bb);

  const firstAdmission = await host.harness.behavior.callRpc("beginSwitch", {
    mode: "current",
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_1",
  });
  assert.deepEqual(firstAdmission, { outcome: "accepted" });
  await started;

  assert.deepEqual(
    await host.harness.behavior.callRpc("beginSwitch", {
      mode: "current",
      operationId: STALE_OPERATION_ID,
      threadId: "thread_2",
    }),
    { outcome: "host-busy" },
  );

  const cancelled = host.harness.behavior.callRpc("cancelSwitch", {
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_1",
  });
  releaseVerification();
  assert.deepEqual(await cancelled, { outcome: "cancelled-before-release" });
  await host.harness.lifecycle.dispose();
});

test("invalid durable terminal ownership fails plugin startup closed", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
  });
  await host.bb.storage.kv.set("unclean-login-terminals-v1", [
    { hostId: "host_1", terminalId: "" },
  ]);

  await assert.rejects(plugin(host.bb), /cleanup state is invalid/);
});

test("duplicate durable terminal ownership fails plugin startup closed", async () => {
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
  });
  await host.bb.storage.kv.set("unclean-login-terminals-v1", [
    { hostId: "host_1", terminalId: "terminal_1" },
    { hostId: "host_2", terminalId: "terminal_1" },
  ]);

  await assert.rejects(plugin(host.bb), /cleanup state is invalid/);
});

test("a helper is durably adopted before its terminal can be observed", async () => {
  const events: string[] = [];
  let outputStarted!: () => void;
  let releaseOutput!: () => void;
  const started = new Promise<void>((resolve) => {
    outputStarted = resolve;
  });
  const outputGate = new Promise<void>((resolve) => {
    releaseOutput = resolve;
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
          events.push("create");
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
        output: async () => {
          events.push("output");
          outputStarted();
          await outputGate;
          return { chunks: [], nextSeq: 1, truncated: false };
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
  const originalSet = host.bb.storage.kv.set.bind(host.bb.storage.kv);
  Object.defineProperty(host.bb.storage.kv, "set", {
    configurable: true,
    value: async (key: string, value: unknown) => {
      events.push("persist");
      await originalSet(key, value);
    },
  });

  const switching = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await started;

  assert.deepEqual(events.slice(0, 3), ["create", "persist", "output"]);
  releaseOutput();
  await host.harness.behavior.callRpc("cancelSwitch", {
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_1",
  });
  await switching.catch(() => undefined);
  await host.harness.lifecycle.dispose();
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
                dataBase64: Buffer.from(
                  "BB_CLAUDE_LOGIN_AUTHORIZATION_READY:/private/tmp/bb-claude-login.A1b2C3/open-chrome-incognito\nBB_CLAUDE_LOGIN_INPUT_READY\n",
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
      },
    },
  });
  await plugin(host.bb);
  const switching = beginAndAttach(host, {
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
      host.harness.behavior.callRpc("reopenAuthorization", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      }),
      /not waiting to return to authorization/,
    );
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

test("authorization return reopens the pending URL on the same host and operation", async () => {
  const launcherPath = "/private/tmp/bb-claude-login.A1b2C3/open-chrome-incognito";
  let loginCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    loginCreated = resolve;
  });
  let terminalCreates = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) => ({
          exitCode: terminalId === "reopen_terminal" ? 0 : 1,
          hostId: "host_1",
          id: terminalId,
          status: "exited" as const,
        }),
        create: async () => {
          terminalCreates += 1;
          if (terminalCreates === 1) loginCreated();
          return {
            exitCode: null,
            hostId: "host_1",
            id: terminalCreates === 1 ? "login_terminal" : "reopen_terminal",
            status: "running" as const,
          };
        },
        get: async ({ terminalId }) => ({
          exitCode: terminalId === "reopen_terminal" ? 0 : null,
          hostId: "host_1",
          id: terminalId,
          status:
            terminalId === "reopen_terminal"
              ? ("exited" as const)
              : ("running" as const),
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                `BB_CLAUDE_LOGIN_AUTHORIZATION_READY:${launcherPath}\nBB_CLAUDE_LOGIN_INPUT_READY\n`,
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
      },
    },
  });
  await plugin(host.bb);
  const switching = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });

  try {
    await created;
    await new Promise((resolve) => setImmediate(resolve));
    const inspected = (await host.harness.behavior.callRpc("inspectSwitch", {
      threadId: "thread_1",
    })) as InspectedSwitch;
    assert.equal(inspected.status, "running");
    if (inspected.status !== "running") throw new Error("Expected active switch.");
    assert.equal(inspected.canReturnToAuthorization, true);
    assert.equal(inspected.operationId, DEFAULT_OPERATION_ID);

    assert.deepEqual(
      await host.harness.behavior.callRpc("reopenAuthorization", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      }),
      { opened: true },
    );

    const creates = host.harness.inspection.sdk.callsTo("terminals.create");
    assert.equal(creates.length, 2);
    const reopen = creates[1]![0] as {
      readonly scope?: { readonly hostId?: string };
      readonly start?: { readonly command?: string };
    };
    assert.equal(reopen.scope?.hostId, "host_1");
    assert.match(reopen.start?.command ?? "", /--bb-reopen-authorization/);
    assert.match(reopen.start?.command ?? "", /open-chrome-incognito/);
    assert.doesNotMatch(reopen.start?.command ?? "", /https:\/\/|auth login/);

    const after = (await host.harness.behavior.callRpc("inspectSwitch", {
      threadId: "thread_1",
    })) as InspectedSwitch;
    assert.equal(after.status, "running");
    if (after.status !== "running") throw new Error("Expected active switch.");
    assert.equal(after.operationId, DEFAULT_OPERATION_ID);
    assert.equal(after.canReturnToAuthorization, true);
  } finally {
    await host.harness.behavior.callRpc("cancelSwitch", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    });
    await switching.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("authorization return settles before runtime release and keeps the host reservation", async () => {
  const launcherPath = "/private/tmp/bb-claude-login.A1b2C3/open-chrome-incognito";
  let loginCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    loginCreated = resolve;
  });
  let reopenCreateStarted!: () => void;
  const reopenStarted = new Promise<void>((resolve) => {
    reopenCreateStarted = resolve;
  });
  let resolveReopenCreate!: (terminal: {
    exitCode: null;
    hostId: string;
    id: string;
    status: "running";
  }) => void;
  const reopenCreate = new Promise<{
    exitCode: null;
    hostId: string;
    id: string;
    status: "running";
  }>((resolve) => {
    resolveReopenCreate = resolve;
  });
  let threadStopped!: () => void;
  const stopped = new Promise<void>((resolve) => {
    threadStopped = resolve;
  });
  let threadWasStopped = false;
  let authStatusCreated!: () => void;
  const statusCreated = new Promise<void>((resolve) => {
    authStatusCreated = resolve;
  });
  let loginMayExit = false;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) => ({
          exitCode: 0,
          hostId: "host_1",
          id: terminalId,
          status: "exited" as const,
        }),
        create: async ({ title }) => {
          if (title === "Sign in to Claude") {
            loginCreated();
            return {
              exitCode: null,
              hostId: "host_1",
              id: "login_terminal",
              status: "running" as const,
            };
          }
          if (title === "Return to Claude authorization") {
            reopenCreateStarted();
            return reopenCreate;
          }
          authStatusCreated();
          return {
            exitCode: null,
            hostId: "host_1",
            id: `status_terminal_${title}`,
            status: "running" as const,
          };
        },
        get: async ({ terminalId }) => ({
          exitCode: terminalId === "login_terminal" ? (loginMayExit ? 0 : null) : 0,
          hostId: "host_1",
          id: terminalId,
          status:
            terminalId === "login_terminal" && !loginMayExit
              ? ("running" as const)
              : ("exited" as const),
        }),
        output: async ({ terminalId }) => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                terminalId === "login_terminal"
                  ? `BB_CLAUDE_LOGIN_AUTHORIZATION_READY:${launcherPath}\nBB_CLAUDE_LOGIN_INPUT_READY\n`
                  : "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
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
        stop: async () => {
          threadWasStopped = true;
          threadStopped();
          return { ok: true as const };
        },
      },
    },
  });
  await plugin(host.bb);
  const switching = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  let switchSettled = false;
  void switching.then(
    () => {
      switchSettled = true;
    },
    () => {
      switchSettled = true;
    },
  );
  let reopening: Promise<unknown> | undefined;

  try {
    await created;
    await new Promise((resolve) => setImmediate(resolve));
    reopening = host.harness.behavior.callRpc("reopenAuthorization", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    });
    await reopenStarted;
    loginMayExit = true;
    await statusCreated;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(threadWasStopped, false);

    const secondAdmission = await host.harness.behavior.callRpc("beginSwitch", {
      mode: "current",
      operationId: STALE_OPERATION_ID,
      threadId: "thread_2",
    });
    assert.deepEqual(
      { secondAdmission, switchSettled },
      {
        secondAdmission: { outcome: "host-busy" },
        switchSettled: false,
      },
    );

    resolveReopenCreate({
      exitCode: null,
      hostId: "host_1",
      id: "reopen_terminal",
      status: "running",
    });
    assert.deepEqual(await reopening, { opened: true });
    await stopped;
    assert.deepEqual(await switching, { outcome: "ready-next-message" });
    assert.deepEqual(
      await beginAndAttach(host, {
        mode: "current",
        operationId: STALE_OPERATION_ID,
        threadId: "thread_2",
      }),
      { outcome: "ready-next-message" },
    );
  } finally {
    resolveReopenCreate({
      exitCode: null,
      hostId: "host_1",
      id: "reopen_terminal",
      status: "running",
    });
    await reopening?.catch(() => undefined);
    await host.harness.behavior
      .callRpc("cancelSwitch", {
        operationId: STALE_OPERATION_ID,
        threadId: "thread_2",
      })
      .catch(() => undefined);
    await host.harness.behavior
      .callRpc("cancelSwitch", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      })
      .catch(() => undefined);
    await switching.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("cancellation waits for an already-started authorization return helper", async () => {
  const launcherPath = "/private/tmp/bb-claude-login.A1b2C3/open-chrome-incognito";
  let loginCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    loginCreated = resolve;
  });
  let reopenCreateStarted!: () => void;
  const reopenStarted = new Promise<void>((resolve) => {
    reopenCreateStarted = resolve;
  });
  let resolveReopenCreate!: (terminal: {
    exitCode: null;
    hostId: string;
    id: string;
    status: "running";
  }) => void;
  const reopenCreate = new Promise<{
    exitCode: null;
    hostId: string;
    id: string;
    status: "running";
  }>((resolve) => {
    resolveReopenCreate = resolve;
  });
  let terminalCreates = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) => ({
          exitCode: terminalId === "reopen_terminal" ? 0 : 1,
          hostId: "host_1",
          id: terminalId,
          status: "exited" as const,
        }),
        create: async () => {
          terminalCreates += 1;
          if (terminalCreates === 1) {
            loginCreated();
            return {
              exitCode: null,
              hostId: "host_1",
              id: "login_terminal",
              status: "running" as const,
            };
          }
          reopenCreateStarted();
          return reopenCreate;
        },
        get: async ({ terminalId }) => ({
          exitCode: terminalId === "reopen_terminal" ? 0 : null,
          hostId: "host_1",
          id: terminalId,
          status:
            terminalId === "reopen_terminal"
              ? ("exited" as const)
              : ("running" as const),
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                `BB_CLAUDE_LOGIN_AUTHORIZATION_READY:${launcherPath}\nBB_CLAUDE_LOGIN_INPUT_READY\n`,
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
      },
    },
  });
  await plugin(host.bb);
  const switching = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });

  try {
    await created;
    await new Promise((resolve) => setImmediate(resolve));
    const reopening = host.harness.behavior.callRpc("reopenAuthorization", {
      operationId: DEFAULT_OPERATION_ID,
      threadId: "thread_1",
    });
    await reopenStarted;
    const whileReopening = (await host.harness.behavior.callRpc("inspectSwitch", {
      threadId: "thread_1",
    })) as InspectedSwitch;
    assert.equal(whileReopening.status, "running");
    if (whileReopening.status !== "running") {
      throw new Error("Expected active switch.");
    }
    assert.equal(whileReopening.codeReady, false);
    await assert.rejects(
      host.harness.behavior.callRpc("submitLoginCode", {
        code: "one-time-code",
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      }),
      /not waiting for an authorization code/,
    );

    let cancellationSettled = false;
    const cancellation = host.harness.behavior
      .callRpc("cancelSwitch", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      })
      .then((result) => {
        cancellationSettled = true;
        return result;
      });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancellationSettled, false);

    resolveReopenCreate({
      exitCode: null,
      hostId: "host_1",
      id: "reopen_terminal",
      status: "running",
    });
    await assert.rejects(reopening, /cancelled/);
    assert.deepEqual(await cancellation, { outcome: "cancelled-before-login" });
    await switching;
  } finally {
    resolveReopenCreate({
      exitCode: null,
      hostId: "host_1",
      id: "reopen_terminal",
      status: "running",
    });
    await host.harness.lifecycle.dispose();
  }
});

test("authorization return creates no second helper until uncertain cleanup is reconciled", async () => {
  const launcherPath = "/private/tmp/bb-claude-login.A1b2C3/open-chrome-incognito";
  let loginCreated!: () => void;
  const created = new Promise<void>((resolve) => {
    loginCreated = resolve;
  });
  let terminalCreates = 0;
  let firstReopenCanExit = false;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) => ({
          exitCode:
            terminalId === "login_terminal"
              ? 1
              : terminalId === "reopen_terminal_1" && !firstReopenCanExit
                ? null
                : 0,
          hostId: "host_1",
          id: terminalId,
          status:
            terminalId === "reopen_terminal_1" && !firstReopenCanExit
              ? ("disconnected" as const)
              : ("exited" as const),
        }),
        create: async () => {
          terminalCreates += 1;
          if (terminalCreates === 1) loginCreated();
          return {
            exitCode: null,
            hostId: "host_1",
            id:
              terminalCreates === 1
                ? "login_terminal"
                : `reopen_terminal_${terminalCreates - 1}`,
            status: "running" as const,
          };
        },
        get: async ({ terminalId }) => ({
          exitCode: terminalId === "reopen_terminal_2" ? 0 : null,
          hostId: "host_1",
          id: terminalId,
          status:
            terminalId === "login_terminal"
              ? ("running" as const)
              : terminalId === "reopen_terminal_2"
                ? ("exited" as const)
                : ("disconnected" as const),
        }),
        output: async () => ({
          chunks: [
            {
              dataBase64: Buffer.from(
                `BB_CLAUDE_LOGIN_AUTHORIZATION_READY:${launcherPath}\nBB_CLAUDE_LOGIN_INPUT_READY\n`,
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
      },
    },
  });
  await plugin(host.bb);
  const switching = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });

  try {
    await created;
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      host.harness.behavior.callRpc("reopenAuthorization", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      }),
      /could not be confirmed/,
    );
    assert.equal(terminalCreates, 2);
    const whileCleanupIsUncertain = (await host.harness.behavior.callRpc(
      "inspectSwitch",
      { threadId: "thread_1" },
    )) as InspectedSwitch;
    assert.equal(whileCleanupIsUncertain.status, "running");
    if (whileCleanupIsUncertain.status !== "running") {
      throw new Error("Expected active switch.");
    }
    assert.equal(whileCleanupIsUncertain.codeReady, false);

    await assert.rejects(
      host.harness.behavior.callRpc("reopenAuthorization", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      }),
      /still being cleaned up/,
    );
    assert.equal(terminalCreates, 2);

    firstReopenCanExit = true;
    assert.deepEqual(
      await host.harness.behavior.callRpc("reopenAuthorization", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      }),
      { opened: true },
    );
    assert.equal(terminalCreates, 3);
  } finally {
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
    const firstSwitch = beginAndAttach(host, {
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

      secondSwitch = beginAndAttach(host, {
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
  const first = beginAndAttach(host, {
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
          readonly step: "admitting" | "cleanup" | "login" | "verification" | "release";
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
        step: inspected.step,
      },
      {
        codeReady: false,
        mode: "current",
        phase: "cancellable",
        status: "running",
        step: "verification",
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
      {
        completion: {
          kind: "result",
          result: { outcome: "ready-next-message" },
        },
        mode: "current",
        operationId: inspected.operationId,
        status: "finished",
      },
    );
    assert.deepEqual(
      await host.harness.behavior.callRpc("attachSwitch", {
        operationId: inspected.operationId,
        threadId: "thread_1",
      }),
      { outcome: "ready-next-message" },
    );
    assert.equal(creates, 1);
  } finally {
    releaseOutput();
    await first.catch(() => undefined);
    await host.harness.lifecycle.dispose();
  }
});

test("an exact finished receipt survives a newer switch on the same thread", async () => {
  let createCount = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) => ({
          exitCode: 0,
          hostId: "host_1",
          id: terminalId,
          status: "exited" as const,
        }),
        create: async () => {
          createCount += 1;
          return {
            exitCode: null,
            hostId: "host_1",
            id: `status_terminal_${createCount}`,
            status: "running" as const,
          };
        },
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
      await beginAndAttach(host, {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_1",
      }),
      { outcome: "ready-next-message" },
    );
    assert.deepEqual(
      await beginAndAttach(host, {
        operationId: STALE_OPERATION_ID,
        mode: "current",
        threadId: "thread_1",
      }),
      { outcome: "ready-next-message" },
    );
    assert.deepEqual(
      await host.harness.behavior.callRpc("attachSwitch", {
        operationId: DEFAULT_OPERATION_ID,
        threadId: "thread_1",
      }),
      { outcome: "ready-next-message" },
    );
    assert.deepEqual(
      await host.harness.behavior.callRpc("inspectSwitch", {
        threadId: "thread_1",
      }),
      {
        completion: {
          kind: "result",
          result: { outcome: "ready-next-message" },
        },
        mode: "current",
        operationId: STALE_OPERATION_ID,
        status: "finished",
      },
    );
    const currentTime = Date.now();
    const originalNow = Date.now;
    Date.now = () => currentTime + 61_000;
    try {
      assert.deepEqual(
        await host.harness.behavior.callRpc("attachSwitch", {
          operationId: STALE_OPERATION_ID,
          threadId: "thread_1",
        }),
        { outcome: "not-running" },
      );
      assert.deepEqual(
        await host.harness.behavior.callRpc("inspectSwitch", {
          threadId: "thread_1",
        }),
        { status: "none" },
      );
    } finally {
      Date.now = originalNow;
    }
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
      beginAndAttach(host, {
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
  const mismatchedSwitch = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "current",
    threadId: "thread_1",
  });

  try {
    await closing;
    await assert.rejects(
      beginAndAttach(host, {
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
  const firstSwitch = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "current",
    threadId: "thread_1",
  });
  let secondSwitch: Promise<unknown> | undefined;

  try {
    await firstClosing;
    secondSwitch = beginAndAttach(host, {
      operationId: DEFAULT_OPERATION_ID,
      mode: "current",
      threadId: "thread_2",
    });
    await secondClosing;

    releaseFirstClose();
    await assert.rejects(firstSwitch, /different machine/);
    await assert.rejects(
      beginAndAttach(host, {
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
      beginAndAttach(host, {
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
      beginAndAttach(host, {
        operationId: DEFAULT_OPERATION_ID,
        mode: "current",
        threadId: "thread_1",
      }),
      /cleanup state could not be stored/,
    );
    await assert.rejects(
      beginAndAttach(host, {
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
      await beginAndAttach(host, {
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
        await beginAndAttach(host, {
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
  const switching = beginAndAttach(host, {
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
  const switching = beginAndAttach(host, {
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
  const switching = beginAndAttach(host, {
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
  const switching = beginAndAttach(host, {
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

test("plugin reload keeps a disconnected login helper durably owned", async () => {
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  let closeAttempts = 0;
  let createCount = 0;
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) throw new Error("session machine disconnected");
          if (closeAttempts > 2) throw new Error("session machine still disconnected");
          return {
            exitCode: null,
            hostId: "host_1",
            id: "login_terminal",
            status: "disconnected" as const,
          };
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
  const switching = beginAndAttach(host, {
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

  const reloaded = await host.harness.lifecycle.reload(plugin);
  assert.equal(closeAttempts, 2);
  const reloadedAgain = await reloaded.harness.lifecycle.reload(plugin);
  assert.equal(closeAttempts, 3);
  await assert.rejects(
    beginAndAttach(reloadedAgain, {
      operationId: STALE_OPERATION_ID,
      mode: "login",
      threadId: "thread_2",
    }),
    /previous Claude login helper could not be stopped/,
  );
  assert.equal(createCount, 1);
  await reloadedAgain.harness.lifecycle.dispose();
});

test("plugin disposal retries cleanup persistence after a completed login", async () => {
  let persistenceRetryStarted!: () => void;
  let releasePersistenceRetry!: () => void;
  const retryStarted = new Promise<void>((resolve) => {
    persistenceRetryStarted = resolve;
  });
  const retryGate = new Promise<void>((resolve) => {
    releasePersistenceRetry = resolve;
  });
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
      persistenceRetryStarted();
      await retryGate;
      await originalSet(key, value);
    },
  });

  const result = await beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });

  assert.deepEqual(result, { outcome: "login-changed-not-rebound" });
  assert.equal(host.harness.inspection.sdk.callsTo("threads.stop").length, 0);
  assert.equal(persistenceAttempts, 1);

  let disposed = false;
  const disposal = host.harness.lifecycle.dispose().then(() => {
    disposed = true;
  });
  await retryStarted;
  await Promise.resolve();
  assert.equal(disposed, false);
  releasePersistenceRetry();
  await disposal;

  assert.equal(persistenceAttempts, 2);
});

test("an older persistence success cannot hide a newer failed adoption", async () => {
  let firstPersistenceStarted!: () => void;
  let releaseFirstPersistence!: () => void;
  let helperCreated!: () => void;
  let disposalRetryStarted!: () => void;
  let releaseDisposalRetry!: () => void;
  const firstPersistence = new Promise<void>((resolve) => {
    firstPersistenceStarted = resolve;
  });
  const firstPersistenceGate = new Promise<void>((resolve) => {
    releaseFirstPersistence = resolve;
  });
  const created = new Promise<void>((resolve) => {
    helperCreated = resolve;
  });
  const disposalRetry = new Promise<void>((resolve) => {
    disposalRetryStarted = resolve;
  });
  const disposalRetryGate = new Promise<void>((resolve) => {
    releaseDisposalRetry = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async ({ terminalId }) =>
          terminalId === "stale_terminal"
            ? {
                exitCode: 1,
                hostId: "host_1",
                id: terminalId,
                status: "exited" as const,
              }
            : {
                exitCode: null,
                hostId: "host_2",
                id: terminalId,
                status: "disconnected" as const,
              },
        create: async () => {
          helperCreated();
          return {
            exitCode: null,
            hostId: "host_2",
            id: "login_terminal",
            status: "running" as const,
          };
        },
        get: async () => ({
          exitCode: null,
          hostId: "host_2",
          id: "login_terminal",
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
  await host.bb.storage.kv.set("unclean-login-terminals-v1", [
    { hostId: "host_1", terminalId: "stale_terminal" },
  ]);
  await plugin(host.bb);
  const originalSet = host.bb.storage.kv.set.bind(host.bb.storage.kv);
  const originalDelete = host.bb.storage.kv.delete.bind(host.bb.storage.kv);
  let persistenceAttempts = 0;
  const persist = async (write: () => Promise<void>) => {
    persistenceAttempts += 1;
    if (persistenceAttempts === 1) {
      firstPersistenceStarted();
      await firstPersistenceGate;
    } else if (persistenceAttempts === 2) {
      throw new Error("new helper ownership could not be stored");
    } else if (persistenceAttempts === 3) {
      disposalRetryStarted();
      await disposalRetryGate;
    }
    await write();
  };
  Object.defineProperty(host.bb.storage.kv, "set", {
    configurable: true,
    value: (key: string, value: unknown) => persist(() => originalSet(key, value)),
  });
  Object.defineProperty(host.bb.storage.kv, "delete", {
    configurable: true,
    value: (key: string) => persist(() => originalDelete(key)),
  });

  const firstAdmission = await host.harness.behavior.callRpc("beginSwitch", {
    mode: "current",
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_1",
  });
  assert.deepEqual(firstAdmission, { outcome: "accepted" });
  await firstPersistence;

  const secondAdmission = await host.harness.behavior.callRpc("beginSwitch", {
    mode: "login",
    operationId: STALE_OPERATION_ID,
    threadId: "thread_2",
  });
  assert.deepEqual(secondAdmission, { outcome: "accepted" });
  await created;

  const cancellation = host.harness.behavior.callRpc("cancelSwitch", {
    operationId: DEFAULT_OPERATION_ID,
    threadId: "thread_1",
  });
  releaseFirstPersistence();
  assert.deepEqual(await cancellation, { outcome: "cancelled-before-release" });
  assert.deepEqual(
    await host.harness.behavior.callRpc("attachSwitch", {
      operationId: STALE_OPERATION_ID,
      threadId: "thread_2",
    }),
    { outcome: "login-changed-not-rebound" },
  );
  assert.equal(persistenceAttempts, 2);

  const disposal = host.harness.lifecycle.dispose();
  const firstDisposalEvent = await Promise.race([
    disposalRetry.then(() => "retry" as const),
    disposal.then(() => "disposed" as const),
  ]);
  assert.equal(firstDisposalEvent, "retry");
  releaseDisposalRetry();
  await disposal;
  assert.equal(persistenceAttempts, 3);
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

  const firstSwitch = beginAndAttach(host, {
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

  const secondSwitch = beginAndAttach(host, {
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
  let closeAttempts = 0;
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 2) {
            return {
              exitCode: null,
              hostId: "host_1",
              id: "login_terminal",
              status: "disconnected" as const,
            };
          }
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

  const firstSwitch = beginAndAttach(host, {
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
    beginAndAttach(host, {
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
  const firstSwitch = beginAndAttach(host, {
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
    beginAndAttach(reloaded, {
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
  let closeAttempts = 0;
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const host = createFakePluginHost({
    pluginId: "claude-account-switcher",
    sdk: {
      terminals: {
        close: async () => {
          closeAttempts += 1;
          if (closeAttempts === 1) {
            return {
              exitCode: null,
              hostId: "host_2",
              id: "login_terminal_1",
              status: "disconnected" as const,
            };
          }
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
  const firstSwitch = beginAndAttach(host, {
    operationId: DEFAULT_OPERATION_ID,
    mode: "login",
    threadId: "thread_1",
  });
  await started;
  await assert.rejects(firstSwitch, /different machine/);

  await assert.rejects(
    beginAndAttach(host, {
      operationId: DEFAULT_OPERATION_ID,
      mode: "login",
      threadId: "thread_2",
    }),
    /previous Claude login helper could not be stopped/,
  );
  assert.equal(createCount, 1);
  await host.harness.lifecycle.dispose();
});
