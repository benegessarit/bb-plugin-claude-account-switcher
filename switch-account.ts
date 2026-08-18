const CLAUDE_PROVIDER_ID = "claude-code";
const SAFE_RECOVERY_REASONS = new Set(["eligible", "manual-only"]);

export interface ThreadSnapshot {
  readonly providerId: string;
  readonly status?: "active" | "starting" | "idle" | "stopping" | "error";
  readonly environment?: { readonly hostId: string } | null;
}

export interface RecoverySnapshot {
  readonly reason: string;
  readonly hostId: string;
  readonly candidate: {
    readonly failedRequestId: string;
    readonly rateLimits: { readonly providerId: string };
  } | null;
}

export interface AccountSwitchDependencies {
  continueThread(threadId: string, failedRequestId: string): Promise<void>;
  getRecovery(threadId: string): Promise<RecoverySnapshot>;
  getThread(threadId: string): Promise<ThreadSnapshot>;
  login(threadId: string, signal: AbortSignal, onSuccess?: () => void): Promise<void>;
  stopThread(threadId: string): Promise<void>;
  verifySubscription(threadId: string, hostId: string): Promise<void>;
}

export interface AccountSwitchRequest {
  readonly mode: "current" | "login";
  readonly threadId: string;
}

export interface AccountSwitchLifecycle {
  markCommitted(): void;
}

interface SessionAction {
  readonly hostId: string;
  readonly failedRequestId?: string;
}

async function classifySession(
  dependencies: AccountSwitchDependencies,
  threadId: string,
): Promise<SessionAction> {
  const thread = await dependencies.getThread(threadId);
  if (thread.providerId !== CLAUDE_PROVIDER_ID) {
    throw new Error("This button only works in Claude Code sessions.");
  }
  const hostId = thread.environment?.hostId;
  if (!hostId) {
    throw new Error("BB could not identify this session's machine.");
  }
  if (thread.status === "idle") return { hostId };
  if (
    thread.status === "active" ||
    thread.status === "starting" ||
    thread.status === "stopping"
  ) {
    throw new Error(
      "Wait for this session to become idle before switching its Claude login.",
    );
  }
  if (thread.status !== "error") {
    throw new Error("This session is not ready to rebind.");
  }

  const recovery = await dependencies.getRecovery(threadId);
  if (recovery.hostId !== hostId) {
    throw new Error("This session's machine changed before BB could rebind it.");
  }
  if (recovery.reason === "provider-will-retry") {
    throw new Error("Claude is already scheduled to retry this session automatically.");
  }
  try {
    return { hostId, failedRequestId: recoveryRequestId(recovery) };
  } catch {
    return { hostId };
  }
}

function recoveryRequestId(recovery: RecoverySnapshot): string {
  const candidate = recovery.candidate;
  if (
    candidate === null ||
    candidate.rateLimits.providerId !== CLAUDE_PROVIDER_ID ||
    !SAFE_RECOVERY_REASONS.has(recovery.reason)
  ) {
    throw new Error(
      "This session does not have a safe Claude subscription-limit retry ready.",
    );
  }
  return candidate.failedRequestId;
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error("Claude login was cancelled. This BB session was not changed.");
  }
}

export async function switchClaudeAccount(
  dependencies: AccountSwitchDependencies,
  request: AccountSwitchRequest,
  hostLocks: Set<string>,
  signal: AbortSignal,
  lifecycle: AccountSwitchLifecycle = { markCommitted: () => undefined },
): Promise<
  | { outcome: "ready-next-message" }
  | { outcome: "retried" }
  | { outcome: "login-changed-not-rebound" }
> {
  throwIfCancelled(signal);
  const initial = await classifySession(dependencies, request.threadId);
  if (hostLocks.has(initial.hostId)) {
    throw new Error("A Claude account switch is already open on this machine.");
  }

  hostLocks.add(initial.hostId);
  try {
    if (request.mode === "login") {
      await dependencies.login(request.threadId, signal, lifecycle.markCommitted);
    }

    try {
      await dependencies.verifySubscription(request.threadId, initial.hostId);
    } catch (error) {
      if (request.mode === "login") {
        return { outcome: "login-changed-not-rebound" };
      }
      throw error;
    }

    if (request.mode === "current") throwIfCancelled(signal);
    let current: SessionAction;
    try {
      current = await classifySession(dependencies, request.threadId);
    } catch (error) {
      if (request.mode === "login") {
        return { outcome: "login-changed-not-rebound" };
      }
      throw error;
    }
    if (
      current.hostId !== initial.hostId ||
      current.failedRequestId !== initial.failedRequestId
    ) {
      if (request.mode === "login") {
        return { outcome: "login-changed-not-rebound" };
      }
      throw new Error("This session changed before BB could release it.");
    }

    if (request.mode === "current") {
      throwIfCancelled(signal);
      lifecycle.markCommitted();
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

    if (current.failedRequestId) {
      try {
        await dependencies.continueThread(request.threadId, current.failedRequestId);
      } catch {
        throw new Error(
          "BB released the old Claude runtime, but the failed turn could not restart. Send a message in this session to resume with the verified login.",
        );
      }
      return { outcome: "retried" };
    }
    return { outcome: "ready-next-message" };
  } finally {
    hostLocks.delete(initial.hostId);
  }
}
