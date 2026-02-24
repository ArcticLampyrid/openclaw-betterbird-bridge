# openclaw-betterbird-bridge

A local Betterbird/Thunderbird MailExtension + native messaging host that exposes a small local RPC API (over Unix socket) for interacting with the mailbox *through* Betterbird.

## Goal

Let OpenClaw (or any local script) do things like:

- list accounts + folders
- search messages
- read message bodies + attachments metadata
- compose/send/reply/forward emails
- organize mail (mark read, move, archive, trash, delete)

…without needing Microsoft Graph / OAuth setup. Betterbird already has the accounts configured.

## Architecture

- `addon/` — MailExtension (runs inside Betterbird)
- `native-host/` — Native Messaging host (Node.js) spawned by the addon; also exposes an HTTP-style RPC API over a Unix domain socket

## Quick Start

```bash
# 1. Build
./scripts/build.sh

# 2. Deploy (system-wide install, requires sudo)
./scripts/deploy.sh

# 3. Start Betterbird/Thunderbird manually
betterbird   # or: thunderbird

# 4. Test
bb-rpc ping '{}'
```

`deploy.sh` intentionally does not auto-restart Betterbird/Thunderbird.
After `deploy.sh` completes, the source tree is no longer needed.

## What Gets Installed

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
| Config | `~/.config/openclaw/betterbird-bridge.json` (created if missing) |

### Why Enterprise Policy?

Betterbird (Thunderbird ESR) requires addon signatures for profile-level installs and doesn't support disabling this via `about:config`. The enterprise policy mechanism (`ExtensionSettings` with `force_installed`) bypasses signature checks entirely and is the officially supported way to sideload addons on ESR builds.

## Config

`~/.config/openclaw/betterbird-bridge.json`:

```json
{
  "socketPath": "/home/<user>/.cache/openclaw/betterbird-bridge.sock"
}
```

If `socketPath` is omitted, the host defaults to `~/.cache/openclaw/betterbird-bridge.sock`.

## Why No Method Permissions

- This bridge is designed for a trusted local automation caller (your own scripts/agents), so method-level allow/deny gates are intentionally removed.
- The security boundary is transport-level: the RPC service is exposed only via a Unix domain socket, not a TCP port.
- The socket file is created with owner-only permissions (`0600`), so only the same local OS user can connect.
- This keeps the implementation simpler and more predictable while still preventing remote network access.

## Testing

```bash
# Health check
bb-rpc ping '{}'

# List accounts
bb-rpc accounts.list '{}'

# Smoke test suite
./scripts/smoke-test.sh
```

## Available Methods

### Read Methods

| Method | Params | Description |
|--------|--------|-------------|
| `ping` | `{}` | Health check, returns timestamp + browser info |
| `accounts.list` | `{includeSubFolders?}` | List all mail accounts (with folder trees) |
| `accounts.get` | `{accountId, includeSubFolders?}` | Get a single account by ID |
| `folders.get` | `{folderId, includeSubFolders?}` | Get folder details by ID |
| `folders.getSubFolders` | `{folderId, includeSubFolders?}` | Get subfolders of a folder |
| `folders.getFolderInfo` | `{folderId}` | Get folder info (counts) |
| `messages.list` | `{folderId}` | List messages in a folder |
| `messages.query` | `{queryInfo}` | Query messages with filter |
| `messages.get` | `{messageId}` | Get a single message header |
| `messages.read` | `{messageId, includeAttachments?}` | Get header + body + attachments list |
| `messages.latest` | `{folderId, count?}` | Latest N messages from a folder (headers) |
| `messages.latestAll` | `{accountId?, count?}` | Latest N messages across all folders (headers) |
| `messages.search` | `{folderId, queryInfo?, count?}` | Search messages (headers) |
| `messages.unread` | `{accountId?, folderId?, count?}` | Unread messages across accounts/folders (headers) |
| `messages.getRaw` | `{messageId}` | Full RFC 822 source as base64 |
| `attachments.get` | `{messageId, partName}` | Attachment content as base64 |
| `attachments.save` | `{messageId, partName}` | Same as attachments.get |

### Write Methods

| Method | Params | Description |
|--------|--------|-------------|
| `messages.markRead` | `{messageIds}` | Mark as read |
| `messages.markUnread` | `{messageIds}` | Mark as unread |
| `messages.move` | `{messageIds, folderId}` | Move to folder |
| `messages.archive` | `{messageIds}` | Archive |
| `messages.trash` | `{messageIds}` | Move to trash |
| `messages.delete` | `{messageIds}` | Permanently delete |

### Compose Methods

| Method | Params | Description |
|--------|--------|-------------|
| `compose.new` | `{to, cc?, bcc?, subject?, body?, ...}` | Compose and send |
| `compose.reply` | `{messageId, replyType?, body?, ...}` | Reply |
| `compose.forward` | `{messageId, to, ...}` | Forward |

## Safety

- RPC is exposed via a Unix domain socket only (no TCP listener)
- Socket permissions are owner-only (`0600`)
- Betterbird must be running (native host is spawned by addon)

## Development

```bash
# Build distributable artifacts
./scripts/build.sh

# Deploy system-wide (requires sudo)
./scripts/deploy.sh

# Run smoke tests
./scripts/smoke-test.sh
```

### Overrides

| Env var | Description |
|---------|-------------|
| `BB_APP_DIR` | Force Betterbird/Thunderbird app directory (skips auto-detection) |
| `OPENCLAW_BB_CONFIG` | Override host config file path |
| `OPENCLAW_BB_SOCKET_PATH` | Override Unix socket path |
