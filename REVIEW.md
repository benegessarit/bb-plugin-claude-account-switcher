# Review instructions

## Review priorities

1. A selected session must never be deliberately released when BB reports it active, starting, or stopping.
2. A rate-limited turn must be retried only when its failed request identifier is unchanged.
3. Email, authorization codes, raw terminal output, credentials, and account identity must never be stored or logged.
4. Cancellation must be truthful before and after successful machine-wide login.
5. Visible workflow changes need focused component tests and an installed-plugin smoke.

## Product boundary

This plugin rebinds one loaded BB runtime to a machine-wide Claude subscription login. It does not provide permanent per-session account isolation. BB 0.38 leaves a small non-atomic window between the final state check and runtime release.

## Ignore

- Style-only nits that do not hide a defect.
- Broad rewrites unrelated to the session-rebinding contract.
- GitHub, CI, marketplace, or publication suggestions for this local-only tool.
