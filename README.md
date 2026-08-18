# Claude Account Switcher for BB

This local BB plugin adds a **Switch Claude** button to Claude Code session
headers.

When a Claude subscription limit stops a session, the button performs one safe
recovery flow:

1. It confirms that BB has a retriable Claude limit failure.
2. It asks for the target Claude account email before opening the browser, so
   account selection does not leave Claude's OAuth flow.
3. It opens the normal `claude auth login --claudeai --email …` flow on that
   session's machine.
4. If Claude displays an authorization code instead of returning to the CLI,
   the dialog can send that code to the waiting login without storing it.
5. It waits for login to finish without reading or storing credentials.
6. It releases only the selected session's old Claude runtime.
7. It retries the same failed turn with the session history intact.

If login is cancelled or fails, the plugin does not stop or retry the session.
Closing the dialog or pressing **Cancel** also stops the pending login and
releases its machine lock, so the button can be used again immediately. The
plugin refuses a retry if the failed turn changes while login is open.

## Important limit

Claude Code's subscription login is machine-wide. This plugin does not create
true per-session account isolation. Other Claude sessions that restart on the
same machine can also use the newly selected account.

The login command runs on the machine assigned to the BB session. That machine
must have Claude Code installed and must be able to open the OAuth browser.

## Development

```sh
npm test
npm run typecheck
npm run build
bb plugin install .
```

No real login is used by the test suite.
