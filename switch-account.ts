const CLAUDE_PROVIDER_ID = "claude-code";

export interface ThreadSnapshot {
  readonly providerId: string;
  readonly status?: "active" | "starting" | "idle" | "stopping" | "error";
  readonly environment?: { readonly hostId: string } | null;
}

export interface AccountSwitchDependencies {
  getThread(threadId: string): Promise<ThreadSnapshot>;
  login(
    threadId: string,
    hostId: string,
    signal: AbortSignal,
    onSuccess?: () => void,
  ): Promise<void>;
  reconcileCleanup(hostId: string): Promise<void>;
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
  if (thread.status === "idle" || thread.status === "error") return { hostId };
  if (
    thread.status === "active" ||
    thread.status === "starting" ||
    thread.status === "stopping"
  ) {
    throw new Error(
      "Wait for this session to become idle before switching its Claude login.",
    );
  }
  throw new Error("This session is not ready to rebind.");
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
  { outcome: "ready-next-message" } | { outcome: "login-changed-not-rebound" }
> {
  throwIfCancelled(signal);
  const initial = await classifySession(dependencies, request.threadId);
  throwIfCancelled(signal);
  if (hostLocks.has(initial.hostId)) {
    throw new Error("A Claude account switch is already open on this machine.");
  }

  hostLocks.add(initial.hostId);
  try {
    await dependencies.reconcileCleanup(initial.hostId);
    throwIfCancelled(signal);
    if (request.mode === "login") {
      let loginCommitted = false;
      try {
        await dependencies.login(request.threadId, initial.hostId, signal, () => {
          loginCommitted = true;
          lifecycle.markCommitted();
        });
      } catch (error) {
        if (loginCommitted) return { outcome: "login-changed-not-rebound" };
        throw error;
      }
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
    if (current.hostId !== initial.hostId) {
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

    return { outcome: "ready-next-message" };
  } finally {
    hostLocks.delete(initial.hostId);
  }
}
