import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import * as loginTerminal from "../login-terminal.ts";
import {
  buildClaudeAuthorizationReopenCommand,
  buildChromeIncognitoLauncher,
  buildClaudeLoginCommand,
  runClaudeAuthorizationReopen,
  runClaudeAuthStatus,
  runClaudeLogin,
  type AuthStatusTerminalClient,
  type LoginWaitOptions,
  type LoginTerminal,
  type LoginTerminalClient,
} from "../login-terminal.ts";

const VALID_OAUTH_URL =
  "https://claude.com/cai/oauth/authorize?response_type=code&client_id=client%2Bid&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&state=state%2Bvalue&code_challenge=challenge%2Bvalue&code_challenge_method=S256#callback";
const SECOND_VALID_OAUTH_URL = VALID_OAUTH_URL.replace(
  "state=state%2Bvalue",
  "state=second%2Bstate",
);

function changedOAuthUrl(change: (url: URL) => void): string {
  const url = new URL(VALID_OAUTH_URL);
  change(url);
  return url.toString();
}

function terminal(
  status: LoginTerminal["status"],
  exitCode: number | null = null,
): LoginTerminal {
  return { hostId: "host_1", id: "terminal_1", status, exitCode };
}

async function readFileEventually(path: string, timeoutMs = 2_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
}

function client(
  states: LoginTerminal[],
  closes: Array<"force" | "if-clean">,
): LoginTerminalClient {
  return {
    close: async (_id, mode) => {
      closes.push(mode);
      return terminal("exited", 1);
    },
    create: async () => states[0]!,
    get: async () => states.shift() ?? terminal("exited", 0),
  };
}

test("the login command routes authorization through Chrome Incognito", () => {
  const command = buildClaudeLoginCommand("/opt/trusted claude/bin/claude");

  assert.match(command, /^\/bin\/sh -c /);
  assert.match(command, /\/bin\/stty/);
  assert.match(command, /-echo/);
  assert.match(command, /\/bin\/stty.*echo/);
  assert.doesNotMatch(command, /BB_CLAUDE_LOGIN_INPUT_READY/);
  assert.match(command, /BB_CLAUDE_LOGIN_/);
  assert.match(command, /INPUT_READY/);
  assert.match(command, /auth.*login.*--claudeai/);
  assert.match(command, /\/opt\/trusted claude\/bin\/claude/);
  assert.doesNotMatch(command, /command claude auth login/);
  assert.match(command, /BROWSER:launcher/);
  assert.match(command, /--incognito/);
  assert.match(command, /--new-window/);
  assert.match(command, /\/bin\/unlink/);
  assert.match(command, /\/bin\/rmdir/);
  assert.match(command, /command -v mktemp/);
  assert.doesNotMatch(command, /--email|--user-data-dir|open -n|open -na/);
});

test("authorization capture opens Chrome only when requested", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login."));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" > "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    const env = { ...process.env, BB_SWITCH_BROWSER_ARGS: browserArgs };
    const capture = spawnSync(launcherPath, [VALID_OAUTH_URL], {
      encoding: "utf8",
      env,
    });

    assert.equal(capture.status, 0, capture.stderr);
    await assert.rejects(access(browserArgs));
    const open = spawnSync(
      "/bin/sh",
      ["-c", buildClaudeAuthorizationReopenCommand(launcherPath)],
      { encoding: "utf8", env },
    );
    assert.equal(open.status, 0, open.stderr);
    assert.deepEqual((await readFileEventually(browserArgs)).trim().split("\n"), [
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
    ]);
    assert.equal(
      (await readFile(`${launcherPath}.authorization-url`, "utf8")).trim(),
      VALID_OAUTH_URL,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("explicit authorization reopen uses the saved URL without consuming another automatic callback", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login."));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" >> "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    const env = { ...process.env, BB_SWITCH_BROWSER_ARGS: browserArgs };

    assert.equal(
      spawnSync(launcherPath, [VALID_OAUTH_URL], { encoding: "utf8", env }).status,
      0,
    );
    assert.equal(
      spawnSync(
        "/bin/sh",
        ["-c", buildClaudeAuthorizationReopenCommand(launcherPath)],
        {
          encoding: "utf8",
          env,
        },
      ).status,
      0,
    );
    assert.equal(
      spawnSync(launcherPath, [SECOND_VALID_OAUTH_URL], { encoding: "utf8", env })
        .status,
      0,
    );

    assert.deepEqual((await readFileEventually(browserArgs)).trim().split("\n"), [
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
    ]);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("authorization reopen reports not ready before Claude supplies the URL", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login."));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(fakeBrowser, ["#!/bin/sh", "exit 0"].join("\n"));
  await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
  await chmod(fakeBrowser, 0o755);
  await chmod(launcherPath, 0o700);

  try {
    const result = spawnSync(
      "/bin/sh",
      ["-c", buildClaudeAuthorizationReopenCommand(launcherPath)],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 75, result.stderr);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the Incognito launcher rejects HTTPS URLs outside Claude consent", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-consent-url-"));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" > "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    for (const candidate of [
      "https://claude.com/",
      "https://claude.com.evil.test/cai/oauth/authorize?response_type=code&state=x&code_challenge=y",
      "https://user@claude.com/cai/oauth/authorize?response_type=code&state=x&code_challenge=y",
      "https://claude.com:444/cai/oauth/authorize?response_type=code&state=x&code_challenge=y",
      "https://claude.com/cai/oauth/authorize?response_type=code&code_challenge=y",
      "https://claude.com/cai/oauth/authorize?response_type=code&state=x",
      changedOAuthUrl((url) => url.searchParams.delete("client_id")),
      changedOAuthUrl((url) => url.searchParams.append("client_id", "second")),
      changedOAuthUrl((url) => url.searchParams.delete("redirect_uri")),
      changedOAuthUrl((url) =>
        url.searchParams.set("redirect_uri", "https://example.com/oauth/callback"),
      ),
      changedOAuthUrl((url) => url.searchParams.delete("scope")),
      changedOAuthUrl((url) => url.searchParams.delete("code_challenge_method")),
      changedOAuthUrl((url) => url.searchParams.set("code_challenge_method", "plain")),
      changedOAuthUrl((url) => url.searchParams.append("state", "second")),
      changedOAuthUrl((url) => url.searchParams.append("code_challenge", "second")),
    ]) {
      const result = spawnSync(launcherPath, [candidate], {
        encoding: "utf8",
        env: { ...process.env, BB_SWITCH_BROWSER_ARGS: browserArgs },
      });
      assert.equal(result.status, 78, candidate);
    }
    await assert.rejects(access(browserArgs));
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("concurrent authorization callbacks capture one URL without opening Chrome", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-incognito-once-"));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      '/usr/bin/printf \'%s\\n\' "$@" >> "$BB_SWITCH_BROWSER_ARGS"',
      "exit 99",
    ].join("\n"),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    const env = { ...process.env, BB_SWITCH_BROWSER_ARGS: browserArgs };
    const capture = () =>
      new Promise<number | null>((resolve, reject) => {
        const child = spawn(launcherPath, [VALID_OAUTH_URL], {
          env,
          stdio: "ignore",
        });
        child.once("error", reject);
        child.once("exit", resolve);
      });

    assert.deepEqual(await Promise.all([capture(), capture()]), [0, 0]);
    assert.equal(
      (await readFile(`${launcherPath}.authorization-url`, "utf8")).trim(),
      VALID_OAUTH_URL,
    );
    await assert.rejects(access(browserArgs));
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("authorization reopen can retry after the browser command fails", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login."));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const failedOnce = join(fixtureRoot, "failed-once");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      '/usr/bin/printf \'%s\\n\' "$@" >> "$BB_SWITCH_BROWSER_ARGS"',
      'if test ! -f "$BB_SWITCH_BROWSER_FAILED_ONCE"; then',
      '  : > "$BB_SWITCH_BROWSER_FAILED_ONCE"',
      "  exit 42",
      "fi",
      "exit 0",
    ].join("\n"),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    const env = {
      ...process.env,
      BB_SWITCH_BROWSER_ARGS: browserArgs,
      BB_SWITCH_BROWSER_FAILED_ONCE: failedOnce,
    };
    const capture = spawnSync(launcherPath, [VALID_OAUTH_URL], {
      encoding: "utf8",
      env,
    });
    const reopenCommand = buildClaudeAuthorizationReopenCommand(launcherPath);
    const first = spawnSync("/bin/sh", ["-c", reopenCommand], {
      encoding: "utf8",
      env,
    });
    const second = spawnSync("/bin/sh", ["-c", reopenCommand], {
      encoding: "utf8",
      env,
    });

    assert.equal(capture.status, 0, capture.stderr);
    assert.equal(first.status, 42, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual((await readFileEventually(browserArgs)).trim().split("\n"), [
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
    ]);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the Incognito launcher rejects non-HTTPS browser targets", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-incognito-url-"));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" > "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    const result = spawnSync(launcherPath, ["file:///etc/passwd"], {
      encoding: "utf8",
      env: { ...process.env, BB_SWITCH_BROWSER_ARGS: browserArgs },
    });

    assert.equal(result.status, 78, result.stderr);
    await assert.rejects(access(browserArgs));
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the complete login command launches Chrome Incognito and removes its helper", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-command-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  const browserArgs = join(fixtureRoot, "browser-args");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      'test "$1" = auth && test "$2" = login && test "$3" = --claudeai || exit 91',
      "exec 3>&-",
      `exec "$BROWSER" ${JSON.stringify(VALID_OAUTH_URL)}`,
    ].join("\n"),
  );
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" > "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  try {
    const command = buildClaudeLoginCommand(fakeClaude, {
      browserExecutablePath: fakeBrowser,
      sttyExecutablePath: fakeStty,
    });
    assert.ok(
      command.includes(fakeBrowser),
      "the test browser must be embedded before the command can execute",
    );
    const result = spawnSync("/bin/sh", ["-c", command], {
      encoding: "utf8",
      env: {
        ...process.env,
        BB_SWITCH_BROWSER_ARGS: browserArgs,
        TMPDIR: fixtureRoot,
      },
      timeout: 5_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /BB_CLAUDE_LOGIN_AUTHORIZATION_READY:.*\/bb-claude-login\.[^/]+\/open-chrome-incognito/,
    );
    assert.doesNotMatch(result.stdout, /https:\/\//);
    assert.deepEqual((await readFile(browserArgs, "utf8")).trim().split("\n"), [
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
    ]);
    assert.equal(
      (await readdir(fixtureRoot)).some((name) => name.startsWith("bb-claude-login.")),
      false,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the login command opens Claude's printed fallback URL when BROWSER is not called", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-fallback-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  const browserArgs = join(fixtureRoot, "browser-args");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      'test "$1" = auth && test "$2" = login && test "$3" = --claudeai || exit 91',
      `/usr/bin/printf 'If the browser did not open, visit: %s\\n' ${JSON.stringify(VALID_OAUTH_URL)}`,
    ].join("\n"),
  );
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" > "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        buildClaudeLoginCommand(fakeClaude, {
          browserExecutablePath: fakeBrowser,
          sttyExecutablePath: fakeStty,
        }),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BB_SWITCH_BROWSER_ARGS: browserArgs,
          TMPDIR: fixtureRoot,
        },
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /https:\/\//);
    assert.deepEqual((await readFileEventually(browserArgs)).trim().split("\n"), [
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
    ]);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the login command still opens only one window when Claude also prints the URL", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-deduped-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  const browserArgs = join(fixtureRoot, "browser-args");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      `"$BROWSER" ${JSON.stringify(VALID_OAUTH_URL)}`,
      `/usr/bin/printf '%s\\n' ${JSON.stringify(VALID_OAUTH_URL)}`,
    ].join("\n"),
  );
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" >> "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        buildClaudeLoginCommand(fakeClaude, {
          browserExecutablePath: fakeBrowser,
          sttyExecutablePath: fakeStty,
        }),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BB_SWITCH_BROWSER_ARGS: browserArgs,
          TMPDIR: fixtureRoot,
        },
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFileEventually(browserArgs)).trim().split("\n"), [
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
    ]);
    assert.equal(
      result.stdout.match(/BB_CLAUDE_LOGIN_AUTHORIZATION_READY:/g)?.length,
      1,
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the login observer preserves manual authorization-code input", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-input-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  await writeFile(
    fakeClaude,
    ["#!/bin/sh", "IFS= read -r code", 'test "$code" = "code#state"'].join("\n"),
  );
  await writeFile(fakeBrowser, ["#!/bin/sh", "exit 0"].join("\n"));
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        buildClaudeLoginCommand(fakeClaude, {
          browserExecutablePath: fakeBrowser,
          sttyExecutablePath: fakeStty,
        }),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: fixtureRoot },
        input: "code#state\n",
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the login command does not report authorization ready before it has a URL", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-not-ready-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  await writeFile(fakeClaude, ["#!/bin/sh", "exit 1"].join("\n"));
  await writeFile(fakeBrowser, ["#!/bin/sh", "exit 0"].join("\n"));
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        buildClaudeLoginCommand(fakeClaude, {
          browserExecutablePath: fakeBrowser,
          sttyExecutablePath: fakeStty,
        }),
      ],
      {
        encoding: "utf8",
        env: { ...process.env, TMPDIR: fixtureRoot },
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /BB_CLAUDE_LOGIN_AUTHORIZATION_READY:/);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the login fallback waits for a complete ANSI-wrapped URL", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-framed-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  const browserArgs = join(fixtureRoot, "browser-args");
  const firstBreak = VALID_OAUTH_URL.indexOf("&code_challenge=");
  const wrapBreak = VALID_OAUTH_URL.indexOf("&code_challenge_method=");
  const first = VALID_OAUTH_URL.slice(0, firstBreak);
  const second = VALID_OAUTH_URL.slice(firstBreak, wrapBreak);
  const third = VALID_OAUTH_URL.slice(wrapBreak);
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      `/usr/bin/printf '\\033[2m%s' ${JSON.stringify(first)}`,
      "/bin/sleep 0.05",
      `/usr/bin/printf '%s\\n  %s\\033[0m\\n\\n' ${JSON.stringify(second)} ${JSON.stringify(third)}`,
    ].join("\n"),
  );
  await writeFile(
    fakeBrowser,
    ["#!/bin/sh", '/usr/bin/printf \'%s\\n\' "$@" > "$BB_SWITCH_BROWSER_ARGS"'].join(
      "\n",
    ),
  );
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        buildClaudeLoginCommand(fakeClaude, {
          browserExecutablePath: fakeBrowser,
          sttyExecutablePath: fakeStty,
        }),
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BB_SWITCH_BROWSER_ARGS: browserArgs,
          TMPDIR: fixtureRoot,
        },
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFileEventually(browserArgs)).trim().split("\n"), [
      "--incognito",
      "--new-window",
      VALID_OAUTH_URL,
    ]);
    assert.doesNotMatch(result.stdout, /https:\/\//);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the login fallback does not wait for a newly launched browser to quit", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-long-browser-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  const browserPidFile = join(fixtureRoot, "browser-pid");
  await writeFile(
    fakeClaude,
    ["#!/bin/sh", `/usr/bin/printf '%s\\n' ${JSON.stringify(VALID_OAUTH_URL)}`].join(
      "\n",
    ),
  );
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      '/usr/bin/printf \'%s\\n\' "$$" > "$BB_SWITCH_BROWSER_PID"',
      "exec /bin/sleep 30",
    ].join("\n"),
  );
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  const child = spawn(
    "/bin/sh",
    [
      "-c",
      buildClaudeLoginCommand(fakeClaude, {
        browserExecutablePath: fakeBrowser,
        sttyExecutablePath: fakeStty,
      }),
    ],
    {
      detached: true,
      env: {
        ...process.env,
        BB_SWITCH_BROWSER_PID: browserPidFile,
        TMPDIR: fixtureRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let browserPid: number | undefined;

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("login observer waited for the browser process")),
        2_000,
      );
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      child.once("error", reject);
    });
    browserPid = Number((await readFileEventually(browserPidFile)).trim());

    assert.equal(exitCode, 0);
    assert.doesNotThrow(() => process.kill(browserPid!, 0));
  } finally {
    if (browserPid === undefined) {
      try {
        browserPid = Number((await readFile(browserPidFile, "utf8")).trim());
      } catch {
        // The browser may not have started before a failed assertion.
      }
    }
    if (browserPid !== undefined && Number.isSafeInteger(browserPid)) {
      try {
        process.kill(browserPid, "SIGTERM");
      } catch {
        // The exact fixture process already exited.
      }
    }
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // The exact fixture process group already exited.
      }
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("cancelling login does not wait for a long-lived fallback browser", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-cancel-browser-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  const browserPidFile = join(fixtureRoot, "browser-pid");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      `/usr/bin/printf '%s\\n' ${JSON.stringify(VALID_OAUTH_URL)}`,
      "exec /bin/sleep 30",
    ].join("\n"),
  );
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      '/usr/bin/printf \'%s\\n\' "$$" > "$BB_SWITCH_BROWSER_PID"',
      "exec /bin/sleep 30",
    ].join("\n"),
  );
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  const child = spawn(
    "/bin/sh",
    [
      "-c",
      buildClaudeLoginCommand(fakeClaude, {
        browserExecutablePath: fakeBrowser,
        sttyExecutablePath: fakeStty,
      }),
    ],
    {
      detached: true,
      env: {
        ...process.env,
        BB_SWITCH_BROWSER_PID: browserPidFile,
        TMPDIR: fixtureRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let browserPid: number | undefined;

  try {
    browserPid = Number((await readFileEventually(browserPidFile)).trim());
    process.kill(-child.pid!, "SIGTERM");
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("cancelled login waited for the browser process")),
        2_000,
      );
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    assert.doesNotThrow(() => process.kill(browserPid!, 0));
  } finally {
    if (browserPid !== undefined && Number.isSafeInteger(browserPid)) {
      try {
        process.kill(browserPid, "SIGTERM");
      } catch {
        // The exact fixture process already exited.
      }
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // The exact fixture process group already exited.
      }
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a failed Claude browser callback stops with a safe error", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-browser-error-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "chrome");
  const fakeStty = join(fixtureRoot, "stty");
  const browserCalls = join(fixtureRoot, "browser-calls");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      `"$BROWSER" ${JSON.stringify(VALID_OAUTH_URL)}`,
      `/usr/bin/printf '%s\\n' ${JSON.stringify(VALID_OAUTH_URL)}`,
      "exec /bin/sleep 30",
    ].join("\n"),
  );
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      "/usr/bin/printf 'called\\n' >> \"$BB_SWITCH_BROWSER_CALLS\"",
      "exit 42",
    ].join("\n"),
  );
  await writeFile(fakeStty, ["#!/bin/sh", "exit 0"].join("\n"));
  await chmod(fakeClaude, 0o755);
  await chmod(fakeBrowser, 0o755);
  await chmod(fakeStty, 0o755);

  const child = spawn(
    "/bin/sh",
    [
      "-c",
      buildClaudeLoginCommand(fakeClaude, {
        browserExecutablePath: fakeBrowser,
        sttyExecutablePath: fakeStty,
      }),
    ],
    {
      detached: true,
      env: {
        ...process.env,
        BB_SWITCH_BROWSER_CALLS: browserCalls,
        TMPDIR: fixtureRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("failed browser launch left Claude waiting")),
        2_000,
      );
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
      child.once("error", reject);
    });

    assert.equal(exitCode, 78);
    assert.match(stdout, /BB_CLAUDE_LOGIN_BROWSER_FAILED/);
    assert.doesNotMatch(stdout, /https:\/\//);
    assert.equal((await readFile(browserCalls, "utf8")).trim(), "called");
  } finally {
    if (child.exitCode === null) {
      try {
        process.kill(-child.pid!, "SIGTERM");
      } catch {
        // The exact fixture process group already exited.
      }
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the auth-status command emits only safe classification fields", () => {
  const buildCommand = Reflect.get(
    loginTerminal,
    "buildClaudeAuthStatusCommand",
  ) as unknown;
  assert.equal(typeof buildCommand, "function");

  const command = (buildCommand as (path: string) => string)(
    "/opt/trusted claude/bin/claude",
  );
  assert.match(command, /claude.*auth.*status.*--json/);
  assert.match(command, /\/opt\/trusted claude\/bin\/claude/);
  assert.match(command, /loggedIn/);
  assert.match(command, /authMethod/);
  assert.match(command, /apiProvider/);
  assert.doesNotMatch(command, /subscriptionType/);
  assert.doesNotMatch(command, /accountEmail|orgId|orgName/);
});

test("the auth-status helper stays readable, then self-exits if cleanup is lost", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-auth-status-"));
  const fakeClaude = join(fixtureRoot, "claude");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","subscriptionType":"max","accountEmail":"private@example.com"}\'',
    ].join("\n"),
  );
  await chmod(fakeClaude, 0o755);

  const child = spawn(
    "/bin/sh",
    ["-c", loginTerminal.buildClaudeAuthStatusCommand(fakeClaude, 1_000)],
    {
      detached: true,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    let output = "";
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("auth-status helper did not emit output")),
        3_000,
      );
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("apiProvider=firstParty\n")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(child.exitCode, null);
    assert.equal(
      output,
      "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
    );
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("auth-status helper did not self-exit")),
        3_000,
      );
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 3);
  } finally {
    if (child.exitCode === null) {
      process.kill(-child.pid!, "SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the auth-status helper kills a hung Claude status command", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-auth-hang-"));
  const fakeClaude = join(fixtureRoot, "claude");
  await writeFile(fakeClaude, ["#!/bin/sh", "exec /bin/sleep 10"].join("\n"));
  await chmod(fakeClaude, 0o755);

  const child = spawn(
    "/bin/sh",
    ["-c", loginTerminal.buildClaudeAuthStatusCommand(fakeClaude, 200)],
    {
      detached: true,
      env: {
        ...process.env,
        PATH: `${fixtureRoot}:${dirname(process.execPath)}:/usr/bin:/bin`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("hung auth-status command was not killed")),
        1_000,
      );
      child.once("exit", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    assert.equal(exitCode, 1);
  } finally {
    if (child.exitCode === null) {
      process.kill(-child.pid!, "SIGTERM");
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("auth status accepts the CRLF output produced by a BB terminal", () => {
  const parse = Reflect.get(loginTerminal, "parseClaudeAuthStatus") as unknown;
  assert.equal(typeof parse, "function");

  const output = [
    "loggedIn=true",
    "authMethod=claude.ai",
    "apiProvider=firstParty",
    "",
  ].join("\r\n");
  assert.deepEqual((parse as (value: string) => unknown)(output), {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
  });
});

test("auth status accepts a first-party Claude login without subscriptionType", () => {
  const parse = Reflect.get(loginTerminal, "parseClaudeAuthStatus") as (
    value: string,
  ) => unknown;

  assert.deepEqual(
    parse("loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n"),
    {
      apiProvider: "firstParty",
      authMethod: "claude.ai",
      loggedIn: true,
    },
  );
});

test("the auth-status helper supports Claude accounts without subscriptionType", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-auth-no-plan-"));
  const fakeClaude = join(fixtureRoot, "claude");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      'printf \'%s\\n\' \'{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\'',
    ].join("\n"),
  );
  await chmod(fakeClaude, 0o755);

  try {
    const result = spawnSync(
      "/bin/sh",
      ["-c", loginTerminal.buildClaudeAuthStatusCommand(fakeClaude, 1_000)],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixtureRoot}:${dirname(process.execPath)}:/usr/bin:/bin`,
        },
        killSignal: "SIGKILL",
        timeout: 5_000,
      },
    );

    assert.equal(result.status, 3, result.stderr);
    assert.equal(
      result.stdout,
      "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
    );
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("auth status fails closed on unsafe or incomplete output", () => {
  const parse = Reflect.get(loginTerminal, "parseClaudeAuthStatus") as (
    value: string,
  ) => unknown;

  for (const output of [
    "loggedIn=true\nauthMethod=apiKey\napiProvider=firstParty\nsubscriptionType=max\n",
    "loggedIn=true\nauthMethod=claude.ai\n",
    "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\nemail=private@example.com\n",
  ]) {
    assert.throws(() => parse(output), /subscription login could not be verified/);
  }
});

test("auth verification reads safe output before BB discards exited terminal output", async () => {
  const runStatus = Reflect.get(loginTerminal, "runClaudeAuthStatus") as unknown;
  assert.equal(typeof runStatus, "function");
  const closes: Array<"force" | "if-clean"> = [];
  let running = true;

  const status = await (
    runStatus as (
      client: LoginTerminalClient & { output(id: string): Promise<string> },
      threadId: string,
      options: LoginWaitOptions,
    ) => Promise<unknown>
  )(
    {
      close: async (_id, mode) => {
        closes.push(mode);
        return terminal("exited", 1);
      },
      create: async () => terminal("running"),
      get: async () => {
        running = false;
        return terminal("exited", 0);
      },
      output: async () => {
        if (!running) {
          throw new Error(
            "HTTP 409: Terminal output is unavailable because the session is not running",
          );
        }
        return "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n";
      },
    },
    "thread_1",
    { sleep: async () => undefined, timeoutMs: 15_000 },
  );

  assert.deepEqual(status, {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
  });
  assert.deepEqual(closes, ["force"]);
});

test("a browser-launch failure is surfaced without waiting for login timeout", async () => {
  const closes: Array<"force" | "if-clean"> = [];

  await assert.rejects(
    runClaudeLogin(
      {
        close: async (_terminalId, mode) => {
          closes.push(mode);
          return terminal("exited", 78);
        },
        create: async () => terminal("running"),
        get: async () => terminal("running"),
        output: async () =>
          "BB_CLAUDE_LOGIN_INPUT_READY\nBB_CLAUDE_LOGIN_BROWSER_FAILED\n",
      },
      "thread_1",
      { sleep: async () => undefined },
    ),
    /could not open Chrome/i,
  );

  assert.deepEqual(closes, ["force"]);
});

test("a successful terminal login closes cleanly", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("running"), terminal("exited", 0)];
  let committed = false;

  await runClaudeLogin(client(states, closes), "thread_1", {
    onSuccess: () => {
      committed = true;
    },
    sleep: async () => undefined,
  });

  assert.equal(committed, true);
  assert.deepEqual(closes, ["if-clean"]);
});

test("authorization-code input becomes available only after terminal echo is hidden", async () => {
  const readyTerminalIds: string[] = [];
  let outputReads = 0;

  await runClaudeLogin(
    {
      close: async () => terminal("exited", 0),
      create: async () => terminal("running"),
      get: async () => terminal("exited", 0),
      output: async () => {
        outputReads += 1;
        return "BB_CLAUDE_LOGIN_INPUT_READY\n";
      },
    },
    "thread_1",
    {
      onInputReady: (terminalId) => readyTerminalIds.push(terminalId),
      sleep: async () => undefined,
    },
  );

  assert.equal(outputReads, 1);
  assert.deepEqual(readyTerminalIds, ["terminal_1"]);
});

test("authorization return becomes available from the parent launcher marker", async () => {
  const ready: Array<{ terminalId: string; launcherPath: string }> = [];
  const launcherPath = "/private/tmp/bb-claude-login.A1b2C3/open-chrome-incognito";

  await runClaudeLogin(
    {
      close: async () => terminal("exited", 0),
      create: async () => terminal("running"),
      get: async () => terminal("exited", 0),
      output: async () =>
        `BB_CLAUDE_LOGIN_AUTHORIZATION_READY:${launcherPath}\nBB_CLAUDE_LOGIN_INPUT_READY\n`,
    },
    "thread_1",
    {
      onAuthorizationReady: (terminalId, path) => {
        ready.push({ launcherPath: path, terminalId });
      },
      sleep: async () => undefined,
    },
  );

  assert.deepEqual(ready, [{ launcherPath, terminalId: "terminal_1" }]);
});

test("authorization return rejects an untrusted launcher marker", async () => {
  await assert.rejects(
    runClaudeLogin(
      {
        close: async () => terminal("exited", 1),
        create: async () => terminal("running"),
        get: async () => terminal("running"),
        output: async () =>
          "BB_CLAUDE_LOGIN_AUTHORIZATION_READY:/private/tmp/not-the-login-helper\n",
      },
      "thread_1",
      {
        onAuthorizationReady: () => undefined,
        sleep: async () => undefined,
        timeoutMs: 1,
      },
    ),
    /authorization helper path was invalid/i,
  );
});

test("authorization reopen settles a clean one-shot helper", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const settled: string[] = [];

  await runClaudeAuthorizationReopen(
    {
      close: async (terminalId, mode) => {
        closes.push(mode);
        return { ...terminal("exited", 0), id: terminalId };
      },
      create: async () => ({ ...terminal("running"), id: "reopen_terminal" }),
      get: async () => ({ ...terminal("exited", 0), id: "reopen_terminal" }),
      onSettled: (terminalId) => {
        settled.push(terminalId);
      },
    },
    "thread_1",
    { sleep: async () => undefined },
  );

  assert.deepEqual(closes, ["if-clean"]);
  assert.deepEqual(settled, ["reopen_terminal"]);
});

test("authorization reopen keeps an unconfirmed helper owned", async () => {
  const cleanupFailed: string[] = [];

  await assert.rejects(
    runClaudeAuthorizationReopen(
      {
        close: async (terminalId) => ({
          ...terminal("disconnected"),
          id: terminalId,
        }),
        create: async () => ({ ...terminal("running"), id: "reopen_terminal" }),
        get: async () => ({ ...terminal("disconnected"), id: "reopen_terminal" }),
        onCleanupFailed: (terminalId) => {
          cleanupFailed.push(terminalId);
        },
      },
      "thread_1",
      { sleep: async () => undefined },
    ),
    /could not be confirmed/i,
  );

  assert.deepEqual(cleanupFailed, ["reopen_terminal"]);
});

test("a failed terminal login does not report success", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("exited", 1)];

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1"),
    /did not finish successfully/,
  );
  assert.deepEqual(closes, ["if-clean"]);
});

test("a timed-out login is force-closed", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("running")];
  let now = 0;

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1", {
      now: () => now,
      sleep: async () => {
        now += 10;
      },
      timeoutMs: 5,
    }),
    /timed out/,
  );
  assert.deepEqual(closes, ["force"]);
});

test("an unexpected poll failure still force-closes the login helper", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const terminalClient: LoginTerminalClient = {
    close: async (_id, mode) => {
      closes.push(mode);
      return terminal("disconnected");
    },
    create: async () => terminal("running"),
    get: async () => {
      throw new Error("terminal state unavailable");
    },
  };

  await assert.rejects(
    runClaudeLogin(terminalClient, "thread_1", {
      sleep: async () => undefined,
    }),
    /terminal state unavailable/,
  );
  assert.deepEqual(closes, ["force"]);
});

test("a cancelled login stops before another poll and is force-closed", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const controller = new AbortController();
  const states = [terminal("running"), terminal("exited", 0)];
  let sleeps = 0;

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1", {
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
        controller.abort();
      },
    }),
    /cancelled/,
  );
  assert.equal(sleeps, 1);
  assert.deepEqual(closes, ["force"]);
});

test("cancellation treats an atomically closed successful login as committed", async () => {
  const controller = new AbortController();
  let committed = false;
  let closeMode: "force" | "if-clean" | undefined;
  const terminalClient = {
    close: async (_id: string, mode: "force" | "if-clean") => {
      closeMode = mode;
      return terminal("exited", 0);
    },
    create: async () => terminal("running"),
    get: async () => terminal("running"),
  };

  const login = runClaudeLogin(terminalClient, "thread_1", {
    onSuccess: () => {
      committed = true;
    },
    signal: controller.signal,
    sleep: async () => {
      controller.abort();
    },
  });

  await login;
  assert.equal(committed, true);
  assert.equal(closeMode, "force");
});

test("cancellation overlapping a failed poll and close is potentially committed", async () => {
  const controller = new AbortController();
  let cleanupFailed = false;
  let committed = false;
  const terminalClient: LoginTerminalClient = {
    close: async () => {
      throw new Error("terminal close unavailable");
    },
    create: async () => terminal("running"),
    get: async () => {
      controller.abort();
      throw new Error("terminal state unavailable");
    },
    onCleanupFailed: () => {
      cleanupFailed = true;
    },
  };

  await assert.rejects(
    runClaudeLogin(terminalClient, "thread_1", {
      onSuccess: () => {
        committed = true;
      },
      signal: controller.signal,
      sleep: async () => undefined,
    }),
    /terminal state unavailable/,
  );
  assert.equal(committed, true);
  assert.equal(cleanupFailed, true);
});

test("an already-cancelled login creates no helper terminal", async () => {
  const controller = new AbortController();
  controller.abort();
  let creates = 0;
  const terminalClient: LoginTerminalClient = {
    close: async () => terminal("disconnected"),
    create: async () => {
      creates += 1;
      return terminal("running");
    },
    get: async () => terminal("running"),
  };

  await assert.rejects(
    runClaudeLogin(terminalClient, "thread_1", { signal: controller.signal }),
    /cancelled/,
  );
  assert.equal(creates, 0);
});

test("already-cancelled auth verification creates no helper terminal", async () => {
  const controller = new AbortController();
  controller.abort();
  let creates = 0;
  const terminalClient: AuthStatusTerminalClient = {
    close: async () => terminal("disconnected"),
    create: async () => {
      creates += 1;
      return terminal("running");
    },
    get: async () => terminal("running"),
    output: async () => "",
  };

  await assert.rejects(
    runClaudeAuthStatus(terminalClient, "thread_1", {
      signal: controller.signal,
    }),
    /subscription login could not be verified/,
  );
  assert.equal(creates, 0);
});

test("auth verification keeps a disconnected helper owned", async () => {
  let cleanupFailed = false;
  let settled = false;
  const result = await runClaudeAuthStatus(
    {
      close: async () => terminal("disconnected"),
      create: async () => terminal("running"),
      get: async () => terminal("running"),
      onCleanupFailed: () => {
        cleanupFailed = true;
      },
      onSettled: () => {
        settled = true;
      },
      output: async () =>
        "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
    },
    "thread_1",
  );

  assert.deepEqual(result, {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
  });
  assert.equal(cleanupFailed, true);
  assert.equal(settled, false);
});

test("cancellation wakes a pending poll without waiting for its timer", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const controller = new AbortController();
  let closeStarted!: () => void;
  let pollStarted!: () => void;
  let releasePoll!: () => void;
  const closing = new Promise<void>((resolve) => {
    closeStarted = resolve;
  });
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const blockedPoll = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const running = runClaudeLogin(
    {
      close: async (_terminalId, mode) => {
        closes.push(mode);
        closeStarted();
        return terminal("exited", 1);
      },
      create: async () => terminal("running"),
      get: async () => terminal("running"),
    },
    "thread_1",
    {
      signal: controller.signal,
      sleep: async () => {
        pollStarted();
        await blockedPoll;
      },
    },
  );
  await started;

  controller.abort();
  await closing;
  releasePoll();
  await assert.rejects(running, /cancelled/);
  assert.deepEqual(closes, ["force"]);
});

test("auth cancellation wakes a pending poll without another terminal state read", async () => {
  const controller = new AbortController();
  let pollStarted!: () => void;
  let releasePoll!: () => void;
  let stateReads = 0;
  let outputReads = 0;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const blockedPoll = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const authClient: AuthStatusTerminalClient = {
    close: async () => terminal("disconnected"),
    create: async () => terminal("running"),
    get: async () => {
      stateReads += 1;
      return terminal("exited", 0);
    },
    output: async () => {
      outputReads += 1;
      throw new Error("filtered output is not ready");
    },
  };
  const running = runClaudeAuthStatus(authClient, "thread_1", {
    signal: controller.signal,
    sleep: async () => {
      pollStarted();
      await blockedPoll;
    },
  });
  await started;

  controller.abort();
  await assert.rejects(running, /subscription login could not be verified/);
  releasePoll();
  assert.equal(outputReads, 1);
  assert.equal(stateReads, 0);
});

test("failed terminal cleanup remains owned without hiding a successful login", async () => {
  let cleanupFailed = false;
  let settled = false;
  await runClaudeLogin(
    {
      close: async () => {
        throw new Error("already gone");
      },
      create: async () => terminal("exited", 0),
      get: async () => terminal("exited", 0),
      onCleanupFailed: () => {
        cleanupFailed = true;
      },
      onSettled: () => {
        settled = true;
      },
    },
    "thread_1",
  );
  assert.equal(cleanupFailed, true);
  assert.equal(settled, false);
});
