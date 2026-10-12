# Probe

Compatibility probe for a Tauri 2 desktop stack across Linux, macOS and Windows.

A small demo application ("Probe") exercises one fixed set of library versions on every desktop
platform, so that anything platform-specific shows up in CI rather than on a user's machine.
The content is deliberately trivial: a local server with `/ping`, `/echo`, `/login` (email plus a
one-time code) and a WebSocket `/ws` that answers ping with pong.

## Layout

| Path | What |
|---|---|
| `crates/probe-core` | client library: `reqwest` + `rustls` (aws-lc-rs) + `rustls-platform-verifier`, `tokio-tungstenite`, ed25519 request signing, `keyring` secret storage |
| `crates/probe-server` | local demo server on `axum` (HTTP + WebSocket), library and binary |
| `crates/probe-app` | Tauri 2 shell: window, tray, single instance, strict CSP, IPC commands |
| `ui` | React + Vite + TypeScript frontend, Vitest component tests, WebdriverIO E2E |
| `scripts` | launch check, E2E runner, CI summary, repository hygiene check |
| `docker` | Linux image for running everything locally |

## What CI checks

The workflow `.github/workflows/probe.yml` runs on pushes to `probe/**` branches, on Linux x64 and
arm64, Windows x64 and arm64, macOS arm64 and x64. Every check is a separate step; a failing check
does not stop the job, and the last step fails the job if any required check failed.

1. Build of the workspace and unit tests, including known-answer tests for the crypto crates.
2. TLS: HTTPS and WSS through one `rustls::ClientConfig` against a local server whose CA is
   generated inside the test; a foreign CA must be refused.
3. Secret storage on the native backend: Keychain, Credential Manager, Secret Service.
4. Frontend install, type check, unit tests, build, and `tauri build` (unsigned bundles, uploaded
   as artifacts).
5. Launch of the release binary: window, IPC, CSP violations, tray, second-instance handling.
6. The same WebdriverIO scenario with two drivers, five runs each:
   `external` (`tauri-driver` plus WebKitWebDriver or msedgedriver; not available on macOS) and
   `embedded` (`tauri-plugin-wdio-webdriver` behind the cargo feature `e2e`, debug builds only).
7. A summary table per job.

## Running locally on Linux (Docker)

```sh
docker build -t probe-dev docker
run() { docker run --rm -v "$PWD":/work -v probe-target:/work/target -v probe-nm:/work/ui/node_modules probe-dev bash -euc "$1"; }

run 'cargo test -p probe-core -p probe-server --locked'
run 'cd ui && pnpm install --frozen-lockfile && pnpm typecheck && pnpm test && pnpm build'
run 'cargo build --workspace --all-targets --locked && cargo test -p probe-app --locked'
run 'APPIMAGE_EXTRACT_AND_RUN=1 ui/node_modules/.bin/tauri build --bundles deb,appimage'
run 'scripts/gui.sh node scripts/launch-check.mjs target/release/probe-app target/debug/probe-server'
run 'scripts/e2e.sh external'
run 'cargo build -p probe-app --features custom-protocol,e2e --locked && scripts/e2e.sh embedded'
```

The keyring test needs an unlocked Secret Service:

```sh
run "dbus-run-session -- bash -c 'echo -n probe | gnome-keyring-daemon --components=secrets --daemonize --unlock >/dev/null && cargo test -p probe-core --locked --test store -- --ignored'"
```

## Notes

- Bundles are not code-signed; signing and notarization are out of scope.
- The `e2e` feature refuses to compile in release builds, so the embedded driver always tests a
  debug build and the external driver tests the release build.
- No certificates or keys are stored in the repository; tests generate what they need.
