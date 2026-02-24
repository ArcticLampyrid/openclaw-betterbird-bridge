# openclaw-betterbird-bridge

A local Betterbird/Thunderbird MailExtension + native messaging host that exposes a small local HTTP API for interacting with the mailbox *through* Betterbird.

## Goal

Let OpenClaw (or any local script) do things like:

- list accounts + folders
- search messages
- read message bodies + attachments metadata

…without needing Microsoft Graph / OAuth setup. Betterbird already has the accounts configured.

## Architecture

- `addon/` — MailExtension (runs inside Betterbird)
- `native-host/` — Native Messaging host (Node.js) spawned by the addon
  - also exposes an HTTP API on `127.0.0.1` with a bearer token

## Install (dev)

### 1) Install native host manifest

```bash
cd /home/alampy/sources/openclaw-betterbird-bridge
./scripts/install-native-host.sh
```

Betterbird will look for the manifest under `~/.mozilla/native-messaging-hosts/`.

### 2) Create local config (HTTP port + token)

Create `~/.config/openclaw/betterbird-bridge.json`:

```json
{
  "port": 17380,
  "token": "<some-random-token>",
  "write": {
    "enabled": false,
    "allowHardDelete": false
  },
  "compose": {
    "enabled": false
  }
}
```

Write methods are **disabled by default**. To enable them, set `write.enabled: true`.
Compose/send methods are **disabled by default**. To enable them, set `compose.enabled: true`.
Hard delete (`messages.delete`) is additionally gated by `write.allowHardDelete: true` and `confirm: "DELETE"` per call.

### 3) Load the addon into Betterbird

Option A (recommended for fast testing; not persistent):

- Betterbird → **Tools** → **Developer Tools** → **Debug Add-ons**
- **Load Temporary Add-on…**
- select: `/home/alampy/sources/openclaw-betterbird-bridge/addon/manifest.json`

Option B (persistent):

```bash
./scripts/build-xpi.sh
```

Then install `dist/openclaw-betterbird-bridge.xpi` via Add-ons Manager.
(Unsigned add-on policies may apply.)

### 4) Test

Once the addon is loaded, it should spawn the native host, which starts an HTTP server on `127.0.0.1:17380`.

Health:

```bash
TOKEN=$(jq -r .token ~/.config/openclaw/betterbird-bridge.json)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:17380/health | jq
```

RPC example:

```bash
TOKEN=$(jq -r .token ~/.config/openclaw/betterbird-bridge.json)
curl -s -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "content-type: application/json" \
  --data '{"id":1,"method":"ping","params":{}}' \
  http://127.0.0.1:17380/rpc | jq
```

### Available Methods

| Method | Description |
|--------|-------------|
| `ping` | Health check, returns timestamp |
| `accounts.list` | List all accounts |
| `accounts.get` | Get account by ID |
| `folders.get` | Get folder by ID |
| `folders.getSubFolders` | Get subfolders of a folder |
| `messages.list` | List messages in a folder (returns MessageList) |
| `messages.query` | Query messages with filter |
| `messages.get` | Get single message header |
| `messages.read` | Get message header + body + attachments |
| `messages.latest` | Get latest N messages from a folder (returns headers only) |
| `messages.search` | Search messages with queryInfo (returns headers only) |
| `messages.unread` | Get unread messages across all accounts/folders (returns headers only, sorted by date desc) |
| `messages.markRead` | Mark messages as read *(write; supports `dryRun`)* |
| `messages.markUnread` | Mark messages as unread *(write; supports `dryRun`)* |
| `messages.move` | Move messages to a folder *(write; supports `dryRun`; can require `allowFolderIds`)* |
| `messages.archive` | Archive messages using Thunderbird settings *(write; supports `dryRun`; can require `allowFolderIds`)* |
| `messages.trash` | Move messages to their account trash folder *(write; supports `dryRun`; can require `allowFolderIds`)* |
| `messages.delete` | Permanently delete messages *(write; **gated**; supports `dryRun`; can require `allowFolderIds`)* |
| `compose.new` | Compose and send a new email *(compose; supports `dryRun`)* |
| `compose.reply` | Reply to a message *(compose; supports `dryRun`)* |
| `compose.forward` | Forward a message *(compose; supports `dryRun`)* |

### Compose guard rails

Compose methods (`compose.new`, `compose.reply`, `compose.forward`) are gated by `compose.enabled` in config (default: `false`).

- `dryRun: true` — validate and return a plan without actually sending.
- `compose.new` requires at least one `to` recipient.
- `compose.reply` / `compose.forward` require `messageId`.
- `compose.forward` additionally requires at least one `to` recipient.
- Attachments can be included as `[{ name, contentBase64, contentType }]`.

### Write guard rails

The HTTP server enforces a few safety defaults:

- `dryRun: true` — validate and return a plan without performing the write.
- `allowFolderIds: [ ... ]` — optional per-call allowlist. For destructive methods (move/archive/trash/delete), if provided, the current folder of each message must be in this list. For `messages.move`, the destination `folderId` must also be in the list.
- Write methods require `write.enabled: true` in config.
- `messages.delete` additionally requires `write.allowHardDelete: true` and `confirm: "DELETE"`.

### Smoke Test

```bash
./scripts/smoke-test.sh
```

## Status

- ✅ Project created in `/home/alampy/sources/openclaw-betterbird-bridge`
- ✅ Addon scaffold (accounts/folders/messages + basic write methods)
- ✅ Native host scaffold (Native Messaging framing + local HTTP RPC)
- ✅ End-to-end smoke test working inside Betterbird (`/health`, `ping`, `accounts.list`).
- ✅ OpenClaw skill created (`~/.openclaw/skills/betterbird-bridge/`) with helper script
- ✅ Request correlation IDs and improved error responses (method name in errors)
- ✅ Extended smoke tests (folders, message body, attachments, compose dryRun)

## Roadmap / TODO

See: [`TODO.md`](./TODO.md)
