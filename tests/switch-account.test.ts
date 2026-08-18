import assert from "node:assert/strict";
import test from "node:test";
import {
  switchClaudeAccount,
  type AccountSwitchDependencies,
  type RecoverySnapshot,
} from "../switch-account.ts";

function recovery(failedRequestId = "req_1"): RecoverySnapshot {
  return {
    candidate: {
      failedRequestId,
      rateLimits: { providerId: "claude-code" },
    },
    hostId: "host_1",
    reason: "manual-only",
  };
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

function dependencies(
  events: string[],
  overrides: Partial<AccountSwitchDependencies> = {},
): AccountSwitchDependencies {
  return {
    continueThread: async (_threadId, failedRequestId) => {
      events.push(`continue:${failedRequestId}`);
    },
    getRecovery: async () => {
      events.push("recovery");
      return recovery();
    },
    getThread: async () => {
      events.push("thread");
      return { providerId: "claude-code" };
    },
    login: async () => {
      events.push("login");
    },
    stopThread: async () => {
      events.push("stop");
    },
    ...overrides,
  };
}

test("logs in, rechecks the failed turn, releases the runtime, then retries", async () => {
  const events: string[] = [];
  const result = await switchClaudeAccount(
    dependencies(events),
    "thread_1",
    new Set(),
    activeSignal(),
  );

  assert.deepEqual(result, { retrying: true });
  assert.deepEqual(events, [
    "thread",
    "recovery",
    "login",
    "recovery",
    "stop",
    "continue:req_1",
  ]);
});

test("a failed login leaves the BB session untouched", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    login: async () => {
      events.push("login");
      throw new Error("login cancelled");
    },
  });

  await assert.rejects(
    switchClaudeAccount(deps, "thread_1", new Set(), activeSignal()),
    /login cancelled/,
  );
  assert.deepEqual(events, ["thread", "recovery", "login"]);
});

test("cancelling a switch aborts login and releases the machine lock", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const deps = dependencies(events, {
    login: async (_threadId, signal) => {
      events.push("login");
      loginStarted();
      if (!signal) throw new Error("missing cancellation signal");
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("login cancelled"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => reject(new Error("login cancelled")),
          { once: true },
        );
      });
    },
  });
  const locks = new Set<string>();
  const running = switchClaudeAccount(
    deps,
    "thread_1",
    locks,
    controller.signal,
  );
  await started;

  controller.abort();
  await assert.rejects(running, /login cancelled/);
  assert.equal(locks.size, 0);
});

test("cancelling as login finishes prevents the session retry", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const deps = dependencies(events, {
    login: async () => {
      events.push("login");
      controller.abort();
    },
  });

  await assert.rejects(
    switchClaudeAccount(deps, "thread_1", new Set(), controller.signal),
    /cancelled/,
  );
  assert.deepEqual(events, ["thread", "recovery", "login"]);
});

test("a changed failed turn is not stopped or retried", async () => {
  const events: string[] = [];
  let recoveryCount = 0;
  const deps = dependencies(events, {
    getRecovery: async () => {
      events.push("recovery");
      recoveryCount += 1;
      return recovery(recoveryCount === 1 ? "req_1" : "req_2");
    },
  });

  await assert.rejects(
    switchClaudeAccount(deps, "thread_1", new Set(), activeSignal()),
    /session changed while you were signing in/,
  );
  assert.deepEqual(events, ["thread", "recovery", "login", "recovery"]);
});

test("a failed turn that disappears during login is not stopped", async () => {
  const events: string[] = [];
  let recoveryCount = 0;
  const deps = dependencies(events, {
    getRecovery: async () => {
      events.push("recovery");
      recoveryCount += 1;
      return recoveryCount === 1
        ? recovery()
        : {
            candidate: null,
            hostId: "host_1",
            reason: "thread-not-failed",
          };
    },
  });

  await assert.rejects(
    switchClaudeAccount(deps, "thread_1", new Set(), activeSignal()),
    /no longer safe to retry/,
  );
  assert.deepEqual(events, ["thread", "recovery", "login", "recovery"]);
});

test("a second switch on the same machine is refused", async () => {
  const events: string[] = [];
  let releaseLogin!: () => void;
  let loginStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    loginStarted = resolve;
  });
  const loginGate = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  const deps = dependencies(events, {
    login: async () => {
      events.push("login");
      loginStarted();
      await loginGate;
    },
  });
  const locks = new Set<string>();
  const first = switchClaudeAccount(deps, "thread_1", locks, activeSignal());
  await started;

  await assert.rejects(
    switchClaudeAccount(deps, "thread_2", locks, activeSignal()),
    /already open on this machine/,
  );
  releaseLogin();
  await first;
});

test("non-Claude and non-retriable sessions fail before login", async () => {
  const nonClaudeEvents: string[] = [];
  await assert.rejects(
    switchClaudeAccount(
      dependencies(nonClaudeEvents, {
        getThread: async () => ({ providerId: "codex" }),
      }),
      "thread_1",
      new Set(),
      activeSignal(),
    ),
    /only works in Claude Code sessions/,
  );
  assert.deepEqual(nonClaudeEvents, []);

  const noRetryEvents: string[] = [];
  await assert.rejects(
    switchClaudeAccount(
      dependencies(noRetryEvents, {
        getRecovery: async () => ({
          candidate: null,
          hostId: "host_1",
          reason: "no-rate-limit-state",
        }),
      }),
      "thread_1",
      new Set(),
      activeSignal(),
    ),
    /does not have a safe Claude subscription-limit retry/,
  );
});
