import assert from "node:assert/strict";
import test from "node:test";
import * as loginTerminal from "../login-terminal.ts";
import {
  runClaudeLogin,
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
  const buildCommand = Reflect.get(
    loginTerminal,
    "buildClaudeLoginCommand",
  ) as unknown;
  assert.equal(typeof buildCommand, "function");

  const command = (buildCommand as (email: string) => string)(
    "second+claude@example.com",
  );
  assert.match(command, /auth login --claudeai/);
  assert.match(command, /--email 'second\+claude@example\.com'/);
  assert.match(command, />\/dev\/null 2>&1/);
});

test("a successful terminal login closes cleanly", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("running"), terminal("exited", 0)];

  await runClaudeLogin(client(states, closes), "thread_1", {
    sleep: async () => undefined,
  });

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
  const running = runClaudeLogin(
    client([terminal("running")], closes),
    "thread_1",
    {
      signal: controller.signal,
      sleep: async () => {
        pollStarted();
        await blockedPoll;
      },
    },
  );
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
