# Claude Account Switcher for BB

This plugin rebinds one BB Claude Code session to the verified subscription login on its exact machine.

- Keep `Use current login` as the default. It must not open OAuth or require email.
- Let `claude auth login --claudeai` own authorization, but route its browser URL through one short-lived `BROWSER` launcher. Capture the first valid callback atomically and let the observer be the sole automatic Chrome opener. Invoke Chrome with `--incognito` and without `--new-window` so a remaining Incognito window is reused. While that same login is pending, allow an explicit **Return to authorization** action to reopen only the exact captured consent URL. Chrome owns process and OS-window reuse. Never use `open -n`, create a temporary browser profile, or collect an email address.
- Validate the exact Claude HTTPS consent route and required OAuth fields before opening or retaining it. Keep the URL only in an owner-readable operation-local temporary file; send only the validated launcher path through terminal output. Never put the URL in the frontend, RPC payloads, BB storage, or logs.
- Make authorization return operation-scoped and server-owned. Serialize it with authorization-code input, register the helper before awaiting it, and wait for any started helper during cancellation, settlement, and disposal. Do not create a second helper until an uncertain prior helper has been reconciled as exited.
- Keep account selection and credentials on Claude's website.
- Resolve Claude Code from BB's host provider status and use that exact executable for login and verification. Never trust the terminal's `PATH` to select Claude.
- Accept a one-time authorization code only after the login terminal proves echo is disabled. Bound it to one printable line, keep only one terminal-input call in flight, retain retry readiness after a reported delivery failure, and never store or log the code.
- Never read credentials, Keychain, email identity, organization identity, or raw auth output.
- Refuse active, starting, and stopping sessions before login or release.
- Never retry a failed turn automatically. Preserve the per-machine lock.
- Claim a thread before the first asynchronous admission check. Acknowledge the operation only after its exact machine lease is held. Keep completion receipts bounded and operation-scoped so remounts can reattach without starting again.
- Record every helper before polling or reading output. Remove it only after BB reports `exited`. Preserve unresolved ownership across reload and reconcile it before another switch can start on that machine.
- Treat successful login exit as the irreversible commit point.
- Keep errors inline while the dialog is open. Use toasts only after it closes.
- Use BB theme tokens and its native tooltip. Keep the header control quiet and compact.
- Test behavior before implementation. Run `npm test`, `npm run typecheck`, and `npm run format:check` before commit.
- Reload the installed local source only after those checks pass.
