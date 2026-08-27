import { gzipSync } from "node:zlib";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export const LOGIN_INPUT_READY_MARKER = "BB_CLAUDE_LOGIN_INPUT_READY";
export const LOGIN_AUTHORIZATION_READY_MARKER = "BB_CLAUDE_LOGIN_AUTHORIZATION_READY:";
export const LOGIN_BROWSER_FAILED_MARKER = "BB_CLAUDE_LOGIN_BROWSER_FAILED";

const AUTHORIZATION_REOPEN_ARGUMENT = "--bb-reopen-authorization";
const AUTHORIZATION_OPEN_ARGUMENT = "--bb-open-authorization";
const AUTHORIZATION_NOT_READY_EXIT_CODE = 75;
const AUTHORIZATION_HELPER_ERROR_EXIT_CODE = 78;
const BB_TERMINAL_COMMAND_MAX_CHARACTERS = 10_000;
const CLAUDE_MANUAL_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback";
const MANUAL_AUTHORIZATION_FALLBACK_DELAY_MS = 500;

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

function requireAuthorizationLauncherPath(value: string): string {
  requireAbsoluteExecutablePath(
    value,
    "The Claude authorization helper path was invalid.",
  );
  if (value.length > 4_096 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Error("The Claude authorization helper path was invalid.");
  }
  const segments = value.split("/");
  const launcherName = segments.at(-1);
  const directoryName = segments.at(-2);
  if (
    launcherName !== "open-chrome-incognito" ||
    !directoryName ||
    !/^bb-claude-login\.[A-Za-z0-9]+$/.test(directoryName)
  ) {
    throw new Error("The Claude authorization helper path was invalid.");
  }
  return value;
}

function authorizationLauncherFromOutput(output: string): string | undefined {
  let launcherPath: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith(LOGIN_AUTHORIZATION_READY_MARKER)) continue;
    const candidate = requireAuthorizationLauncherPath(
      line.slice(LOGIN_AUTHORIZATION_READY_MARKER.length),
    );
    if (launcherPath !== undefined && launcherPath !== candidate) {
      throw new Error("The Claude authorization helper path was invalid.");
    }
    launcherPath = candidate;
  }
  return launcherPath;
}

function buildAuthorizationUrlValidator(): string {
  return [
    `const manualRedirectUri=${JSON.stringify(CLAUDE_MANUAL_REDIRECT_URI)}`,
    "const isLoopbackRedirect=(raw)=>{const match=/^http:\\/\\/localhost:([1-9][0-9]{0,4})\\/callback$/.exec(raw);return !!match&&Number(match[1])<=65535}",
    "const authorizationUrlKind=(raw)=>{",
    'if(typeof raw!=="string"||/[\\u0000-\\u001f\\u007f]/.test(raw))return',
    "let url",
    "try{url=new URL(raw)}catch{return}",
    'if(url.protocol!=="https:"||url.hostname!=="claude.com"||url.port!==""||url.username!==""||url.password!==""||url.pathname!=="/cai/oauth/authorize")return',
    'const single=(name)=>{const values=url.searchParams.getAll(name);return values.length===1&&values[0]!==""?values[0]:undefined}',
    'const redirectUri=single("redirect_uri")',
    'if(single("response_type")!=="code"||!single("client_id")||!single("scope")||!single("state")||!single("code_challenge")||single("code_challenge_method")!=="S256")return',
    'if(redirectUri===manualRedirectUri)return "manual"',
    'if(isLoopbackRedirect(redirectUri))return "loopback"',
    "}",
    "const isAuthorizationUrl=(raw)=>authorizationUrlKind(raw)!==undefined",
  ].join(";");
}

export function buildChromeIncognitoLauncher(browserExecutablePath?: string): string {
  if (browserExecutablePath !== undefined) {
    requireAbsoluteExecutablePath(
      browserExecutablePath,
      "BB could not resolve the Chrome executable.",
    );
  }

  const cleanupManualCapture =
    '/bin/unlink "$claim" 2>/dev/null || true; /bin/unlink "$manual_file" 2>/dev/null || true; /bin/unlink "$manual_pending" 2>/dev/null || true';
  const cleanupLoopbackCapture =
    '/bin/unlink "$loopback_claim" 2>/dev/null || true; /bin/unlink "$loopback_file" 2>/dev/null || true; /bin/unlink "$loopback_pending" 2>/dev/null || true';
  const launch = (browser: string) => [
    `exec ${shellQuote(browser)} --incognito "$url" >/dev/null 2>&1`,
    `exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
  ];
  const classifyUrl = `${buildAuthorizationUrlValidator()};const kind=authorizationUrlKind(process.argv[1]);if(!kind)process.exit(1);process.stdout.write(kind)`;
  const lines = [
    "#!/bin/sh",
    'claim="${0}.captured"',
    'loopback_claim="${0}.loopback-captured"',
    'loopback_file="${0}.loopback-url"',
    'loopback_pending="${0}.loopback-url.pending"',
    'manual_file="${0}.manual-url"',
    'manual_pending="${0}.manual-url.pending"',
    'write_url() { /usr/bin/printf \'%s\\n\' "$3" > "$2" && /bin/mv "$2" "$1"; }',
    "initial=false",
    `if test "\${1-}" = ${shellQuote(AUTHORIZATION_REOPEN_ARGUMENT)}; then`,
    `  test "$#" -eq 1 || exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
    '  if test -r "$loopback_file"; then',
    `    IFS= read -r url < "$loopback_file" || exit ${AUTHORIZATION_NOT_READY_EXIT_CODE}`,
    '  elif test -r "$manual_file"; then',
    `    IFS= read -r url < "$manual_file" || exit ${AUTHORIZATION_NOT_READY_EXIT_CODE}`,
    "  else",
    `    exit ${AUTHORIZATION_NOT_READY_EXIT_CODE}`,
    "  fi",
    `elif test "\${1-}" = ${shellQuote(AUTHORIZATION_OPEN_ARGUMENT)}; then`,
    `  test "$#" -eq 2 || exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
    '  url="${2-}"',
    "else",
    `  test "$#" -eq 1 || exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
    '  url="${1-}"',
    "  initial=true",
    "fi",
    `kind="$(command node -e ${shellQuote(classifyUrl)} "$url" 2>/dev/null)" || exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
    `test "$kind" = manual || test "$kind" = loopback || exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
    'if test "$initial" = true; then',
    "  umask 077",
    '  if test "$kind" = loopback; then',
    '    (set -C; : > "$loopback_claim") 2>/dev/null || exit 0',
    `    write_url "$loopback_file" "$loopback_pending" "$url" || { ${cleanupLoopbackCapture}; exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}; }`,
    "    exit 0",
    "  fi",
    '  (set -C; : > "$claim") 2>/dev/null || exit 0',
    `  write_url "$manual_file" "$manual_pending" "$url" || { ${cleanupManualCapture}; exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}; }`,
    "  exit 0",
    "fi",
  ];
  const fixedBrowserPaths = browserExecutablePath
    ? [browserExecutablePath]
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  for (const browserPath of fixedBrowserPaths) {
    lines.push(
      `if test -x ${shellQuote(browserPath)}; then`,
      ...launch(browserPath).map((line) => `  ${line}`),
      "fi",
    );
  }
  if (!browserExecutablePath) {
    lines.push(
      'if test -n "${HOME:-}" && test -x "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; then',
      '  exec "$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --incognito "$url" >/dev/null 2>&1',
      `  exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
      "fi",
      "for browser_name in google-chrome-stable google-chrome chromium chromium-browser; do",
      '  browser_path="$(command -v "$browser_name" 2>/dev/null || true)"',
      '  if test -n "$browser_path"; then',
      '    exec "$browser_path" --incognito "$url" >/dev/null 2>&1',
      `    exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
      "  fi",
      "done",
    );
  }
  lines.push(`exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`);
  return `${lines.join("\n")}\n`;
}

export interface ClaudeLoginCommandOptions {
  readonly browserExecutablePath?: string;
  readonly sttyExecutablePath?: string;
}

function buildClaudeLoginObserver(): string {
  return [
    'const fs=require("node:fs")',
    'const {spawn}=require("node:child_process")',
    'const {stripVTControlCharacters}=require("node:util")',
    "const executable=process.argv[1]",
    "const launcher=process.argv[2]",
    "const LF=String.fromCharCode(10)",
    "const CR=String.fromCharCode(13)",
    `const fallbackDelayMs=${MANUAL_AUTHORIZATION_FALLBACK_DELAY_MS}`,
    'const loopbackFile=launcher+".loopback-url"',
    'const manualFile=launcher+".manual-url"',
    `const authorizationMarker=${JSON.stringify(LOGIN_AUTHORIZATION_READY_MARKER)}`,
    `const browserFailureMarker=${JSON.stringify(LOGIN_BROWSER_FAILED_MARKER)}`,
    `const openArgument=${JSON.stringify(AUTHORIZATION_OPEN_ARGUMENT)}`,
    buildAuthorizationUrlValidator(),
    'const isUriLine=(value)=>value!==""&&Array.from(value).every((character)=>{const code=character.charCodeAt(0);return code>32&&code!==127&&character!=="\\\""&&character!=="<"&&character!==">"})',
    'const authorizationFrom=(value)=>{const clean=stripVTControlCharacters(value).split(CR).join("");const start=clean.lastIndexOf("https://claude.com/cai/oauth/authorize?");if(start<0)return;const lines=clean.slice(start).split(LF);if(lines.length<2)return;let candidate=lines[0].trim();for(let index=1;index<lines.length-1;index++){const part=lines[index].trim();if(!isUriLine(part))break;candidate+=part}return isAuthorizationUrl(candidate)?candidate:undefined}',
    'let tail=""',
    "let fallbackAuthorizationUrl",
    "let fallbackReadyAt=0",
    "let announced=false",
    "let captureStarted=false",
    "const openedAuthorizationUrls=new Set()",
    "let pendingBrowsers=0",
    "let launchFailed=false",
    "let claudeClosed=false",
    "let claudeExitCode=1",
    "let finishDeadline=0",
    "let timer",
    'const readAuthorization=(path)=>{try{const url=fs.readFileSync(path,"utf8").trim();return isAuthorizationUrl(url)?url:undefined}catch{return}}',
    "const selectedAuthorization=()=>{try{fs.accessSync(loopbackFile,fs.constants.R_OK);return readAuthorization(loopbackFile)}catch{return readAuthorization(manualFile)}}",
    "const announce=()=>{if(announced||!selectedAuthorization())return;announced=true;process.stdout.write(authorizationMarker+launcher+LF)}",
    'const signalExitCode=(signal)=>signal==="SIGHUP"?129:signal==="SIGINT"?130:signal==="SIGTERM"?143:1',
    "const fallbackPending=()=>!!fallbackAuthorizationUrl&&!captureStarted&&!selectedAuthorization()&&Date.now()<fallbackReadyAt",
    "const finish=()=>{captureFallback();launchBrowser();announce();if(!claudeClosed)return;if((fallbackPending()||(captureStarted&&!announced)||pendingBrowsers>0)&&!launchFailed&&Date.now()<finishDeadline)return;clearInterval(timer);process.exitCode=launchFailed?78:claudeExitCode}",
    "let child",
    'const failLaunch=()=>{if(launchFailed)return;launchFailed=true;process.stdout.write(browserFailureMarker+LF);if(!claudeClosed)child.kill("SIGTERM");finish()}',
    'const launchBrowser=()=>{const authorizationUrl=selectedAuthorization();if(!authorizationUrl||openedAuthorizationUrls.has(authorizationUrl))return;openedAuthorizationUrls.add(authorizationUrl);pendingBrowsers+=1;const browser=spawn(launcher,[openArgument,authorizationUrl],{detached:true,stdio:"ignore"});browser.unref();let settled=false;const settle=(failed)=>{if(settled)return;settled=true;pendingBrowsers-=1;if(failed)failLaunch();else finish()};browser.once("error",()=>settle(true));browser.once("exit",(code)=>settle(code!==0))}',
    'const captureAuthorization=(url)=>{captureStarted=true;const capture=spawn(launcher,[url],{detached:true,stdio:"ignore"});capture.unref();capture.once("error",failLaunch);capture.once("exit",(code)=>{if(code!==0)failLaunch();else finish()})}',
    "const captureFallback=()=>{if(captureStarted||!fallbackAuthorizationUrl||Date.now()<fallbackReadyAt||selectedAuthorization())return;captureAuthorization(fallbackAuthorizationUrl)}",
    'const inspect=(chunk)=>{tail=(tail+chunk.toString("utf8")).slice(-131072);if(!fallbackAuthorizationUrl){const authorizationUrl=authorizationFrom(tail);if(authorizationUrl){fallbackAuthorizationUrl=authorizationUrl;fallbackReadyAt=Date.now()+fallbackDelayMs}}launchBrowser();announce()}',
    'child=spawn(executable,["auth","login","--claudeai"],{env:{...process.env,BROWSER:launcher},stdio:["inherit","pipe","pipe"]})',
    'child.stdout.on("data",inspect)',
    'child.stderr.on("data",inspect)',
    "timer=setInterval(finish,50)",
    'child.once("error",()=>{claudeClosed=true;claudeExitCode=78;finishDeadline=0;finish()})',
    'child.once("close",(code,signal)=>{claudeClosed=true;claudeExitCode=code??signalExitCode(signal);finishDeadline=Date.now()+1000;finish()})',
  ].join(";");
}

export function buildClaudeLoginCommand(
  claudeExecutablePath: string,
  options: ClaudeLoginCommandOptions = {},
): string {
  const executable = requireAbsoluteClaudePath(claudeExecutablePath);
  const browserLauncher = buildChromeIncognitoLauncher(options.browserExecutablePath);
  const loginObserver = buildClaudeLoginObserver();
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
    'browser_claim="$browser_launcher.captured"',
    'browser_loopback_claim="$browser_launcher.loopback-captured"',
    'browser_loopback_file="$browser_launcher.loopback-url"',
    'browser_loopback_pending="$browser_launcher.loopback-url.pending"',
    'browser_manual_file="$browser_launcher.manual-url"',
    'browser_manual_pending="$browser_launcher.manual-url.pending"',
    `cleanup_login() { ${shellQuote(sttyExecutable)} echo >/dev/null 2>&1 || true; /bin/unlink "$browser_claim" 2>/dev/null || true; /bin/unlink "$browser_loopback_claim" 2>/dev/null || true; /bin/unlink "$browser_loopback_file" 2>/dev/null || true; /bin/unlink "$browser_loopback_pending" 2>/dev/null || true; /bin/unlink "$browser_manual_file" 2>/dev/null || true; /bin/unlink "$browser_manual_pending" 2>/dev/null || true; /bin/unlink "$browser_launcher" 2>/dev/null || true; /bin/rmdir "$browser_dir" 2>/dev/null || true; }`,
    "trap cleanup_login EXIT",
    "trap 'exit 129' HUP",
    "trap 'exit 130' INT",
    "trap 'exit 143' TERM",
    `/usr/bin/printf '%s' ${shellQuote(browserLauncher)} > "$browser_launcher" || exit 78`,
    '/bin/chmod 700 "$browser_launcher" || exit 78',
    `${shellQuote(sttyExecutable)} -echo >/dev/null 2>&1 || exit 79`,
    `printf '%s%s\\n' ${shellQuote("BB_CLAUDE_LOGIN_")} ${shellQuote("INPUT_READY")}`,
    `command node -e ${shellQuote(loginObserver)} ${shellQuote(executable)} "$browser_launcher"`,
  ].join("; ");
  const compressedScript = gzipSync(script, { level: 9 }).toString("base64");
  const decoder =
    'process.stdout.write(require("node:zlib").gunzipSync(Buffer.from(process.argv[1],"base64")))';
  const bootstrap = [
    `decoded_script="$(command node -e ${shellQuote(decoder)} ${shellQuote(compressedScript)})" || exit ${AUTHORIZATION_HELPER_ERROR_EXIT_CODE}`,
    'exec /bin/sh -c "$decoded_script"',
  ].join("; ");
  const command = `/bin/sh -c ${shellQuote(bootstrap)}`;
  if (command.length > BB_TERMINAL_COMMAND_MAX_CHARACTERS) {
    throw new Error("The Claude login helper exceeded BB's terminal command limit.");
  }
  return command;
}

export function buildClaudeAuthorizationReopenCommand(launcherPath: string): string {
  return `${shellQuote(requireAuthorizationLauncherPath(launcherPath))} ${shellQuote(
    AUTHORIZATION_REOPEN_ARGUMENT,
  )}`;
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
