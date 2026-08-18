const CLAUDE_PROVIDER_ID = "claude-code";
const SAFE_RECOVERY_REASONS = new Set(["eligible", "manual-only"]);

export interface ThreadSnapshot {
  readonly providerId: string;
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
  login(threadId: string, signal: AbortSignal): Promise<void>;
  stopThread(threadId: string): Promise<void>;
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
    throw new Error(
      "Claude login was cancelled. This BB session was not changed.",
    );
  }
}

export async function switchClaudeAccount(
  dependencies: AccountSwitchDependencies,
  threadId: string,
  hostLocks: Set<string>,
  signal: AbortSignal,
): Promise<{ retrying: true }> {
  throwIfCancelled(signal);
  const thread = await dependencies.getThread(threadId);
  if (thread.providerId !== CLAUDE_PROVIDER_ID) {
    throw new Error("This button only works in Claude Code sessions.");
  }

  const initialRecovery = await dependencies.getRecovery(threadId);
  const failedRequestId = recoveryRequestId(initialRecovery);
  if (hostLocks.has(initialRecovery.hostId)) {
    throw new Error(
      "A Claude account switch is already open on this machine.",
    );
  }

  hostLocks.add(initialRecovery.hostId);
  try {
    throwIfCancelled(signal);
    await dependencies.login(threadId, signal);
    throwIfCancelled(signal);

    const currentRecovery = await dependencies.getRecovery(threadId);
    throwIfCancelled(signal);
    let currentFailedRequestId: string;
    try {
      currentFailedRequestId = recoveryRequestId(currentRecovery);
    } catch {
      throw new Error(
        "The Claude login changed, but this session is no longer safe to retry, so BB did not stop it.",
      );
    }
    if (currentFailedRequestId !== failedRequestId) {
      throw new Error(
        "The Claude login changed, but this session changed while you were signing in, so BB did not stop or retry it.",
      );
    }

    try {
      await dependencies.stopThread(threadId);
    } catch {
      throw new Error(
        "The Claude login changed, but BB could not release this session. Its history is safe; try again.",
      );
    }

    try {
      await dependencies.continueThread(threadId, failedRequestId);
    } catch {
      throw new Error(
        "The Claude login changed and BB released the old runtime, but the automatic retry could not start. Send a message in this session to resume with the new login.",
      );
    }

    return { retrying: true };
  } finally {
    hostLocks.delete(initialRecovery.hostId);
  }
}
