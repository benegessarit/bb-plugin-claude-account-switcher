function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

const PRIVATE_BROWSER_SCRIPT = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { accessSync, chmodSync, constants, mkdtempSync, rmSync } = require("node:fs");
const { delimiter, dirname, isAbsolute, join, resolve } = require("node:path");
const { homedir, tmpdir } = require("node:os");

function executablePath(command) {
  const candidates =
    isAbsolute(command) || command.includes("/")
      ? [resolve(command)]
      : (process.env.PATH || "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => join(directory, command));
  return candidates.find((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function findBrowser() {
  const override = process.env.BB_CLAUDE_LOGIN_BROWSER;
  if (override) return executablePath(override);

  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          join(homedir(), "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
          join(homedir(), "Applications/Chromium.app/Contents/MacOS/Chromium"),
        ]
      : process.platform === "linux"
        ? ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]
        : [];
  return candidates.map(executablePath).find(Boolean);
}

function removeOwnedProfile(profileRoot) {
  const base = resolve(tmpdir());
  const target = resolve(profileRoot);
  if (dirname(target) !== base || !target.startsWith(join(base, "bb-claude-browser-"))) {
    return;
  }
  try {
    rmSync(target, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 });
  } catch {}
}

function watchAndRemoveProfile(profileRoot, browserPid) {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const base = path.resolve(os.tmpdir());
  const target = path.resolve(profileRoot);
  if (
    path.dirname(target) !== base ||
    !path.basename(target).startsWith("bb-claude-browser-") ||
    !Number.isSafeInteger(browserPid) ||
    browserPid <= 0
  ) {
    process.exit(78);
  }

  const browserIsRunning = () => {
    try {
      process.kill(browserPid, 0);
      return true;
    } catch {
      return false;
    }
  };
  let lastActiveAt = Date.now();
  const cleanupTimer = setInterval(() => {
    if (browserIsRunning() || fs.existsSync(path.join(target, "SingletonLock"))) {
      lastActiveAt = Date.now();
      return;
    }
    if (Date.now() - lastActiveAt < 750) return;
    try {
      fs.rmSync(target, {
        force: true,
        maxRetries: 3,
        recursive: true,
        retryDelay: 100,
      });
      clearInterval(cleanupTimer);
      process.exit(0);
    } catch {
      // Keep ownership and retry until this exact temporary profile is gone.
    }
  }, 100);
}

const browserPath = findBrowser();
if (!browserPath) process.exit(78);
if (process.argv[2] === "--check") process.exit(0);
const targetUrl = process.argv[2];
if (!targetUrl) process.exit(78);

const profileRoot = mkdtempSync(join(tmpdir(), "bb-claude-browser-"));
chmodSync(profileRoot, 0o700);
const browser = spawn(
  browserPath,
  [
    "--user-data-dir=" + profileRoot,
    "--incognito",
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    targetUrl,
  ],
  { detached: true, stdio: "ignore" },
);

const fail = () => {
  removeOwnedProfile(profileRoot);
  process.exit(78);
};
browser.once("error", fail);
browser.once("spawn", () => {
  const watcherSource =
    "(" + watchAndRemoveProfile.toString() + ")(process.argv[1],Number(process.argv[2]))";
  const watcher = spawn(
    process.execPath,
    ["-e", watcherSource, profileRoot, String(browser.pid)],
    { detached: true, stdio: "ignore" },
  );
  watcher.once("error", () => {
    browser.kill();
    fail();
  });
  watcher.once("spawn", () => {
    watcher.unref();
    browser.unref();
    process.exit(0);
  });
});
`;

export function buildClaudeLoginCommand(email?: string): string {
  const emailArgument = email?.trim() ? ` --email ${shellQuote(email.trim())}` : "";
  return [
    'browser_dir="$(/usr/bin/mktemp -d "${TMPDIR:-/tmp}/bb-claude-login.XXXXXX")"',
    'browser_launcher="$browser_dir/open-private-chrome"',
    'cleanup_browser_launcher() { /bin/unlink "$browser_launcher" 2>/dev/null || true; /bin/rmdir "$browser_dir" 2>/dev/null || true; }',
    "trap cleanup_browser_launcher EXIT",
    `/usr/bin/printf '%s' ${shellQuote(PRIVATE_BROWSER_SCRIPT)} > "$browser_launcher"`,
    '/bin/chmod 700 "$browser_launcher"',
    '("$browser_launcher" --check || exit 78)',
    `BROWSER="$browser_launcher" command claude auth login --claudeai${emailArgument} >/dev/null 2>&1`,
  ].join(" && ");
}

export function buildClaudeAuthStatusCommand(phaseTimeoutMs = 30_000): string {
  if (!Number.isSafeInteger(phaseTimeoutMs) || phaseTimeoutMs <= 0) {
    throw new Error("Claude auth-status helper timeout must be a positive integer.");
  }
  const script = [
    'const {spawnSync}=require("node:child_process")',
    `const result=spawnSync("claude",["auth","status","--json"],{encoding:"utf8",killSignal:"SIGKILL",timeout:${phaseTimeoutMs}})`,
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
  close(terminalId: string, mode: "force" | "if-clean"): Promise<void>;
  create(threadId: string): Promise<LoginTerminal>;
  get(terminalId: string): Promise<LoginTerminal>;
  onCleanupFailed?(terminalId: string, hostId: string): Promise<void> | void;
  onSettled?(terminalId: string): Promise<void> | void;
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
  if (signal?.aborted) {
    throw new Error("Claude login was cancelled. This BB session was not changed.");
  }
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
        if (current.exitCode === 78) {
          throw new Error(
            "Account-changing login requires Google Chrome or Chromium on this session's macOS or Linux machine. This BB session was not changed.",
          );
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
      await client.onSettled?.(terminal.id);
    } catch {
      // Closing an already-exited helper terminal is best-effort cleanup. It
      // must not turn a successful login into a false failure. A failed close
      // stays owned so plugin disposal can retry it.
      await client.onCleanupFailed?.(terminal.id, terminal.hostId);
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
  if (signal?.aborted) throw new Error(AUTH_STATUS_ERROR);
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
      await client.onSettled?.(terminal.id);
    } catch {
      // Best-effort cleanup must not hide the auth classification result. A
      // failed close stays owned so plugin disposal can retry it.
      await client.onCleanupFailed?.(terminal.id, terminal.hostId);
    }
  }
}
