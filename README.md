# Claude Session Login for BB

Switch the machine-wide Claude subscription used by one BB Claude Code session without restarting BB. The plugin preserves the thread and its history. The next message starts a fresh Claude Code runtime with the verified login.

The session header button has two paths:

- **Use current login** verifies the Claude login already active on the session's machine, then releases only the selected session's loaded runtime.
- **Sign in to another account** opens Claude's own login in a unique Chrome or Chromium profile with no existing account cookies. The optional email only pre-fills Claude's form; account selection and credentials stay on Claude's website.

## Requirements

- BB 0.38 or newer.
- Claude Code available on the session machine.
- A Claude.ai Pro, Max, Team, or Enterprise login. Console/API-key authentication is intentionally rejected.
- Chrome or Chromium on macOS or Linux for the account-changing path. **Use current login** does not require a browser.

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
4. Leave the BB dialog open until Claude Code confirms the login. If Claude displays an authorization code, expand **Claude showed a code?** and submit it once.
5. Send the next message in the same thread.

Landing on Claude's home screen after browser login is expected. The browser page does not redirect back to BB; the plugin waits for the Claude Code CLI to finish.

## Security and limits

- BB plugins run with the user's BB privileges. This plugin can launch a host terminal command, open an isolated browser profile, and stop the selected BB thread runtime. Install it only from a publisher you trust.
- The plugin never reads Claude credential files or macOS Keychain.
- Raw `claude auth status` output never enters BB. A child process emits only `loggedIn`, `authMethod`, and `apiProvider` classifications.
- Account credentials stay on Claude's site. An authorization code submitted in BB is forwarded once to the active Claude CLI process and is never stored or logged by the plugin.
- Every account-changing login uses a unique temporary browser profile. Cleanup targets only that generated profile and never regular browser data.
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

`dist/` is generated and ignored by Git. This repository is a local BB source, not a marketplace or npm release.

Reload a locally installed checkout after successful checks:

```sh
bb plugin reload claude-account-switcher
```
