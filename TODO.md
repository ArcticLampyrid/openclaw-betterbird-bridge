# TODO / Roadmap

## P0 — safety + write actions
- [x] Add write methods (with safety defaults):
  - [x] `messages.markRead` / `messages.markUnread`
  - [x] `messages.move`
  - [x] `messages.archive` (if applicable; otherwise map to move)
  - [x] `messages.trash` (default instead of hard delete)
  - [x] `messages.delete` (hard delete; gated/explicit)
- [x] Add "guard rails":
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
- [x] Add `compose` + `compose.send` permissions to manifest.json

## P3 — OpenClaw integration
- [x] Add an OpenClaw skill/client wrapper for the local HTTP RPC.
  - [x] `SKILL.md` — full method reference, workflows, safety notes
  - [x] `scripts/bb-rpc.sh` — helper script for quick RPC calls
- [x] Convenience endpoints for common workflows:
  - [x] `messages.latest` — optimized with page-skipping via `getFolderInfo`
  - [x] `messages.latestAll` — cross-folder latest (queries each folder's tail, merges)
  - [x] `messages.search` — search with newest-first sorting

## P4 — reliability, UX, and packaging
- [x] Improve error surfaces (propagate addon error details to HTTP client).
  - [x] Include method name in error responses
- [x] Better logging + request correlation id.
  - [x] Auto-generate correlation id (`auto-<uuid>`) when client omits `id`
- [x] More smoke tests (folders, read body, attachments, pagination edge cases).
  - [x] `folders.get` test
  - [x] `messages.read` body test
  - [x] Attachments list test
  - [x] `compose.new` test
  - [x] Graceful fallback for empty results
- [ ] Packaging/versioning notes; document required Thunderbird/Betterbird versions and permissions.
