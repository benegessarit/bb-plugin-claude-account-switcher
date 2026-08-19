# Claude Session Login for BB

This plugin rebinds one BB Claude Code session to the verified subscription login on its exact machine.

- Keep `Use current login` as the default. It must not open OAuth or require email.
- Keep browser login optional. Email is only an optional prefill.
- Open account-changing login in a unique temporary Chrome or Chromium profile so no existing browser cookie can silently select the old account.
- Support macOS and Linux session machines. Refuse account-changing login clearly when neither Chrome nor Chromium is available.
- Never read credentials, Keychain, email identity, organization identity, or raw auth output.
- Refuse active, starting, and stopping sessions before login or release.
- Preserve exact failed-request matching and the per-machine lock.
- Treat successful login exit as the irreversible commit point.
- Keep errors inline while the dialog is open. Use toasts only after it closes.
- Use BB theme tokens and its native tooltip. Keep the header control quiet and compact.
- Test behavior before implementation. Run `npm test`, `npm run typecheck`, and `npm run format:check` before commit.
- Reload the installed local source only after those checks pass.
