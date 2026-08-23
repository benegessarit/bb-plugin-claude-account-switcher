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
  buildChromeIncognitoLauncher,
  buildClaudeLoginCommand,
  runClaudeAuthStatus,
  runClaudeLogin,
  type AuthStatusTerminalClient,
  type LoginWaitOptions,
  type LoginTerminal,
  type LoginTerminalClient,
} from "../login-terminal.ts";

function terminal(
  status: LoginTerminal["status"],
  exitCode: number | null = null,
): LoginTerminal {
  return { hostId: "host_1", id: "terminal_1", status, exitCode };
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
  assert.match(command, /auth login --claudeai/);
  assert.match(command, /\/opt\/trusted claude\/bin\/claude/);
  assert.doesNotMatch(command, /command claude auth login/);
  assert.match(command, /BROWSER=/);
  assert.match(command, /--incognito/);
  assert.match(command, /--new-window/);
  assert.match(command, /\/bin\/unlink/);
  assert.match(command, /\/bin\/rmdir/);
  assert.match(command, /command -v mktemp/);
  assert.doesNotMatch(command, /--email|--user-data-dir|open -n|open -na/);
});

test("the Incognito launcher invokes one browser executable without a profile override", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-incognito-"));
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
    const oauthUrl =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=client%2Bid&redirect_uri=https%3A%2F%2Fconsole.anthropic.com%2Foauth%2Fcode%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile&state=state%2Bvalue#callback";
    const result = spawnSync(launcherPath, [oauthUrl], {
      encoding: "utf8",
      env: { ...process.env, BB_SWITCH_BROWSER_ARGS: browserArgs },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual((await readFile(browserArgs, "utf8")).trim().split("\n"), [
      "--incognito",
      "--new-window",
      oauthUrl,
    ]);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("concurrent Incognito callbacks invoke the browser at most once", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-incognito-once-"));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const browserStarted = join(fixtureRoot, "browser-started");
  const releaseBrowser = join(fixtureRoot, "release-browser");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      '/usr/bin/printf \'%s\\n\' "$@" >> "$BB_SWITCH_BROWSER_ARGS"',
      ': > "$BB_SWITCH_BROWSER_STARTED"',
      'while test ! -f "$BB_SWITCH_BROWSER_RELEASE"; do /bin/sleep 0.01; done',
    ].join("\n"),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    const env = {
      ...process.env,
      BB_SWITCH_BROWSER_ARGS: browserArgs,
      BB_SWITCH_BROWSER_RELEASE: releaseBrowser,
      BB_SWITCH_BROWSER_STARTED: browserStarted,
    };
    const first = spawn(launcherPath, ["https://claude.com/cai/oauth/authorize"], {
      env,
      stdio: "ignore",
    });
    const firstExit = new Promise<number | null>((resolve) => {
      first.once("exit", resolve);
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(browserStarted);
        break;
      } catch {
        if (attempt === 99) throw new Error("Fake browser did not start.");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const second = spawnSync(launcherPath, ["https://claude.ai/oauth/authorize"], {
      encoding: "utf8",
      env,
    });

    assert.equal(second.status, 0, second.stderr);
    await writeFile(releaseBrowser, "release\n");
    assert.equal(await firstExit, 0);
    assert.deepEqual((await readFile(browserArgs, "utf8")).trim().split("\n"), [
      "--incognito",
      "--new-window",
      "https://claude.com/cai/oauth/authorize",
    ]);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("the Incognito launcher does not retry after the browser command fails", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-incognito-fail-"));
  const fakeBrowser = join(fixtureRoot, "chrome");
  const browserArgs = join(fixtureRoot, "browser-args");
  const launcherPath = join(fixtureRoot, "open-chrome-incognito");
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      '/usr/bin/printf \'%s\\n\' "$@" >> "$BB_SWITCH_BROWSER_ARGS"',
      "exit 42",
    ].join("\n"),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    await writeFile(launcherPath, buildChromeIncognitoLauncher(fakeBrowser));
    await chmod(launcherPath, 0o700);
    const env = { ...process.env, BB_SWITCH_BROWSER_ARGS: browserArgs };
    const first = spawnSync(launcherPath, ["https://claude.com/cai/oauth/authorize"], {
      encoding: "utf8",
      env,
    });
    const second = spawnSync(launcherPath, ["https://claude.ai/oauth/authorize"], {
      encoding: "utf8",
      env,
    });

    assert.equal(first.status, 42, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual((await readFile(browserArgs, "utf8")).trim().split("\n"), [
      "--incognito",
      "--new-window",
      "https://claude.com/cai/oauth/authorize",
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
      'exec "$BROWSER" "https://claude.com/cai/oauth/authorize"',
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
    assert.deepEqual((await readFile(browserArgs, "utf8")).trim().split("\n"), [
      "--incognito",
      "--new-window",
      "https://claude.com/cai/oauth/authorize",
    ]);
    assert.equal(
      (await readdir(fixtureRoot)).some((name) => name.startsWith("bb-claude-login.")),
      false,
    );
  } finally {
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
