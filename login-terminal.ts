import {
  AUTHORIZATION_NOT_READY_EXIT_CODE,
  AUTH_STATUS_ERROR,
  LOGIN_BROWSER_FAILED_MARKER,
  LOGIN_INPUT_READY_MARKER,
  authorizationLauncherFromOutput,
  parseClaudeAuthStatus,
  type ClaudeAuthStatus,
} from "./login-host-command.ts";
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_MS = 500;

export interface LoginTerminal {
  readonly hostId: string;
  readonly id: string;
  readonly status: "starting" | "running" | "exited" | "disconnected";
  readonly exitCode: number | null;
}

export interface LoginTerminalClient {
  close(terminalId: string, mode: "force" | "if-clean"): Promise<LoginTerminal>;
  create(threadId: string): Promise<LoginTerminal>;
  get(terminalId: string, signal?: AbortSignal): Promise<LoginTerminal>;
  onCleanupFailed?(terminalId: string, hostId: string): Promise<void> | void;
  onSettled?(terminalId: string): Promise<void> | void;
  output?(terminalId: string, signal?: AbortSignal): Promise<string>;
}

export interface AuthStatusTerminalClient extends LoginTerminalClient {
  output(terminalId: string, signal?: AbortSignal): Promise<string>;
}

export interface LoginWaitOptions {
  readonly now?: () => number;
  readonly onAuthorizationReady?: (terminalId: string, launcherPath: string) => void;
  readonly onInputReady?: (terminalId: string) => void;
  readonly onSuccess?: () => void;
  readonly pollMs?: number;
  readonly signal?: AbortSignal;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timeoutMs?: number;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForNextPoll(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await sleep(milliseconds);
    return;
  }
  if (signal.aborted) return;

  let wakeForAbort!: () => void;
  const aborted = new Promise<void>((resolve) => {
    wakeForAbort = resolve;
  });
  signal.addEventListener("abort", wakeForAbort, { once: true });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    signal.removeEventListener("abort", wakeForAbort);
  }
}

export async function runClaudeLogin(
  client: LoginTerminalClient,
  threadId: string,
  options: LoginWaitOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const signal = options.signal;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (signal?.aborted) {
    throw new Error("Claude login was cancelled. This BB session was not changed.");
  }
  const terminal = await client.create(threadId);
  const deadline = now() + timeoutMs;
  let closeMode: "force" | "if-clean" = "force";
  let committed = false;
  let completionKnown = false;
  let authorizationReady = false;
  let inputReady = false;
  let outcomeError: Error | undefined;

  const markCommitted = () => {
    if (committed) return;
    committed = true;
    options.onSuccess?.();
  };

  try {
    let current = terminal;
    while (true) {
      if (
        (!inputReady ||
          (!authorizationReady && options.onAuthorizationReady !== undefined)) &&
        current.status === "running" &&
        client.output
      ) {
        let output: string | undefined;
        try {
          output = await client.output(terminal.id, signal);
        } catch {
          // BB may briefly reject output while the command starts. Retrying is safe.
        }
        if (output !== undefined) {
          if (output.includes(LOGIN_BROWSER_FAILED_MARKER)) {
            outcomeError = new Error(
              "BB could not open Chrome for Claude sign-in. This BB session was not changed.",
            );
            break;
          }
          if (!inputReady && output.includes(LOGIN_INPUT_READY_MARKER)) {
            inputReady = true;
            options.onInputReady?.(terminal.id);
          }
          if (!authorizationReady && options.onAuthorizationReady !== undefined) {
            const launcherPath = authorizationLauncherFromOutput(output);
            if (launcherPath !== undefined) {
              authorizationReady = true;
              options.onAuthorizationReady(terminal.id, launcherPath);
            }
          }
        }
      }
      if (current.status === "exited") {
        completionKnown = true;
        closeMode = "if-clean";
        if (current.exitCode === 0) {
          markCommitted();
        } else {
          outcomeError = new Error(
            "Claude login did not finish successfully. This BB session was not changed.",
          );
        }
        break;
      }
      if (current.status === "disconnected") {
        outcomeError = new Error(
          "Claude login was cancelled or its machine disconnected. This BB session was not changed.",
        );
        break;
      }
      if (signal?.aborted) {
        outcomeError = new Error(
          "Claude login was cancelled. This BB session was not changed.",
        );
        break;
      }
      if (now() >= deadline) {
        outcomeError = new Error(
          "Claude login timed out after 10 minutes. This BB session was not changed.",
        );
        break;
      }
      await waitForNextPoll(sleep, pollMs, signal);
      if (signal?.aborted) {
        outcomeError = new Error(
          "Claude login was cancelled. This BB session was not changed.",
        );
        break;
      }
      current = await client.get(terminal.id, signal);
    }
  } catch (error) {
    outcomeError =
      error instanceof Error
        ? error
        : new Error("Claude login could not be observed safely.");
  }

  let closed: LoginTerminal | undefined;
  try {
    closed = await client.close(terminal.id, closeMode);
    if (closed.status === "exited") {
      completionKnown = true;
      if (closed.exitCode === 0) {
        markCommitted();
        outcomeError = undefined;
      }
      await client.onSettled?.(terminal.id);
    } else {
      if (!completionKnown) markCommitted();
      await client.onCleanupFailed?.(terminal.id, terminal.hostId);
    }
  } catch {
    if (!completionKnown && closed === undefined) {
      // A failed atomic close cannot prove that the machine-wide login stayed
      // unchanged. Treat it as potentially committed and never release the
      // selected runtime on this ambiguous path.
      markCommitted();
    }
    await client.onCleanupFailed?.(terminal.id, terminal.hostId);
  }

  if (outcomeError) throw outcomeError;
}

export async function runClaudeAuthorizationReopen(
  client: LoginTerminalClient,
  threadId: string,
  options: Pick<
    LoginWaitOptions,
    "now" | "pollMs" | "signal" | "sleep" | "timeoutMs"
  > = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const signal = options.signal;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (signal?.aborted) {
    throw new Error("Returning to Claude authorization was cancelled.");
  }

  const terminal = await client.create(threadId);
  const deadline = now() + timeoutMs;
  let closeMode: "force" | "if-clean" = "force";
  let outcomeError: Error | undefined;

  try {
    let current = terminal;
    while (true) {
      if (current.status === "exited") {
        closeMode = "if-clean";
        if (current.exitCode === 0) break;
        outcomeError =
          current.exitCode === AUTHORIZATION_NOT_READY_EXIT_CODE
            ? new Error(
                "Claude has not opened the authorization page yet. Wait a moment and try again.",
              )
            : new Error("BB could not return to the pending Claude authorization.");
        break;
      }
      if (current.status === "disconnected") {
        outcomeError = new Error(
          "The Claude authorization helper could not be confirmed stopped.",
        );
        break;
      }
      if (signal?.aborted) {
        outcomeError = new Error("Returning to Claude authorization was cancelled.");
        break;
      }
      if (now() >= deadline) {
        outcomeError = new Error(
          "The Claude authorization helper could not be confirmed stopped.",
        );
        break;
      }
      await waitForNextPoll(sleep, pollMs, signal);
      current = await client.get(terminal.id, signal);
    }
  } catch (error) {
    outcomeError =
      error instanceof Error
        ? error
        : new Error("BB could not return to the pending Claude authorization.");
  }

  try {
    const closed = await client.close(terminal.id, closeMode);
    if (closed.status === "exited") {
      await client.onSettled?.(terminal.id);
    } else {
      await client.onCleanupFailed?.(terminal.id, terminal.hostId);
      outcomeError ??= new Error(
        "The Claude authorization helper could not be confirmed stopped.",
      );
    }
  } catch {
    await client.onCleanupFailed?.(terminal.id, terminal.hostId);
    outcomeError ??= new Error(
      "The Claude authorization helper could not be confirmed stopped.",
    );
  }

  if (outcomeError) throw outcomeError;
}

export async function runClaudeAuthStatus(
  client: AuthStatusTerminalClient,
  threadId: string,
  options: LoginWaitOptions = {},
): Promise<ClaudeAuthStatus> {
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const signal = options.signal;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (signal?.aborted) throw new Error(AUTH_STATUS_ERROR);
  const terminal = await client.create(threadId);
  const deadline = now() + timeoutMs;

  try {
    let current = terminal;
    while (true) {
      if (signal?.aborted) throw new Error(AUTH_STATUS_ERROR);
      if (current.status === "running") {
        try {
          return parseClaudeAuthStatus(await client.output(terminal.id, signal));
        } catch {
          // The filtered result may not be in scrollback yet, or the helper may
          // have exited between the status read and the output request.
        }
      }
      if (current.status === "exited") {
        throw new Error(AUTH_STATUS_ERROR);
      }
      if (current.status === "disconnected" || now() >= deadline) {
        throw new Error(AUTH_STATUS_ERROR);
      }
      await waitForNextPoll(sleep, pollMs, signal);
      if (signal?.aborted) throw new Error(AUTH_STATUS_ERROR);
      current = await client.get(terminal.id, signal);
    }
  } finally {
    try {
      const closed = await client.close(terminal.id, "force");
      if (closed.status === "exited") {
        await client.onSettled?.(terminal.id);
      } else {
        await client.onCleanupFailed?.(terminal.id, terminal.hostId);
      }
    } catch {
      // Best-effort cleanup must not hide the auth classification result. A
      // failed close stays owned so plugin disposal can retry it.
      await client.onCleanupFailed?.(terminal.id, terminal.hostId);
    }
  }
}
