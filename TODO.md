# TODO / Roadmap

## Completed (current baseline)
- [x] Refactor native host into focused modules (`rpc/handlers`, pagination, mail/compose helpers).
- [x] Keep addon as a thin relay; move business logic into native host.
- [x] Improve binary/base64 handling in addon (`messages.getRaw`, attachments).
- [x] Improve HTTP error handling (invalid JSON, payload-too-large, structured JSON responses).
- [x] Move bridge transport from localhost token-auth HTTP to Unix domain socket (`socketPath`).
- [x] Remove method-level permission gates/guard rails for trusted local caller model.
- [x] Update helper scripts (`bb-rpc.sh`, `smoke-test.sh`, `build.sh`) for socket-based workflow.
- [x] Simplify deployment behavior: stop app parent process(es), install artifacts, require manual restart.

## P0 — reliability
- [ ] Add automated tests for RPC handlers (mocked `api` and `callAddon`).
- [ ] Add deployment verification command (single command to check socket + `ping`).
- [ ] Improve deploy failure diagnostics (clear hints when app starts but addon/native host is not connected).

## P1 — developer ergonomics
- [ ] Add a `bb-rpc wait` helper (poll `/health` or `ping` until ready / timeout).
- [ ] Add `deploy.sh --no-stop` mode for users who prefer manual shutdown.
- [ ] Add troubleshooting section for desktop-session startup caveats.

## P2 — feature polish
- [ ] Add optional convenience endpoint to save attachment directly to a host path.
- [ ] Add richer query presets (`today`, `last7d`, sender/domain shortcuts) on top of `messages.query`.
