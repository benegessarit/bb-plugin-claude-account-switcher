function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export const LOGIN_INPUT_READY_MARKER = "BB_CLAUDE_LOGIN_INPUT_READY";

function requireAbsoluteExecutablePath(value: string, error: string): string {
  if (!value.startsWith("/") || value.includes("\0")) {
    throw new Error(error);
  }
  return value;
}

function requireAbsoluteClaudePath(claudeExecutablePath: string): string {
  return requireAbsoluteExecutablePath(
    claudeExecutablePath,
    "BB could not resolve the installed Claude Code executable.",
  );
}

export function buildChromeIncognitoLauncher(browserExecutablePath?: string): string {
  if (browserExecutablePath !== undefined) {
    requireAbsoluteExecutablePath(
      browserExecutablePath,
      "BB could not resolve the Chrome executable.",
    );
  }

  const launch = (browser: string) =>
    `exec ${shellQuote(browser)} --incognito --new-window "$url" >/dev/null 2>&1`;
  const lines = [
    "#!/bin/sh",
    'url="${1-}"',
    'case "$url" in https://*) ;; *) exit 78 ;; esac',
  ];
  const fixedBrowserPaths = browserExecutablePath
    ? [browserExecutablePath]
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const browserPath of fixedBrowserPaths) {
    lines.push(
      `if test -x ${shellQuote(browserPath)}; then`,
      `  ${launch(browserPath)}`,
      "fi",
    );
  }
  if (!browserExecutablePath) {
    lines.push(
      'if test -n "${HOME:-}" && test -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; then',
      '  exec "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --incognito --new-window "$url" >/dev/null 2>&1',
      "fi",
      "for browser_name in google-chrome-stable google-chrome chromium chromium-browser; do",
      '  browser_path="$(command -v "$browser_name" 2>/dev/null || true)"',
      '  if test -n "$browser_path"; then',
      '    exec "$browser_path" --incognito --new-window "$url" >/dev/null 2>&1',
      "  fi",
      "done",
    );
  }
  lines.push("exit 78");
  return `${lines.join("\n")}\n`;
}

export interface ClaudeLoginCommandOptions {
  readonly browserExecutablePath?: string;
  readonly sttyExecutablePath?: string;
}

export function buildClaudeLoginCommand(
  claudeExecutablePath: string,
  options: ClaudeLoginCommandOptions = {},
): string {
  const executable = requireAbsoluteClaudePath(claudeExecutablePath);
  const browserLauncher = buildChromeIncognitoLauncher(options.browserExecutablePath);
  const sttyExecutable = requireAbsoluteExecutablePath(
    options.sttyExecutablePath ?? "/bin/stty",
    "BB could not resolve the stty executable.",
  );
  const script = [
    'mktemp_command=""',
    'for candidate in /usr/bin/mktemp /bin/mktemp; do if test -x "$candidate"; then mktemp_command="$candidate"; break; fi; done',
    'if test -z "$mktemp_command"; then mktemp_command="$(command -v mktemp 2>/dev/null || true)"; fi',
    'test -n "$mktemp_command" || exit 78',
    'browser_dir="$("$mktemp_command" -d "${TMPDIR:-/tmp}/bb-claude-login.XXXXXX")" || exit 78',
    'browser_launcher="$browser_dir/open-chrome-incognito"',
    `cleanup_login() { ${shellQuote(sttyExecutable)} echo >/dev/null 2>&1 || true; /bin/unlink "$browser_launcher" 2>/dev/null || true; /bin/rmdir "$browser_dir" 2>/dev/null || true; }`,
    "trap cleanup_login EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `/usr/bin/printf '%s' ${shellQuote(browserLauncher)} > "$browser_launcher" || exit 78`,
    '/bin/chmod 700 "$browser_launcher" || exit 78',
    `${shellQuote(sttyExecutable)} -echo >/dev/null 2>&1 || exit 79`,
    `printf '%s%s\\n' ${shellQuote("BB_CLAUDE_LOGIN_")} ${shellQuote("INPUT_READY")}`,
    `BROWSER="$browser_launcher" ${shellQuote(executable)} auth login --claudeai >/dev/null 2>&1`,
  ].join("; ");
  return `/bin/sh -c ${shellQuote(script)}`;
}

export function buildClaudeAuthStatusCommand(
  claudeExecutablePath: string,
  phaseTimeoutMs = 30_000,
): string {
  const executable = requireAbsoluteClaudePath(claudeExecutablePath);
  if (!Number.isSafeInteger(phaseTimeoutMs) || phaseTimeoutMs <= 0) {
    throw new Error("Claude auth-status helper timeout must be a positive integer.");
  }
  const script = [
    'const {spawnSync}=require("node:child_process")',
    `const result=spawnSync(${JSON.stringify(executable)},["auth","status","--json"],{encoding:"utf8",killSignal:"SIGKILL",timeout:${phaseTimeoutMs}})`,
    "if(result.status!==0)process.exit(result.status??1)",
    `try{const status=JSON.parse(result.stdout);const fields=[["loggedIn",String(status.loggedIn)],["authMethod",status.authMethod],["apiProvider",status.apiProvider]];if(fields.some(([,value])=>typeof value!=="string"||!/^[A-Za-z0-9._-]+$/.test(value)))process.exit(2);process.stdout.write(fields.map(([key,value])=>key+"="+value).join("\\n")+"\\n");setTimeout(()=>process.exit(3),${phaseTimeoutMs})}catch{process.exit(2)}`,
  ].join(";");
  return `command node -e ${shellQuote(script)} 2>/dev/null`;
}

export interface ClaudeAuthStatus {
  readonly loggedIn: true;
  readonly authMethod: "claude.ai";
  readonly apiProvider: "firstParty";
}

const AUTH_STATUS_ERROR =
  "The active Claude subscription login could not be verified on this session's machine.";

export function parseClaudeAuthStatus(output: string): ClaudeAuthStatus {
  const entries = output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split("="));
  if (
    entries.length !== 3 ||
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
    fields.apiProvider !== "firstParty"
  ) {
    throw new Error(AUTH_STATUS_ERROR);
  }

  return {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
  };
}

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
      if (!inputReady && current.status === "running" && client.output) {
        try {
          const output = await client.output(terminal.id, signal);
          if (output.includes(LOGIN_INPUT_READY_MARKER)) {
            inputReady = true;
            options.onInputReady?.(terminal.id);
          }
        } catch {
          // BB may briefly reject output while the command starts. The marker
          // is the only output the login helper permits, so retrying is safe.
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
      await client.close(terminal.id, "force");
      await client.onSettled?.(terminal.id);
    } catch {
      // Best-effort cleanup must not hide the auth classification result. A
      // failed close stays owned so plugin disposal can retry it.
      await client.onCleanupFailed?.(terminal.id, terminal.hostId);
    }
  }
}
