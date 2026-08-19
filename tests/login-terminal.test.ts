import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { tmpdir } from "node:os";
import * as loginTerminal from "../login-terminal.ts";
import {
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
  return { id: "terminal_1", status, exitCode };
}

function client(
  states: LoginTerminal[],
  closes: Array<"force" | "if-clean">,
): LoginTerminalClient {
  return {
    close: async (_id, mode) => {
      closes.push(mode);
    },
    create: async () => states[0]!,
    get: async () => states.shift() ?? terminal("exited", 0),
  };
}

test("the login command selects the target Claude subscription email", () => {
  const buildCommand = Reflect.get(loginTerminal, "buildClaudeLoginCommand") as unknown;
  assert.equal(typeof buildCommand, "function");

  const command = (buildCommand as (email: string) => string)(
    "second+claude@example.com",
  );
  assert.match(command, /auth login --claudeai/);
  assert.match(command, /--email 'second\+claude@example\.com'/);
  assert.match(command, /mktemp -d/);
  assert.match(command, /BROWSER="\$browser_launcher"/);
  assert.match(command, /google-chrome-stable/);
  assert.match(command, /chromium-browser/);
  assert.match(command, /--user-data-dir/);
  assert.match(command, /--incognito/);
  assert.match(command, />\/dev\/null 2>&1/);
});

test("the login command omits the email flag but still isolates browser cookies", () => {
  const command = buildClaudeLoginCommand();

  assert.doesNotMatch(command, /--email/);
  assert.match(command, /BROWSER="\$browser_launcher"/);
  assert.match(command, /bb-claude-browser-/);
  assert.match(command, /--user-data-dir/);
  assert.match(command, /--incognito/);
});

test("the private-browser helper is removed without recursive deletion", () => {
  const command = buildClaudeLoginCommand();

  assert.match(command, /\/bin\/unlink "\$browser_launcher"/);
  assert.match(command, /\/bin\/rmdir "\$browser_dir"/);
  assert.doesNotMatch(command, /rm -rf/);
});

test("the login command gives each Claude login an isolated browser profile", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-private-browser-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const fakeBrowser = join(fixtureRoot, "fake-browser");
  const capturedHelper = join(fixtureRoot, "captured-helper");
  const capturedPath = join(fixtureRoot, "captured-path");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      '/bin/cp "$BROWSER" "$BB_SWITCH_CAPTURE_HELPER"',
      '/usr/bin/printf \'%s\\n\' "$BROWSER" > "$BB_SWITCH_CAPTURE_PATH"',
    ].join("\n"),
  );
  await chmod(fakeClaude, 0o755);
  await writeFile(
    fakeBrowser,
    [
      "#!/bin/sh",
      ': > "$BB_SWITCH_BROWSER_ARGS"',
      'profile_dir=""',
      'for argument in "$@"; do',
      '  /usr/bin/printf \'%s\\n\' "$argument" >> "$BB_SWITCH_BROWSER_ARGS"',
      '  case "$argument" in --user-data-dir=*) profile_dir="${argument#--user-data-dir=}" ;; esac',
      "done",
      'test -n "$profile_dir" || exit 2',
      '/usr/bin/touch "$profile_dir/SingletonLock"',
      '/usr/bin/touch "$BB_SWITCH_BROWSER_READY"',
      'while test ! -f "$BB_SWITCH_BROWSER_RELEASE"; do /bin/sleep 0.02; done',
      '/bin/unlink "$profile_dir/SingletonLock"',
    ].join("\n"),
  );
  await chmod(fakeBrowser, 0o755);

  try {
    const result = spawnSync("/bin/sh", ["-c", buildClaudeLoginCommand()], {
      env: {
        ...process.env,
        BB_SWITCH_CAPTURE_HELPER: capturedHelper,
        BB_SWITCH_CAPTURE_PATH: capturedPath,
        PATH: `${fixtureRoot}:/usr/bin:/bin`,
        TMPDIR: fixtureRoot,
      },
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const helper = await readFile(capturedHelper, "utf8");
    assert.match(helper, /--user-data-dir/);
    assert.match(helper, /google-chrome-stable/);
    assert.match(helper, /chromium-browser/);
    const ephemeralPath = (await readFile(capturedPath, "utf8")).trim();
    assert.match(ephemeralPath, /^.+\/bb-claude-login\.[^/]+\/open-private-chrome$/);
    await assert.rejects(access(ephemeralPath));

    const launch = async (suffix: string) => {
      const argsPath = join(fixtureRoot, `browser-args-${suffix}`);
      const readyPath = join(fixtureRoot, `browser-ready-${suffix}`);
      const releasePath = join(fixtureRoot, `browser-release-${suffix}`);
      const launched = spawnSync(
        capturedHelper,
        ["https://claude.ai/oauth/authorize"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            BB_CLAUDE_LOGIN_BROWSER: fakeBrowser,
            BB_SWITCH_BROWSER_ARGS: argsPath,
            BB_SWITCH_BROWSER_READY: readyPath,
            BB_SWITCH_BROWSER_RELEASE: releasePath,
            PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
            TMPDIR: fixtureRoot,
          },
        },
      );
      assert.equal(launched.status, 0, launched.stderr);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        try {
          await access(readyPath);
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      const args = (await readFile(argsPath, "utf8")).trim().split("\n");
      const profileArgument = args.find((argument) =>
        argument.startsWith("--user-data-dir="),
      );
      assert.ok(profileArgument);
      return {
        profileDir: profileArgument.slice("--user-data-dir=".length),
        releasePath,
      };
    };

    const first = await launch("first");
    const second = await launch("second");
    assert.notEqual(first.profileDir, second.profileDir);
    assert.match(first.profileDir, /^.+\/bb-claude-browser-[^/]+$/);
    assert.match(second.profileDir, /^.+\/bb-claude-browser-[^/]+$/);

    await writeFile(first.releasePath, "release\n");
    await writeFile(second.releasePath, "release\n");
    for (const profileDir of [first.profileDir, second.profileDir]) {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        try {
          await access(profileDir);
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          break;
        }
      }
      await assert.rejects(access(profileDir));
    }

    const unsupported = spawnSync(
      capturedHelper,
      ["https://claude.ai/oauth/authorize"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          BB_CLAUDE_LOGIN_BROWSER: join(fixtureRoot, "missing-browser"),
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          TMPDIR: fixtureRoot,
        },
      },
    );
    assert.equal(unsupported.status, 78);
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

test("a BB terminal hangup exits promptly and removes the private-browser helper", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "bb-claude-login-hangup-"));
  const fakeClaude = join(fixtureRoot, "claude");
  const capturedPath = join(fixtureRoot, "captured-path");
  const capturedPid = join(fixtureRoot, "captured-pid");
  await writeFile(
    fakeClaude,
    [
      "#!/bin/sh",
      '/usr/bin/printf \'%s\\n\' "$BROWSER" > "$BB_SWITCH_CAPTURE_PATH"',
      '/usr/bin/printf \'%s\\n\' "$$" > "$BB_SWITCH_CAPTURE_PID"',
      "while :; do /bin/sleep 1; done",
    ].join("\n"),
  );
  await chmod(fakeClaude, 0o755);

  const child = spawn("/bin/zsh", ["-c", buildClaudeLoginCommand()], {
    env: {
      ...process.env,
      BB_SWITCH_CAPTURE_PATH: capturedPath,
      BB_SWITCH_CAPTURE_PID: capturedPid,
      PATH: `${fixtureRoot}:/usr/bin:/bin`,
      TMPDIR: fixtureRoot,
      ZDOTDIR: fixtureRoot,
    },
    stdio: "ignore",
  });

  let fakeClaudePid: number | undefined;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(capturedPid);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const ephemeralPath = (await readFile(capturedPath, "utf8")).trim();
    fakeClaudePid = Number((await readFile(capturedPid, "utf8")).trim());
    assert.ok(Number.isSafeInteger(fakeClaudePid));

    const exited = new Promise<"exited">((resolve) => {
      child.once("exit", () => resolve("exited"));
    });
    child.kill("SIGHUP");
    const outcome = await Promise.race([
      exited,
      new Promise<"still-running">((resolve) => {
        setTimeout(() => resolve("still-running"), 500);
      }),
    ]);

    assert.equal(outcome, "exited");
    await assert.rejects(access(ephemeralPath));
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (fakeClaudePid !== undefined) {
      try {
        process.kill(fakeClaudePid, "SIGKILL");
      } catch {
        // The fake may already have exited with its parent shell.
      }
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

  const command = (buildCommand as () => string)();
  assert.match(command, /claude.*auth.*status.*--json/);
  assert.match(command, /loggedIn/);
  assert.match(command, /authMethod/);
  assert.match(command, /apiProvider/);
  assert.match(command, /subscriptionType/);
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
    ["-c", loginTerminal.buildClaudeAuthStatusCommand(200)],
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
        1_000,
      );
      child.once("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.includes("subscriptionType=max")) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(child.exitCode, null);
    assert.equal(
      output,
      "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\n",
    );
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("auth-status helper did not self-exit")),
        1_000,
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
    ["-c", loginTerminal.buildClaudeAuthStatusCommand(200)],
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
    "subscriptionType=max",
    "",
  ].join("\r\n");
  assert.deepEqual((parse as (value: string) => unknown)(output), {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
    subscriptionType: "max",
  });
});

test("auth status fails closed on unsafe or incomplete output", () => {
  const parse = Reflect.get(loginTerminal, "parseClaudeAuthStatus") as (
    value: string,
  ) => unknown;

  for (const output of [
    "loggedIn=true\nauthMethod=apiKey\napiProvider=firstParty\nsubscriptionType=max\n",
    "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\n",
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
        return "loggedIn=true\nauthMethod=claude.ai\napiProvider=firstParty\nsubscriptionType=max\n";
      },
    },
    "thread_1",
    { sleep: async () => undefined, timeoutMs: 15_000 },
  );

  assert.deepEqual(status, {
    apiProvider: "firstParty",
    authMethod: "claude.ai",
    loggedIn: true,
    subscriptionType: "max",
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

test("a failed terminal login does not report success", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("exited", 1)];

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1"),
    /did not finish successfully/,
  );
  assert.deepEqual(closes, ["if-clean"]);
});

test("an unsupported session browser produces a clear account-login error", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const states = [terminal("exited", 78)];

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1"),
    /requires Google Chrome or Chromium on this session's macOS or Linux machine/,
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

test("a cancelled login stops before another poll and is force-closed", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const controller = new AbortController();
  const states = [terminal("running"), terminal("exited", 0)];
  let sleeps = 0;
  controller.abort();

  await assert.rejects(
    runClaudeLogin(client(states, closes), "thread_1", {
      signal: controller.signal,
      sleep: async () => {
        sleeps += 1;
      },
    }),
    /cancelled/,
  );
  assert.equal(sleeps, 0);
  assert.deepEqual(closes, ["force"]);
});

test("cancellation wakes a pending poll without waiting for its timer", async () => {
  const closes: Array<"force" | "if-clean"> = [];
  const controller = new AbortController();
  let pollStarted!: () => void;
  let releasePoll!: () => void;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const blockedPoll = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  const running = runClaudeLogin(client([terminal("running")], closes), "thread_1", {
    signal: controller.signal,
    sleep: async () => {
      pollStarted();
      await blockedPoll;
    },
  });
  await started;

  controller.abort();
  const outcome = await Promise.race([
    running.catch((error: unknown) => error),
    new Promise<"still waiting">((resolve) => {
      setTimeout(() => resolve("still waiting"), 25);
    }),
  ]);

  releasePoll();
  await running.catch(() => undefined);
  assert.notEqual(outcome, "still waiting");
  assert.match(String(outcome), /cancelled/);
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
    close: async () => undefined,
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
  let settled = false;
  await runClaudeLogin(
    {
      close: async () => {
        throw new Error("already gone");
      },
      create: async () => terminal("exited", 0),
      get: async () => terminal("exited", 0),
      onSettled: () => {
        settled = true;
      },
    },
    "thread_1",
  );
  assert.equal(settled, false);
});
