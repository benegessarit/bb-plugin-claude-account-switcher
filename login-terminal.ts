function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildClaudeLoginCommand(email: string): string {
  return `command claude auth login --claudeai --email ${shellQuote(email)} >/dev/null 2>&1`;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1_000;
const DEFAULT_POLL_MS = 500;

export interface LoginTerminal {
  readonly id: string;
  readonly status: "starting" | "running" | "exited" | "disconnected";
  readonly exitCode: number | null;
}

export interface LoginTerminalClient {
  close(terminalId: string, mode: "force" | "if-clean"): Promise<void>;
  create(threadId: string): Promise<LoginTerminal>;
  get(terminalId: string): Promise<LoginTerminal>;
  onSettled?(terminalId: string): void;
}

export interface LoginWaitOptions {
  readonly now?: () => number;
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
  const terminal = await client.create(threadId);
  const deadline = now() + timeoutMs;
  let closeMode: "force" | "if-clean" = "force";

  try {
    let current = terminal;
    while (true) {
      if (signal?.aborted) {
        throw new Error(
          "Claude login was cancelled. This BB session was not changed.",
        );
      }
      if (current.status === "exited") {
        closeMode = "if-clean";
        if (current.exitCode === 0) return;
        throw new Error(
          "Claude login did not finish successfully. This BB session was not changed.",
        );
      }
      if (current.status === "disconnected") {
        throw new Error(
          "Claude login was cancelled or its machine disconnected. This BB session was not changed.",
        );
      }
      if (now() >= deadline) {
        throw new Error(
          "Claude login timed out after 10 minutes. This BB session was not changed.",
        );
      }
      await waitForNextPoll(sleep, pollMs, signal);
      if (signal?.aborted) {
        throw new Error(
          "Claude login was cancelled. This BB session was not changed.",
        );
      }
      current = await client.get(terminal.id);
    }
  } finally {
    try {
      await client.close(terminal.id, closeMode);
    } catch {
      // Closing an already-exited helper terminal is best-effort cleanup. It
      // must not turn a successful login into a false failure.
    } finally {
      client.onSettled?.(terminal.id);
    }
  }
}
