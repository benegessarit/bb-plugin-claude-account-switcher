# Review instructions

## Review priorities

1. A selected session must never be deliberately released when BB reports it active, starting, or stopping.
2. A failed turn must never be retried automatically; the next message starts after runtime release.
3. Credentials, raw auth output, and account identity must never enter the plugin RPC surface or be stored or logged. A one-time authorization code may cross RPC only after terminal echo is disabled; it must be one bounded printable line, one terminal-input call may be in flight, a reported delivery failure may be retried on the same operation, and the code must never be stored or logged.
4. Cancellation must be truthful before and after successful machine-wide login.
5. Account-changing login must follow the `BROWSER` adapter contract in `CLAUDE.md`: at most one Chrome invocation per operation, normal-cookie isolation without a profile override, no OS-window guarantee, and no email collection.
6. A helper-terminal record may be removed only after BB reports `exited`. Disconnection, a thrown close, or a newer plugin generation must retain or recover durable ownership.
7. Admission, cancellation, code input, attachment, and completion must target one exact operation. A remount must not create a second operation or report completion twice.
8. Visible workflow changes need focused component tests. The generated app bundle must also activate through BB's shared-runtime seam; source tests alone are not package proof.
9. A release must include its built `dist/` bundle and pass package dry-run inspection.

## Product boundary

This plugin rebinds one loaded BB runtime to a machine-wide Claude subscription login. It does not provide permanent per-session account isolation. BB 0.38 leaves a small non-atomic window between the final state check and runtime release.

## Installed-browser test decision

Playwright is not adopted for this release candidate. BB 0.39 publishes a supported server-only `bb-server --data-dir <path> --server-port <port>` route, and a CLI can install this path plugin into that disposable server. That route cannot create or drive the required host-backed Claude thread: the journey needs an enrolled execution machine, host-scoped terminals, and BB's reported Claude executable. Production has no supported fake-host, fake-Claude, or fake-browser binding. A server-only browser test would duplicate asset and component checks while skipping the load-bearing flow; adding a daemon or hidden production override is outside this plugin-only slice.

## Ignore

- Style-only nits that do not hide a defect.
- Broad rewrites unrelated to the session-rebinding contract.
- Speculative abstractions without a demonstrated caller, repeated rule, or failure mode.
- Publication suggestions that do not identify a concrete correctness, security, packaging, or reviewability defect.
