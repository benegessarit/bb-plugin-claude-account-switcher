# Claude Account Switcher for BB

Switch the machine-wide Claude subscription used by one BB Claude Code session without restarting BB. The plugin preserves the thread and its history. The next message starts a fresh Claude Code runtime with the verified login.

This is a thread-level session tool, not a general Claude credential manager. It changes Claude Code's machine-wide login, verifies the subscription, and releases only the selected BB session's loaded runtime.

The session header button has two paths:

- **Use current login** verifies the Claude login already active on the session's machine, then asks BB to release the selected session's loaded runtime.
- **Sign in to another account** starts Claude Code's standard subscription login and makes one automatic Chrome Incognito handoff. When an Incognito window remains open, Chrome adds the authorization tab there instead of forcing another window. Normal-window cookies are not used, but already-open Incognito windows share one session. Chrome may offer passwords from the active profile; BB never reads or copies them.
- **Return to authorization** appears while Claude Code is waiting for the browser. If the browser leaves the pending flow, this reopens the exact pending consent page in the same Incognito session without restarting the BB switch.

## Requirements

- BB 0.38 or newer.
- macOS or Linux for BB and the target session machine. The host helpers require
  `/bin/sh`, `/bin/stty`, and `mktemp` at `/usr/bin`, `/bin`, or on the trusted
  host `PATH`.
- Claude Code available on the session machine, with Node.js available as `node`
  on that machine's trusted `PATH`.
- A Claude.ai Pro, Max, Team, or Enterprise login. Console/API-key authentication is intentionally rejected.
- Google Chrome available in its standard macOS location, or Chrome/Chromium on the target machine's trusted `PATH`, for the account-changing path. **Use current login** does not require a browser.

## Install

After the public repository and `v0.1.0` tag exist, install the supported release range:

```sh
bb plugin install "git:https://github.com/benegessarit/bb-plugin-claude-account-switcher.git@semver:^0.1.0"
```

For local development, install from a checkout:

```sh
npm ci
npm run build
bb plugin install .
```

Disable or remove it with `bb plugin disable claude-account-switcher` or `bb plugin remove claude-account-switcher`.

## Reporting problems

Use [GitHub Issues](https://github.com/benegessarit/bb-plugin-claude-account-switcher/issues) for reproducible bugs. For a security problem, open a non-sensitive issue asking for a private reporting channel. Never include OAuth codes, credentials, raw authentication output, vulnerability details, or private account details in a public report.

## Use

1. Wait until the Claude Code session is idle or in an error state.
2. Select **Switch Claude login** in that session's header.
3. Reuse the current machine login or sign in on Claude's website.
4. Leave the BB dialog open until Claude Code confirms the login. If the browser
   leaves the pending flow, leave that Incognito window open and select **Return
   to authorization** in BB. If Claude shows a one-time code
   instead, expand **Claude showed a code?** and submit it. BB blocks overlapping
   actions and keeps the same operation retryable when safe.
5. Send the next message in the same thread.

BB makes one automatic browser handoff for each switch. **Return to authorization** can deliberately reopen the same pending consent URL without starting a second Claude login. If an Incognito window remains open, Chrome adds each handoff as a tab in the most recently active Incognito window; otherwise it creates a new one. Closing every Incognito window ends that temporary browser session. Reaching Claude's home page without a successful CLI completion does not complete the switch.

The switch itself is server-owned. Closing and reopening the BB surface reattaches
to the same operation, including its current cleanup, login, verification, or
release step. Closing the dialog explicitly requests cancellation; navigating
away does not.

## Security and limits

- BB plugins run with the user's BB privileges. This plugin can launch a host terminal command and stop the selected BB thread runtime. Install it only from a publisher you trust.
- The plugin never reads Claude credential files or macOS Keychain.
- The plugin gives Claude Code a short-lived browser launcher that captures Claude's native localhost callback without opening Chrome. The observer is the sole automatic opener and invokes Chrome with `--incognito`, deliberately omitting `--new-window` so an existing Incognito window can be reused. Claude's printed manual-code URL is retained only as a delayed fallback. The native callback has explicit priority and atomically replaces that fallback even if it arrives later. The launcher accepts only Claude's exact HTTPS consent route with the required OAuth fields and either an exact `http://localhost:<port>/callback` redirect or Claude's exact manual-code redirect. It keeps the selected URL in a mode-`0600` operation-local temporary file so an explicit **Return to authorization** can reopen it. The URL never enters the plugin frontend, RPC payloads, BB storage, or logs.
- The launcher invokes the existing Chrome executable directly, without `--new-window`, `open -n`, or a temporary `--user-data-dir`. This excludes normal-window cookies, not the session shared by already-open Incognito windows. Password availability is controlled by Chrome's active profile, settings, and policy. The plugin never reads or copies passwords. Normal completion and graceful cancellation remove the launcher, URL, and claim. A machine or terminal `SIGKILL` can leave that owner-only temporary directory for the operating system's temporary-file cleanup.
- The plugin uses the exact Claude Code executable reported by BB for the session's machine. It does not select Claude from the terminal's `PATH`.
- The small auth-status filtering helper uses `node` from the session machine's
  `PATH`. Treat that host `PATH` as part of the plugin's trust boundary.
- Raw `claude auth status` output never enters BB. A child process emits only `loggedIn`, `authMethod`, and `apiProvider` classifications.
- Account credentials stay in Claude Code and on Claude's site. A one-time
  authorization code is accepted only through the hidden fallback, after terminal
  echo is disabled; it is bounded to one printable line, never stored or logged,
  and only one terminal-input call can be in flight. A failed call leaves the same
  operation available for a deliberate retry.
- Exact per-machine leases prevent overlapping login changes. Every helper terminal is recorded before BB observes it. A helper leaves that durable ledger only after BB reports it exited. If cleanup cannot be proved, the record survives plugin reload and later switches on that machine remain blocked.
- Claude login is machine-wide, not session-specific. Other already-loaded Claude sessions keep their current runtime until each one is released or restarted.
- BB cannot atomically combine the plugin's final idle check with runtime release. A message arriving in that small window can race the release. The plugin refuses every active, starting, or stopping state it can observe.
- The plugin never retries a failed turn automatically.

## Development checks

```sh
npm ci
npm run check
```

`npm run check` verifies formatting and types, activates both the source app and
the generated app bundle, checks the installed BB SDK contract, rebuilds
`dist/`, and inspects the package contents. `dist/` is generated and ignored by
Git.

Reload a locally installed checkout after successful checks:

```sh
bb plugin reload claude-account-switcher
```

## License

MIT. See [LICENSE](LICENSE).
