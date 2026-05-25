# Internals

Technical details for contributors and curious readers.

## Architecture

```
addon/          MailExtension (thin relay, runs inside Betterbird)
native-host/    Native Messaging host (Node.js), spawned by addon
  src/
    host.mjs      Entry point, RPC dispatcher
    http.mjs      Unix socket HTTP server
    config.mjs    Config loader (XDG paths)
    webhook.mjs   Optional outbound webhook delivery
    rpc/
      handlers/   read.mjs, write.mjs, compose.mjs
      utils.mjs   Shared helpers (topN heap, folder walker)
      pagination.mjs  Page iteration + sorted collection
      mail.mjs    Special folder lookup, inline text extraction
      compose.mjs Compose detail builder, attachment uploader
scripts/        Build, deploy, smoke test, bb-rpc helper
skill/          OpenClaw skill definition
```

The addon is intentionally kept as a **thin relay** — it only handles four message types (`api.call`, `binary.getAttachment`, `binary.getRaw`, `compose.addAttachment`). All business logic lives in the native host.

## Transport

- **Unix domain socket** — no TCP listener, no token auth
- Socket path defaults to `$XDG_RUNTIME_DIR/betterbird-bridge/bridge.sock` (fallback: `~/.cache/betterbird-bridge/bridge.sock`)
- Override via config file (`socketPath`) or env var `OPENCLAW_BB_SOCKET_PATH`
- Socket permissions: `0600` (owner-only)

This is a local-only, trusted-caller design. The OS file permissions are the security boundary.

## Config

`$XDG_CONFIG_HOME/betterbird-bridge/config.json` (defaults to `~/.config/betterbird-bridge/config.json`):

```json
{
  "socketPath": "/run/user/1000/betterbird-bridge/bridge.sock"
}
```

All fields are optional. The host uses sensible XDG-based defaults.

Optional new-mail webhook:

```json
{
  "webhooks": {
    "newMail": {
      "url": "https://example.invalid/mail-webhook",
      "headers": {
        "authorization": "***"
      },
      "timeoutMs": 10000,
      "payloadScript": "return { text: `收到一封新邮件：${JSON.stringify(messages)}`, mode: 'now' };"
    }
  }
}
```

New-mail webhook events are sourced from `messages.onNewMailReceived` after message filters and junk classification. The default payload is the raw message-header array from Thunderbird, matching the shape returned by `messages.unread`. Bodies and attachment bytes stay behind the local RPC API.

`payloadScript` is optional local/trusted JavaScript configuration. It is compiled as a function body and receives one argument: `messages`. The return value is JSON-serialized as the webhook body.

Delivery is best-effort: events are queued in memory, sent sequentially, and failures are reported in `/health` under `webhooks`.

## Installation Layout

### System-wide (requires sudo)

| Artifact | Location |
|----------|----------|
| Native host runtime + addon XPI | `/usr/lib/openclaw-betterbird-bridge/` |
| `bb-rpc` helper | `/usr/local/bin/bb-rpc` (symlink) |
| Native messaging manifest | `/usr/lib/mozilla/native-messaging-hosts/` |
| Enterprise policy | `<app-dir>/distribution/policies.json` (auto-detected) |

### Per-user

| Artifact | Location |
|----------|----------|
| Config | `$XDG_CONFIG_HOME/betterbird-bridge/config.json` |

### Why Enterprise Policy?

Betterbird (Thunderbird ESR) requires addon signatures for profile-level installs and doesn't support disabling this via `about:config`. The enterprise policy mechanism (`ExtensionSettings` with `force_installed`) bypasses signature checks and is the officially supported way to sideload addons on ESR builds.

## Available Methods

### Read

| Method | Params | Description |
|--------|--------|-------------|
| `ping` | `{}` | Health check, returns timestamp + browser info |
| `accounts.list` | `{includeSubFolders?}` | List all mail accounts with folder trees |
| `accounts.get` | `{accountId, includeSubFolders?}` | Get a single account |
| `folders.get` | `{folderId, includeSubFolders?}` | Get folder details |
| `folders.getSubFolders` | `{folderId, includeSubFolders?}` | Get subfolders |
| `folders.getFolderInfo` | `{folderId}` | Get folder message counts |
| `messages.list` | `{folderId}` | List messages in a folder |
| `messages.query` | `{queryInfo}` | Query messages with filter |
| `messages.get` | `{messageId}` | Get a single message header |
| `messages.read` | `{messageId, includeAttachments?}` | Get header + body (plain/html) + attachments list |
| `messages.latest` | `{folderId, count?}` | Latest N messages from a folder (default 10) |
| `messages.latestAll` | `{accountId?, count?}` | Latest N messages across all folders (default 10) |
| `messages.search` | `{folderId, queryInfo?, count?}` | Search with queryInfo filter |
| `messages.unread` | `{accountId?, folderId?, count?, markAsRead?}` | Unread messages across accounts/folders (default 25). When `markAsRead: true`, returned messages are marked as read after the response is prepared. |
| `messages.getRaw` | `{messageId}` | Full RFC 822 source as base64 |
| `attachments.get` | `{messageId, partName}` | Attachment content as base64 |
| `attachments.save` | `{messageId, partName}` | Same as attachments.get |

### Write

| Method | Params | Description |
|--------|--------|-------------|
| `messages.markRead` | `{messageIds}` | Mark as read |
| `messages.markUnread` | `{messageIds}` | Mark as unread |
| `messages.move` | `{messageIds, folderId}` | Move to folder |
| `messages.archive` | `{messageIds}` | Archive |
| `messages.trash` | `{messageIds}` | Move to trash |
| `messages.delete` | `{messageIds}` | Permanently delete |

### Compose

| Method | Params | Description |
|--------|--------|-------------|
| `compose.new` | `{to, cc?, bcc?, subject?, body?, isPlainText?, identityId?, attachments?}` | Send a new email |
| `compose.reply` | `{messageId, replyType?, body?, isPlainText?, identityId?, attachments?}` | Reply to a message |
| `compose.forward` | `{messageId, forwardType?, to, cc?, bcc?, body?, isPlainText?, identityId?, attachments?}` | Forward a message |

## Environment Overrides

| Env var | Description |
|---------|-------------|
| `BB_APP_DIR` | Force Betterbird/Thunderbird app directory (skips auto-detection) |
| `OPENCLAW_BB_CONFIG` | Override config file path |
| `OPENCLAW_BB_SOCKET_PATH` | Override Unix socket path |

## Development

```bash
./scripts/build.sh        # Build artifacts to dist/
./scripts/deploy.sh       # Install system-wide (requires sudo)
./scripts/smoke-test.sh   # Run smoke tests (Betterbird must be running)
```

`deploy.sh` intentionally does not auto-restart Betterbird — start it manually after deploy.
