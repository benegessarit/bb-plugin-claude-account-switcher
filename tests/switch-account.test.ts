import assert from "node:assert/strict";
import test from "node:test";
import {
  switchClaudeAccount,
  type AccountSwitchDependencies,
  type ThreadSnapshot,
} from "../switch-account.ts";

function thread(
  status: NonNullable<ThreadSnapshot["status"]> = "idle",
): ThreadSnapshot {
  return {
    environment: { hostId: "host_1" },
    providerId: "claude-code",
    status,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function dependencies(
  events: string[],
  overrides: Partial<AccountSwitchDependencies> = {},
): AccountSwitchDependencies {
  return {
    getThread: async () => {
      events.push("thread");
      return thread();
    },
    login: async (_threadId, _hostId, _signal, onSuccess) => {
      events.push("login");
      onSuccess?.();
    },
    reconcileCleanup: async () => undefined,
    stopThread: async () => {
      events.push("stop");
    },
    verifySubscription: async () => {
      events.push("auth");
    },
    ...overrides,
  };
}

test("an idle session uses the current login without opening OAuth", async () => {
  const events: string[] = [];

  const result = await switchClaudeAccount(
    dependencies(events),
    { mode: "current", threadId: "thread_1" },
    new Set(),
    signal(),
  );

  assert.deepEqual(result, { outcome: "ready-next-message" });
  assert.deepEqual(events, ["thread", "auth", "thread", "stop"]);
});

test("an errored session releases the runtime for the next message", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    getThread: async () => {
      events.push("thread");
      return thread("error");
    },
  });

  const result = await switchClaudeAccount(
    deps,
    { mode: "current", threadId: "thread_1" },
    new Set(),
    signal(),
  );

  assert.deepEqual(result, { outcome: "ready-next-message" });
  assert.deepEqual(events, ["thread", "auth", "thread", "stop"]);
});

test("a session that moves to another machine is never stopped", async () => {
  const events: string[] = [];
  let threadCount = 0;
  const deps = dependencies(events, {
    getThread: async () => {
      events.push("thread");
      threadCount += 1;
      return {
        ...thread("error"),
        environment: { hostId: threadCount === 1 ? "host_1" : "host_2" },
      };
    },
  });

  const result = await switchClaudeAccount(
    deps,
    { mode: "login", threadId: "thread_1" },
    new Set(),
    signal(),
    { markCommitted: () => events.push("committed") },
  );

  assert.deepEqual(result, { outcome: "login-changed-not-rebound" });
  assert.deepEqual(events, ["thread", "login", "committed", "auth", "thread"]);
});

for (const status of ["active", "starting", "stopping"] as const) {
  test(`${status} work is refused before login or authentication`, async () => {
    const events: string[] = [];
    const deps = dependencies(events, {
      getThread: async () => {
        events.push("thread");
        return thread(status);
      },
    });

    await assert.rejects(
      switchClaudeAccount(
        deps,
        { mode: "login", threadId: "thread_1" },
        new Set(),
        signal(),
      ),
      /become idle/,
    );
    assert.deepEqual(events, ["thread"]);
  });
}

test("a completed login with failed auth proof does not release the session", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    verifySubscription: async () => {
      events.push("auth");
      throw new Error("subscription login could not be verified");
    },
  });

  const result = await switchClaudeAccount(
    deps,
    { mode: "login", threadId: "thread_1" },
    new Set(),
    signal(),
    { markCommitted: () => events.push("committed") },
  );

  assert.deepEqual(result, { outcome: "login-changed-not-rebound" });
  assert.deepEqual(events, ["thread", "login", "committed", "auth"]);
});

test("cancellation before the current-login commit leaves the runtime untouched", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const deps = dependencies(events, {
    verifySubscription: async () => {
      events.push("auth");
      controller.abort();
    },
  });

  await assert.rejects(
    switchClaudeAccount(
      deps,
      { mode: "current", threadId: "thread_1" },
      new Set(),
      controller.signal,
    ),
    /cancelled/,
  );
  assert.deepEqual(events, ["thread", "auth"]);
});

test("login success commits before auth verification and ignores a late cancel", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  const deps = dependencies(events, {
    login: async (_threadId, _hostId, _signal, onSuccess) => {
      events.push("login");
      onSuccess?.();
      controller.abort();
    },
  });

  const result = await switchClaudeAccount(
    deps,
    { mode: "login", threadId: "thread_1" },
    new Set(),
    controller.signal,
    { markCommitted: () => events.push("committed") },
  );

  assert.deepEqual(result, { outcome: "ready-next-message" });
  assert.deepEqual(events, ["thread", "login", "committed", "auth", "thread", "stop"]);
});

test("a second switch on the same machine is refused", async () => {
  const events: string[] = [];
  let releaseAuth!: () => void;
  let authStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    authStarted = resolve;
  });
  const authGate = new Promise<void>((resolve) => {
    releaseAuth = resolve;
  });
  const deps = dependencies(events, {
    verifySubscription: async () => {
      events.push("auth");
      authStarted();
      await authGate;
    },
  });
  const locks = new Set<string>();
  const first = switchClaudeAccount(
    deps,
    { mode: "current", threadId: "thread_1" },
    locks,
    signal(),
  );
  await started;

  await assert.rejects(
    switchClaudeAccount(
      deps,
      { mode: "current", threadId: "thread_2" },
      locks,
      signal(),
    ),
    /already open on this machine/,
  );
  releaseAuth();
  await first;
  assert.equal(locks.size, 0);
});

test("non-Claude and missing-host sessions fail before login", async () => {
  for (const snapshot of [
    { ...thread(), providerId: "codex" },
    { ...thread(), environment: null },
  ]) {
    const events: string[] = [];
    const deps = dependencies(events, {
      getThread: async () => snapshot,
    });

    await assert.rejects(
      switchClaudeAccount(
        deps,
        { mode: "login", threadId: "thread_1" },
        new Set(),
        signal(),
      ),
    );
    assert.deepEqual(events, []);
  }
});
