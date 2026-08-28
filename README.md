# Claude Account Switcher for BB

BB keeps a Claude Code runtime loaded inside each thread. Changing the machine-wide Claude login does not replace that runtime, so an open thread can keep using the old account.

This plugin handles the handoff. It verifies the login on the thread's machine, then releases only that thread's runtime. The thread and its history stay in place. Your next message starts a fresh Claude Code runtime with the verified account.

> This is a thread-level handoff. It is not a credential manager, and it does not create permanent per-thread account isolation.

## What it does

- Choose **Use current login** to verify the Claude subscription already active on the machine. This path does not open a browser.
- Choose **Sign in to another account** to run Claude Code's standard subscription login. The plugin opens Chrome Incognito for authorization, keeping normal-window Claude cookies out of the flow.
- If the browser leaves the pending flow, **Return to authorization** reopens the same consent page without starting another login.

The plugin has no email field. Account selection and credentials stay on Claude's website.

## Requirements

- BB 0.38 or newer.
- A Claude.ai Pro, Max, Team, or Enterprise login. Console and API-key authentication are rejected.
- macOS or Linux on the target session machine.
- Claude Code and Node.js on that machine.
- `/bin/sh`, `/bin/stty`, and `mktemp` from `/usr/bin`, `/bin`, or the trusted host `PATH`.
- Google Chrome in its standard macOS location, or Chrome or Chromium on the trusted host `PATH`, when signing in to another account.

## Install

Install the latest compatible `0.1.x` release:

```sh
bb plugin install "git:https://github.com/benegessarit/bb-plugin-claude-account-switcher.git@semver:^0.1.0"
```

Install a local checkout for development:

```sh
npm ci
npm run build
bb plugin install .
```

Disable the plugin with `bb plugin disable claude-account-switcher`. Remove it with `bb plugin remove claude-account-switcher`.

## Use

1. Wait until the Claude Code thread is idle or showing an error.
2. Open **Switch Claude login** from that thread's header.
3. Reuse the current machine login or sign in on Claude's website.
4. Leave the dialog open until Claude Code confirms the login, then send your next message in the same thread.

If Claude shows a one-time code, expand **Claude showed a code?** and submit it in BB. If the browser lands on Claude's home page before the login finishes, keep that Incognito window open and choose **Return to authorization**.

Closing and reopening the BB surface reattaches to the same switch. Closing the dialog requests cancellation. Navigating away leaves the operation running so you can come back to it.

## Chrome and OAuth

Claude Code owns the OAuth flow. The plugin gives it a short-lived `BROWSER` command that receives the consent URL. The plugin validates that URL before opening Chrome.

- The plugin opens each consent URL automatically at most once. Most switches open one URL. If Claude first prints a manual fallback URL and later provides the preferred localhost callback URL, the corrected consent page opens once too. **Return to authorization** is the deliberate way to reopen the saved page.
- Chrome opens in Incognito without a temporary profile. Normal Chrome cookies stay out of the flow, while Chrome can still offer passwords from the active profile when its settings and policy allow it.
- The launcher does not request a new window. Chrome normally reuses an existing Incognito session, but Chrome owns the final window behavior. All open Incognito windows share one cookie session, so close them first when you need a completely fresh Claude sign-in.
- The consent URL stays in an owner-only temporary file. It never enters the plugin UI, BB storage, RPC payloads, or logs.

The plugin never reads or copies browser passwords, Claude credential files, or macOS Keychain data.

Normal completion and cancellation remove the temporary launcher and URL. A force-killed host process can leave the owner-only temporary directory for the operating system to clean up.

## Safety and limits

- BB runs plugins with your BB privileges. This plugin can launch a host terminal command and stop the selected thread's runtime. Install it only from a publisher you trust.
- The plugin refuses to switch an active, starting, or stopping thread.
- It verifies the exact machine that owns the thread and allows only one account change at a time on that machine.
- It uses the exact Claude Code executable that BB reports for the thread's machine.
- Unresolved helper processes remain recorded across plugin reloads. Another switch cannot start on that machine until cleanup is confirmed.
- Raw `claude auth status` output never enters BB. The verification helper returns only the fields needed to confirm a Claude subscription login.
- A one-time authorization code is accepted only after terminal echo is disabled. The code is bounded to one printable line and is never stored or logged.
- The plugin never retries a failed thread automatically.

Claude login is machine-wide. Other loaded Claude threads keep their current runtime until each one is released or restarted.

BB does not currently provide an atomic "release this runtime only if it is still idle" operation. A new message can race the final idle check and runtime release. Do not send another message in the thread until the switch finishes.

## Bugs and security

Open a [GitHub issue](https://github.com/benegessarit/bb-plugin-claude-account-switcher/issues) for a reproducible bug. Include the BB version, operating system, and steps to reproduce. Remove account details and authentication output first.

Report security problems privately through GitHub. See [SECURITY.md](SECURITY.md) for the reporting policy. Never put credentials, OAuth codes, vulnerability details, or private account information in a public issue.

## Development

```sh
npm ci
npm run check
```

`npm run check` checks formatting and type-checks the source. It builds both plugin bundles, runs the server and UI tests, verifies the installed BB SDK contract, and inspects the release package.

Reload an installed checkout after the checks pass:

```sh
bb plugin reload claude-account-switcher
```

## License

MIT. See [LICENSE](LICENSE).
