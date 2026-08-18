function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function buildClaudeLoginCommand(email?: string): string {
  const emailArgument = email?.trim() ? ` --email ${shellQuote(email.trim())}` : "";
  return `command claude auth login --claudeai${emailArgument} >/dev/null 2>&1`;
}

export function buildClaudeAuthStatusCommand(phaseTimeoutMs = 30_000): string {
  if (!Number.isSafeInteger(phaseTimeoutMs) || phaseTimeoutMs <= 0) {
    throw new Error("Claude auth-status helper timeout must be a positive integer.");
  }
  const script = [
    'const {spawnSync}=require("node:child_process")',
    `const result=spawnSync("claude",["auth","status","--json"],{encoding:"utf8",killSignal:"SIGKILL",timeout:${phaseTimeoutMs}})`,
    "if(result.status!==0)process.exit(result.status??1)",
    `try{const status=JSON.parse(result.stdout);const fields=[["loggedIn",String(status.loggedIn)],["authMethod",status.authMethod],["apiProvider",status.apiProvider],["subscriptionType",status.subscriptionType]];if(fields.some(([,value])=>typeof value!=="string"||!/^[A-Za-z0-9._-]+$/.test(value)))process.exit(2);process.stdout.write(fields.map(([key,value])=>key+"="+value).join("\\n")+"\\n");setTimeout(()=>process.exit(3),${phaseTimeoutMs})}catch{process.exit(2)}`,
  ].join(";");
  return `command node -e ${shellQuote(script)} 2>/dev/null`;
}

export interface ClaudeAuthStatus {
  readonly loggedIn: true;
  readonly authMethod: "claude.ai";
  readonly apiProvider: "firstParty";
  readonly subscriptionType: string;
}

const AUTH_STATUS_ERROR =
  "The active Claude subscription login could not be verified on this session's machine.";

export function parseClaudeAuthStatus(output: string): ClaudeAuthStatus {
  const entries = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("="));
  if (
    entries.length !== 4 ||
    entries.some(
      (entry) =>
        entry.length !== 2 ||
        !entry[0] ||
        !entry[1] ||
        !/^[A-Za-z0-9._-]+$/.test(entry[1]),
    )
  ) {
    throw new Error(AUTH_STATUS_ERROR);
  }

  const fields = Object.fromEntries(entries);
  if (
    fields.loggedIn !== "true" ||
    fields.authMethod !== "claude.ai" ||
    fields.apiProvider !== "firstParty" ||
    !fields.subscriptionType
  ) {
    throw new Error(AUTH_STATUS_ERROR);
  }

  return {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
    subscriptionType: fields.subscriptionType,
  };
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

export interface AuthStatusTerminalClient extends LoginTerminalClient {
  output(terminalId: string): Promise<string>;
}

export interface LoginWaitOptions {
  readonly now?: () => number;
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
  const terminal = await client.create(threadId);
  const deadline = now() + timeoutMs;
  let closeMode: "force" | "if-clean" = "force";

  try {
    let current = terminal;
    while (true) {
      if (signal?.aborted) {
        throw new Error("Claude login was cancelled. This BB session was not changed.");
      }
      if (current.status === "exited") {
        closeMode = "if-clean";
        if (current.exitCode === 0) {
          options.onSuccess?.();
          return;
        }
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
        throw new Error("Claude login was cancelled. This BB session was not changed.");
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
  const terminal = await client.create(threadId);
  const deadline = now() + timeoutMs;

  try {
    let current = terminal;
    while (true) {
      if (signal?.aborted) throw new Error(AUTH_STATUS_ERROR);
      if (current.status === "running") {
        try {
          return parseClaudeAuthStatus(await client.output(terminal.id));
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
      current = await client.get(terminal.id);
    }
  } finally {
    try {
      await client.close(terminal.id, "force");
    } catch {
      // Best-effort cleanup must not hide the auth classification result.
    } finally {
      client.onSettled?.(terminal.id);
    }
  }
}
