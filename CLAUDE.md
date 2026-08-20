# Claude Account Switcher for BB

This plugin rebinds one BB Claude Code session to the verified subscription login on its exact machine.

- Keep `Use current login` as the default. It must not open OAuth or require email.
- Let `claude auth login --claudeai` own the normal-browser flow. Do not create browser profiles, inject `BROWSER`, launch Chrome directly, or collect an email address.
- Keep account selection and credentials on Claude's website.
- Resolve Claude Code from BB's host provider status and use that exact executable for login and verification. Never trust the terminal's `PATH` to select Claude.
- Accept a one-time authorization code only after the login terminal proves echo is disabled. Bound it to one printable line, forward it once, and never store or log it.
- Never read credentials, Keychain, email identity, organization identity, or raw auth output.
- Refuse active, starting, and stopping sessions before login or release.
- Never retry a failed turn automatically. Preserve the per-machine lock.
- Reconcile any failed helper-terminal cleanup before another switch can start on that machine.
- Treat successful login exit as the irreversible commit point.
- Keep errors inline while the dialog is open. Use toasts only after it closes.
- Use BB theme tokens and its native tooltip. Keep the header control quiet and compact.
- Test behavior before implementation. Run `npm test`, `npm run typecheck`, and `npm run format:check` before commit.
- Reload the installed local source only after those checks pass.
