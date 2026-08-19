# Claude Session Login for BB

This local BB plugin rebinds one existing Claude Code session to the verified Claude subscription login on that session's machine. It removes the need to restart BB after changing Claude accounts.

The header button has two paths:

- **Use current login** verifies the machine's existing Claude subscription, releases only the selected session's loaded runtime, and either retries its exact rate-limited turn or waits for the next message.
- **Sign in to another account** opens Claude's own subscription login in an isolated Chrome or Chromium profile with no existing account cookies. The email field is only an optional prefill.

Claude login remains machine-wide. Rebinding a BB session does not create per-session credential isolation. BB 0.38 also cannot atomically combine the plugin's final idle check with runtime release, so another sender can create a small race. The plugin refuses every state it observes as active, starting, or stopping.

## Safety

- The plugin never reads Claude credential files or macOS Keychain.
- Raw `claude auth status` output never enters BB. A child process emits only four classification fields.
- Email and authorization codes stay transient and are never stored or logged.
- Each account-changing login gets a unique temporary browser profile. BB removes it after that browser closes without touching regular browser data.
- Account-changing login supports Chrome or Chromium on macOS and Linux. Other session machines get a clear refusal; current-login rebinding still works.
- Rate-limit retry requires the same failed request before and after login.
- A per-machine lock prevents overlapping login changes.

## Development

```sh
npm ci
npm test
npm run typecheck
npm run format:check
```

The installed plugin uses this directory as a local BB source. Reload it with `bb plugin reload claude-account-switcher` after a successful build.
