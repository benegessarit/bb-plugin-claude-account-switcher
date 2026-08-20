# Claude Session Login for BB

Switch the machine-wide Claude subscription used by one BB Claude Code session without restarting BB. The plugin preserves the thread and its history. The next message starts a fresh Claude Code runtime with the verified login.

The session header button has two paths:

- **Use current login** verifies the Claude login already active on the session's machine, then releases only the selected session's loaded runtime.
- **Sign in to another account** starts Claude Code's standard subscription login through one Chrome Incognito window. This prevents an existing Claude website cookie from silently selecting the wrong account. Chrome may still offer passwords saved in the active profile.

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

From a local checkout:

```sh
npm ci
npm run build
bb plugin install .
```

Disable or remove it with `bb plugin disable claude-account-switcher` or `bb plugin remove claude-account-switcher`.

## Use

1. Wait until the Claude Code session is idle or in an error state.
2. Select **Switch Claude login** in that session's header.
3. Reuse the current machine login or sign in on Claude's website.
4. Leave the BB dialog open until Claude Code confirms the login. If Claude shows
   a one-time code instead of completing the browser callback, expand **Claude
   showed a code?** and submit it once.
5. Send the next message in the same thread.

BB opens one Incognito window and waits for Claude Code to finish. Reaching Claude's home screen without a successful CLI completion does not complete the switch.

## Security and limits

- BB plugins run with the user's BB privileges. This plugin can launch a host terminal command and stop the selected BB thread runtime. Install it only from a publisher you trust.
- The plugin never reads Claude credential files or macOS Keychain.
- The plugin gives Claude Code a short-lived browser launcher that opens Chrome with `--incognito --new-window`. It invokes the existing Chrome executable directly, without `open -n` or a temporary `--user-data-dir`, so Chrome can reuse its running application and profile password store while excluding normal Claude website cookies. The launcher accepts only HTTPS URLs and is removed after normal completion or graceful cancellation.
- The plugin uses the exact Claude Code executable reported by BB for the session's machine. It does not select Claude from the terminal's `PATH`.
- The small auth-status filtering helper uses `node` from the session machine's
  `PATH`. Treat that host `PATH` as part of the plugin's trust boundary.
- Raw `claude auth status` output never enters BB. A child process emits only `loggedIn`, `authMethod`, and `apiProvider` classifications.
- Account credentials stay in Claude Code and on Claude's site. A one-time
  authorization code is accepted only through the hidden fallback, after terminal
  echo is disabled; it is bounded to one printable line, forwarded once, and never
  stored or logged.
- A per-machine lock prevents overlapping login changes. If BB cannot stop a helper terminal, later switches on that machine remain blocked until cleanup succeeds.
- Claude login is machine-wide, not session-specific. Other already-loaded Claude sessions keep their current runtime until each one is released or restarted.
- BB cannot atomically combine the plugin's final idle check with runtime release. A message arriving in that small window can race the release. The plugin refuses every active, starting, or stopping state it can observe.
- The plugin never retries a failed turn automatically.

## Development checks

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

`dist/` is generated and ignored by Git. `npm pack` rebuilds it and includes only the distributable bundle declared by `package.json`.

Reload a locally installed checkout after successful checks:

```sh
bb plugin reload claude-account-switcher
```
