import assert from "node:assert/strict";
import test from "node:test";
import * as loginTerminal from "../login-terminal.ts";
import {
  buildClaudeLoginCommand,
  runClaudeAuthStatus,
  runClaudeLogin,
  type AuthStatusTerminalClient,
  type LoginWaitOptions,
  type LoginTerminal,
  type LoginTerminalClient,
} from "../login-terminal.ts";

function terminal(
  status: LoginTerminal["status"],
  exitCode: number | null = null,
): LoginTerminal {
  return { id: "terminal_1", status, exitCode };
}

function client(
  states: LoginTerminal[],
  closes: Array<"force" | "if-clean">,
): LoginTerminalClient {
  return {
    close: async (_id, mode) => {
      closes.push(mode);
    },
    create: async () => states[0]!,
    get: async () => states.shift() ?? terminal("exited", 0),
  };
}

test("the login command selects the target Claude subscription email", () => {
  const buildCommand = Reflect.get(loginTerminal, "buildClaudeLoginCommand") as unknown;
  assert.equal(typeof buildCommand, "function");

  const command = (buildCommand as (email: string) => string)(
    "second+claude@example.com",
  );
  assert.match(command, /auth login --claudeai/);
  assert.match(command, /--email 'second\+claude@example\.com'/);
  assert.match(command, />\/dev\/null 2>&1/);
});

test("the login command omits the email flag when no prefill is requested", () => {
  assert.equal(
    buildClaudeLoginCommand(),
    "command claude auth login --claudeai >/dev/null 2>&1",
  );
});

test("the auth-status command emits only safe classification fields", () => {
  const buildCommand = Reflect.get(
    loginTerminal,
    "buildClaudeAuthStatusCommand",
  ) as unknown;
  assert.equal(typeof buildCommand, "function");

  const command = (buildCommand as () => string)();
  assert.match(command, /claude.*auth.*status.*--json/);
  assert.match(command, /loggedIn/);
  assert.match(command, /authMethod/);
  assert.match(command, /apiProvider/);
  assert.match(command, /subscriptionType/);
  assert.doesNotMatch(command, /accountEmail|orgId|orgName/);
});

test("auth status accepts only active first-party subscription login", () => {
  const parse = Reflect.get(loginTerminal, "parseClaudeAuthStatus") as unknown;
  assert.equal(typeof parse, "function");

  const output = [
    "loggedIn=true",
    "authMethod=claude.ai",
    "apiProvider=firstParty",
    "subscriptionType=max",
    "",
  ].join("\n");
  assert.deepEqual((parse as (value: string) => unknown)(output), {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
    subscriptionType: "max",
  });
});

test("auth status fails closed on unsafe or incomplete output", () => {
  const parse = Reflect.get(loginTerminal, "parseClaudeAuthStatus") as (
    value: string,
  ) => unknown;

  for (const output of [
    "loggedIn=true\nauthMethod=apiKey\napiProvider=firstParty\nsubscriptionType=max\n",
    "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
    "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\nemail=private@example.com\n",
  ]) {
    assert.throws(() => parse(output), /subscription login could not be verified/);
  }
});

test("auth verification reads safe output and closes its helper terminal", async () => {
  const runStatus = Reflect.get(loginTerminal, "runClaudeAuthStatus") as unknown;
  assert.equal(typeof runStatus, "function");
  const closes: Array<"force" | "if-clean"> = [];

  const status = await (
    runStatus as (
      client: LoginTerminalClient & { output(id: string): Promise<string> },
      threadId: string,
      options: LoginWaitOptions,
    ) => Promise<unknown>
  )(
    {
      close: async (_id, mode) => {
        closes.push(mode);
      },
      create: async () => terminal("running"),
      get: async () => terminal("exited", 0),
      output: async () =>
        "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\n",
    },
    "thread_1",
    { sleep: async () => undefined, timeoutMs: 15_000 },
  );

  assert.deepEqual(status, {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
    subscriptionType: "max",
  });
  assert.deepEqual(closes, ["if-clean"]);
});

test("a successful terminal login closes cleanly", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("running"), terminal("exited", 0)];
  let committed = false;

  await runClaudeLogin(client(states, closes), "thread_1", {
    onSuccess: () => {
      committed = true;
    },
    sleep: async () => undefined,
  });

  assert.equal(committed, true);
  assert.deepEqual(closes, ["if-clean"]);
});

test("a failed terminal login does not report success", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("exited", 1)];

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1"),
    /did not finish successfully/,
  );
  assert.deepEqual(closes, ["if-clean"]);
});

test("a timed-out login is force-closed", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("running")];
  let now = 0;

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1", {
      now: () => now,
      sleep: async () => {
        now += 10;
      },
      timeoutMs: 5,
    }),
    /timed out/,
  );
  assert.deepEqual(closes, ["force"]);
});

test("a cancelled login stops before another poll and is force-closed", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const controller = new AbortController();
  const states = [terminal("running"), terminal("exited", 0)];
  let sleeps = 0;
  controller.abort();

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1", {
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
      },
    }),
    /cancelled/,
  );
  assert.equal(sleeps, 0);
  assert.deepEqual(closes, ["force"]);
});

test("cancellation wakes a pending poll without waiting for its timer", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const controller = new AbortController();
  let pollStarted!: () => void;
  let releasePoll!: () => void;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const blockedPoll = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const running = runClaudeLogin(client([terminal("running")], closes), "thread_1", {
    signal: controller.signal,
    sleep: async () => {
      pollStarted();
      await blockedPoll;
    },
  });
  await started;

  controller.abort();
  const outcome = await Promise.race([
    running.catch((error: unknown) => error),
    new Promise<"still waiting">((resolve) => {
      setTimeout(() => resolve("still waiting"), 25);
    }),
  ]);

  releasePoll();
  await running.catch(() => undefined);
  assert.notEqual(outcome, "still waiting");
  assert.match(String(outcome), /cancelled/);
  assert.deepEqual(closes, ["force"]);
});

test("auth cancellation wakes a pending poll without another terminal read", async () => {
  const controller = new AbortController();
  let pollStarted!: () => void;
  let releasePoll!: () => void;
  let reads = 0;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const blockedPoll = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const authClient: AuthStatusTerminalClient = {
    close: async () => undefined,
    create: async () => terminal("running"),
    get: async () => {
      reads += 1;
      return terminal("exited", 0);
    },
    output: async () =>
      "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\n",
  };
  const running = runClaudeAuthStatus(authClient, "thread_1", {
    signal: controller.signal,
    sleep: async () => {
      pollStarted();
      await blockedPoll;
    },
  });
  await started;

  controller.abort();
  await assert.rejects(running, /subscription login could not be verified/);
  releasePoll();
  assert.equal(reads, 0);
});

test("terminal cleanup cannot turn a successful login into a failure", async () => {
  let settled = false;
  await runClaudeLogin(
    {
      close: async () => {
        throw new Error("already gone");
      },
      create: async () => terminal("exited", 0),
      get: async () => terminal("exited", 0),
      onSettled: () => {
        settled = true;
      },
    },
    "thread_1",
  );
  assert.equal(settled, true);
});
