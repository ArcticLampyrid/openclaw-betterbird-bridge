# TODO / Roadmap

## P0 — safety + write actions
- [ ] Add write methods (with safety defaults):
  - [ ] `messages.markRead` / `messages.markUnread`
  - [ ] `messages.move`
  - [ ] `messages.archive` (if applicable; otherwise map to move)
  - [ ] `messages.trash` (default instead of hard delete)
  - [ ] `messages.delete` (hard delete; gated/explicit)
- [ ] Add “guard rails”:
  - [ ] `dryRun: true` option for write methods
  - [ ] allowlist of folderIds for destructive actions
  - [ ] explicit confirmation/gating for `delete`

## P1 — attachments + exports
- [ ] Attachment content download/export:
  - [ ] `attachments.get` (base64 or stream)
  - [ ] `attachments.save` (save to a temp dir and return path)
- [ ] Message export helpers:
  - [ ] raw source / `.eml` export (if API allows)

## P2 — OpenClaw integration
- [ ] Add an OpenClaw skill/client wrapper for the local HTTP RPC.
- [ ] Convenience endpoints for common workflows (latest in inbox, search by sender/subject, etc.).

## P3 — reliability, UX, and packaging
- [ ] Improve error surfaces (propagate addon error details to HTTP client).
- [ ] Better logging + request correlation id.
- [ ] More smoke tests (folders, read body, attachments, pagination edge cases).
- [ ] Packaging/versioning notes; document required Thunderbird/Betterbird versions and permissions.
