# TODO / Roadmap

## P0 — safety + write actions
- [x] Add write methods (with safety defaults):
  - [x] `messages.markRead` / `messages.markUnread`
  - [x] `messages.move`
  - [x] `messages.archive` (if applicable; otherwise map to move)
  - [x] `messages.trash` (default instead of hard delete)
  - [x] `messages.delete` (hard delete; gated/explicit)
- [x] Add "guard rails":
  - [x] `dryRun: true` option for write methods
  - [x] allowlist of folderIds for destructive actions
  - [x] explicit confirmation/gating for `delete`

## P1 — attachments + exports
- [x] Attachment content download/export:
  - [x] `attachments.get` (base64)
  - [x] `attachments.save` (returns base64; host can write to disk)
- [x] Message export helpers:
  - [x] `messages.getRaw` (full RFC 822 source as base64)

## P2 — compose + send
- [x] Add compose/send methods:
  - [x] `compose.new` — create and send a new email
  - [x] `compose.reply` — reply to a message
  - [x] `compose.forward` — forward a message
- [x] Add compose guard rails:
  - [x] `compose.enabled` config gate (disabled by default)
  - [x] `dryRun` support (validate + return plan without sending)
- [x] Add `compose` + `compose.send` permissions to manifest.json

## P3 — OpenClaw integration
- [ ] Add an OpenClaw skill/client wrapper for the local HTTP RPC.
- [ ] Convenience endpoints for common workflows (latest in inbox, search by sender/subject, etc.).

## P4 — reliability, UX, and packaging
- [ ] Improve error surfaces (propagate addon error details to HTTP client).
- [ ] Better logging + request correlation id.
- [ ] More smoke tests (folders, read body, attachments, pagination edge cases).
- [ ] Packaging/versioning notes; document required Thunderbird/Betterbird versions and permissions.
