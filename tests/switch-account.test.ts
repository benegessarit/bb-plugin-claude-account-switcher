import assert from "node:assert/strict";
import test from "node:test";
import {
  HostReservations,
  switchClaudeAccount,
  type AccountSwitchDependencies,
  type ThreadSnapshot,
} from "../switch-account.ts";

test("host reservations release only the exact owner's lease", () => {
  const reservations = new HostReservations();
  const firstOwner = {};
  const secondOwner = {};

  reservations.reserve("host_1", firstOwner);
  reservations.reserve("host_1", secondOwner);
  assert.equal(reservations.has("host_1"), true);

  assert.equal(reservations.release("host_1", {}), false);
  assert.equal(reservations.has("host_1"), true);

  assert.equal(reservations.release("host_1", firstOwner), true);
  assert.equal(reservations.has("host_1"), true);

  assert.equal(reservations.release("host_1", secondOwner), true);
  assert.equal(reservations.has("host_1"), false);
});

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
    new HostReservations(),
    signal(),
  );

  assert.deepEqual(result, { outcome: "ready-next-message" });
  assert.deepEqual(events, ["thread", "auth", "thread", "stop"]);
});

test("admission and progress are reported from the host-owned state machine", async () => {
  const events: string[] = [];

  const result = await switchClaudeAccount(
    dependencies(events),
    { mode: "current", threadId: "thread_1" },
    new HostReservations(),
    signal(),
    {
      markAdmitted: (hostId: string) => events.push(`admitted:${hostId}`),
      markCommitted: () => events.push("committed"),
      setStep: (step: string) => events.push(`step:${step}`),
    },
  );

  assert.deepEqual(result, { outcome: "ready-next-message" });
  assert.deepEqual(events, [
    "thread",
    "admitted:host_1",
    "step:cleanup",
    "step:verification",
    "auth",
    "step:release",
    "thread",
    "committed",
    "stop",
  ]);
});

test("failed-helper reconciliation holds the machine lock", async () => {
  const events: string[] = [];
  const hostLocks = new HostReservations();
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let cleanupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const switching = switchClaudeAccount(
    dependencies(events, {
      reconcileCleanup: async () => {
        cleanupStarted();
        await cleanup;
      },
    }),
    { mode: "current", threadId: "thread_1" },
    hostLocks,
    signal(),
  );
  await started;

  assert.equal(hostLocks.has("host_1"), true);
  releaseCleanup();
  assert.deepEqual(await switching, { outcome: "ready-next-message" });
  assert.equal(hostLocks.has("host_1"), false);
});

test("cancellation during cleanup reconciliation launches no helper", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  let releaseCleanup!: () => void;
  const cleanup = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let cleanupStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const switching = switchClaudeAccount(
    dependencies(events, {
      reconcileCleanup: async () => {
        events.push("cleanup");
        cleanupStarted();
        await cleanup;
      },
    }),
    { mode: "login", threadId: "thread_1" },
    new HostReservations(),
    controller.signal,
  );
  await started;
  controller.abort();
  releaseCleanup();

  await assert.rejects(switching, /cancelled/);
  assert.deepEqual(events, ["thread", "cleanup"]);
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
    new HostReservations(),
    signal(),
  );

  assert.deepEqual(result, { outcome: "ready-next-message" });
  assert.deepEqual(events, ["thread", "auth", "thread", "stop"]);
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
        new HostReservations(),
        signal(),
      ),
      /become idle/,
    );
    assert.deepEqual(events, ["thread"]);
  });
}

test("thread readiness failures expose a typed admission reason", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    getThread: async () => thread("active"),
  });

  await assert.rejects(
    switchClaudeAccount(
      deps,
      { mode: "login", threadId: "thread_1" },
      new HostReservations(),
      signal(),
    ),
    (error: unknown) => {
      assert.equal((error as { readonly reason?: string }).reason, "thread-not-idle");
      return true;
    },
  );
});

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
    new HostReservations(),
    signal(),
    { markCommitted: () => events.push("committed") },
  );

  assert.deepEqual(result, { outcome: "login-changed-not-rebound" });
  assert.deepEqual(events, ["thread", "login", "committed", "auth"]);
});

test("a cleanup error after login success reports changed login without release", async () => {
  const events: string[] = [];
  const deps = dependencies(events, {
    login: async (_threadId, _hostId, _signal, onSuccess) => {
      events.push("login");
      onSuccess?.();
      throw new Error("cleanup state could not be stored");
    },
  });

  const result = await switchClaudeAccount(
    deps,
    { mode: "login", threadId: "thread_1" },
    new HostReservations(),
    signal(),
    { markCommitted: () => events.push("committed") },
  );

  assert.deepEqual(result, { outcome: "login-changed-not-rebound" });
  assert.deepEqual(events, ["thread", "login", "committed"]);
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
      new HostReservations(),
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
    new HostReservations(),
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
  const locks = new HostReservations();
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
  assert.equal(locks.has("host_1"), false);
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
        new HostReservations(),
        signal(),
      ),
    );
    assert.deepEqual(events, []);
  }
});
