const CLAUDE_PROVIDER_ID = "claude-code";

export type SwitchStep = "admitting" | "cleanup" | "login" | "verification" | "release";

export type SwitchAdmissionReason =
  | "host-busy"
  | "machine-unavailable"
  | "not-claude"
  | "thread-not-idle"
  | "thread-not-ready";

export class SwitchAdmissionError extends Error {
  readonly reason: SwitchAdmissionReason;

  constructor(reason: SwitchAdmissionReason, message: string) {
    super(message);
    this.name = "SwitchAdmissionError";
    this.reason = reason;
  }
}

export interface HostLockRegistry {
  has(hostId: string): boolean;
  release(hostId: string, owner: object): boolean;
  reserve(hostId: string, owner: object): void;
}

export class HostReservations implements HostLockRegistry {
  readonly #owners = new Map<string, Set<object>>();

  reserve(hostId: string, owner: object): void {
    const owners = this.#owners.get(hostId) ?? new Set<object>();
    owners.add(owner);
    this.#owners.set(hostId, owners);
  }

  clear(): void {
    this.#owners.clear();
  }

  release(hostId: string, owner: object): boolean {
    const owners = this.#owners.get(hostId);
    if (!owners?.delete(owner)) return false;
    if (owners.size === 0) this.#owners.delete(hostId);
    return true;
  }

  has(hostId: string): boolean {
    return this.#owners.has(hostId);
  }
}

export interface ThreadSnapshot {
  readonly providerId: string;
  readonly status?: "active" | "starting" | "idle" | "stopping" | "error";
  readonly environment?: { readonly hostId: string } | null;
}

export interface AccountSwitchDependencies {
  getThread(threadId: string, signal: AbortSignal): Promise<ThreadSnapshot>;
  login(
    threadId: string,
    hostId: string,
    signal: AbortSignal,
    onSuccess?: () => void,
  ): Promise<void>;
  reconcileCleanup(hostId: string, signal: AbortSignal): Promise<void>;
  stopThread(threadId: string): Promise<void>;
  verifySubscription(
    threadId: string,
    hostId: string,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface AccountSwitchRequest {
  readonly mode: "current" | "login";
  readonly threadId: string;
}

export interface AccountSwitchLifecycle {
  markAdmitted?(hostId: string): void;
  markCommitted?(): void;
  setStep?(step: SwitchStep): void;
}

interface SessionAction {
  readonly hostId: string;
}

async function classifySession(
  dependencies: AccountSwitchDependencies,
  threadId: string,
  signal: AbortSignal,
): Promise<SessionAction> {
  const thread = await dependencies.getThread(threadId, signal);
  if (thread.providerId !== CLAUDE_PROVIDER_ID) {
    throw new SwitchAdmissionError(
      "not-claude",
      "This button only works in Claude Code sessions.",
    );
  }
  const hostId = thread.environment?.hostId;
  if (!hostId) {
    throw new SwitchAdmissionError(
      "machine-unavailable",
      "BB could not identify this session's machine.",
    );
  }
  if (thread.status === "idle" || thread.status === "error") return { hostId };
  if (
    thread.status === "active" ||
    thread.status === "starting" ||
    thread.status === "stopping"
  ) {
    throw new SwitchAdmissionError(
      "thread-not-idle",
      "Wait for this session to become idle before switching its Claude login.",
    );
  }
  throw new SwitchAdmissionError(
    "thread-not-ready",
    "This session is not ready to rebind.",
  );
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Claude login was cancelled. This BB session was not changed.");
  }
}

export async function switchClaudeAccount(
  dependencies: AccountSwitchDependencies,
  request: AccountSwitchRequest,
  hostLocks: HostLockRegistry,
  signal: AbortSignal,
  lifecycle: AccountSwitchLifecycle = {},
): Promise<
  { outcome: "ready-next-message" } | { outcome: "login-changed-not-rebound" }
> {
  throwIfCancelled(signal);
  const initial = await classifySession(dependencies, request.threadId, signal);
  throwIfCancelled(signal);
  if (hostLocks.has(initial.hostId)) {
    throw new SwitchAdmissionError(
      "host-busy",
      "A Claude account switch is already open on this machine.",
    );
  }

  const hostLease = {};
  hostLocks.reserve(initial.hostId, hostLease);
  lifecycle.markAdmitted?.(initial.hostId);
  try {
    lifecycle.setStep?.("cleanup");
    await dependencies.reconcileCleanup(initial.hostId, signal);
    throwIfCancelled(signal);
    if (request.mode === "login") {
      lifecycle.setStep?.("login");
      let loginCommitted = false;
      try {
        await dependencies.login(request.threadId, initial.hostId, signal, () => {
          loginCommitted = true;
          lifecycle.markCommitted?.();
        });
      } catch (error) {
        if (loginCommitted) return { outcome: "login-changed-not-rebound" };
        throw error;
      }
    }

    try {
      lifecycle.setStep?.("verification");
      await dependencies.verifySubscription(request.threadId, initial.hostId, signal);
    } catch (error) {
      if (request.mode === "login") {
        return { outcome: "login-changed-not-rebound" };
      }
      throw error;
    }

    if (request.mode === "current") throwIfCancelled(signal);
    lifecycle.setStep?.("release");
    let current: SessionAction;
    try {
      current = await classifySession(dependencies, request.threadId, signal);
    } catch (error) {
      if (request.mode === "login") {
        return { outcome: "login-changed-not-rebound" };
      }
      throw error;
    }
    if (current.hostId !== initial.hostId) {
      if (request.mode === "login") {
        return { outcome: "login-changed-not-rebound" };
      }
      throw new Error("This session changed before BB could release it.");
    }

    if (request.mode === "current") {
      throwIfCancelled(signal);
      lifecycle.markCommitted?.();
    }
    try {
      await dependencies.stopThread(request.threadId);
    } catch {
      throw new Error(
        request.mode === "login"
          ? "The Claude login changed, but BB could not release this session. Its history is safe; try again."
          : "BB verified the Claude subscription login but could not release this session. Its history is safe; try again.",
      );
    }

    return { outcome: "ready-next-message" };
  } finally {
    hostLocks.release(initial.hostId, hostLease);
  }
}
