# Security Policy

## Reporting a vulnerability

Please use GitHub's private reporting: the **Report a vulnerability** button under the repository's [Security tab](https://github.com/Paraxdev/neocad/security/advisories/new). Do not open a public issue for anything security-sensitive.

Neocad is a small project. If a report is valid the fix ships in the next release, and the advisory is credited to you unless you prefer otherwise.

## Supported versions

Only the latest release is supported; older installers are not patched.

## Scope

In scope:

- the desktop app: Tauri shell (Rust), webview frontend (TypeScript), bundled Python geometry sidecar
- the localhost sidecar WebSocket (token-gated, bound to 127.0.0.1)
- the signed update pipeline (release artifacts and `latest.json`)
- document parsing: `.sindri` files and imported STL/3MF/STEP/OBJ
- the printers you configure on your own LAN

Neocad has no accounts and no backend. It makes no network calls of its own except the update check and the printers you point it at, so there is no hosted service in scope.

Out of scope: vulnerabilities that require an already-compromised machine, and reports from automated scanners without a plausible impact.
