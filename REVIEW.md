# Review instructions

## Review priorities

1. A selected session must never be deliberately released when BB reports it active, starting, or stopping.
2. A failed turn must never be retried automatically; the next message starts after runtime release.
3. Credentials, raw auth output, and account identity must never enter the plugin RPC surface or be stored or logged. A one-time authorization code may cross RPC only after terminal echo is disabled; it must be one bounded printable line and never be stored or logged.
4. Cancellation must be truthful before and after successful machine-wide login.
5. Account-changing login must follow the `BROWSER` adapter contract in `CLAUDE.md`: one atomic Chrome Incognito launch, no browser profile, and no email collection.
6. Visible workflow changes need focused component tests and an installed-plugin smoke.
7. A release must include its built `dist/` bundle and pass package dry-run inspection.

## Product boundary

This plugin rebinds one loaded BB runtime to a machine-wide Claude subscription login. It does not provide permanent per-session account isolation. BB 0.38 leaves a small non-atomic window between the final state check and runtime release.

## Ignore

- Style-only nits that do not hide a defect.
- Broad rewrites unrelated to the session-rebinding contract.
- Speculative abstractions without a demonstrated caller, repeated rule, or failure mode.
- Publication suggestions that do not identify a concrete correctness, security, packaging, or reviewability defect.
