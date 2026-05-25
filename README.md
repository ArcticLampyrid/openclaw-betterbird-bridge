# openclaw-betterbird-bridge

Let [OpenClaw](https://github.com/openclaw/openclaw) (or any local script) talk to your Betterbird / Thunderbird mailbox — read, search, compose, send, and organize mail — without OAuth or Microsoft Graph setup. Betterbird already has the accounts; this bridge just exposes them locally.

> [!NOTE]
> This project is fully developed & maintained by [OpenClaw](https://github.com/openclaw/openclaw) character **小雪** ❄️, with guidance from 萤火 ✨.

## How It Works

A MailExtension addon runs inside Betterbird and spawns a native messaging host (Node.js). The host exposes a local RPC API over a Unix domain socket. You call it with `bb-rpc`:

```
Your script / OpenClaw ──bb-rpc──▶ Unix socket ──▶ Native host ──▶ Addon ──▶ Betterbird APIs
```

## Quick Start

```bash
git clone https://github.com/ArcticLampyrid/openclaw-betterbird-bridge.git
cd openclaw-betterbird-bridge

# Build & install (requires sudo)
./scripts/build.sh
./scripts/deploy.sh

# Start Betterbird, then test:
bb-rpc ping '{}'
```

## Usage

```bash
bb-rpc <method> [json-params]
```

### Read Mail

```bash
bb-rpc messages.unread '{}'                                        # all unread mail
bb-rpc messages.unread '{"markAsRead":true}'                        # fetch unread then mark them read
bb-rpc messages.latest '{"folderId":"account1://INBOX","count":5}' # latest 5 in inbox
bb-rpc messages.read '{"messageId":12345}'                         # full body + attachments
bb-rpc messages.search '{"folderId":"ID","queryInfo":{"subject":"invoice"},"count":10}'
```

### Write / Organize

```bash
bb-rpc messages.markRead '{"messageIds":[12345]}'
bb-rpc messages.trash '{"messageIds":[12345]}'
bb-rpc messages.move '{"messageIds":[12345],"folderId":"TARGET_FOLDER_ID"}'
```

### Compose & Send

```bash
bb-rpc compose.new '{"to":"bob@example.com","subject":"Hello","body":"<p>Hi!</p>"}'
bb-rpc compose.reply '{"messageId":12345,"body":"<p>Thanks!</p>"}'
```

### New Mail Webhook

Optionally POST a JSON notification whenever Thunderbird/Betterbird reports newly received mail. The bridge subscribes with `monitorAllFolders=true`, so every folder is watched — not just inboxes. Add a `webhooks.newMail` block to `~/.config/betterbird-bridge/config.json` and restart Betterbird/Thunderbird:

```json
{
  "socketPath": "/run/user/1000/betterbird-bridge/bridge.sock",
  "webhooks": {
    "newMail": {
      "url": "https://example.invalid/mail-webhook",
      "headers": {
        "authorization": "***"
      },
      "timeoutMs": 10000
    }
  }
}
```

By default, the webhook body is the same message-header array shape returned by `messages.unread`:

```json
[
  {
    "id": 12345,
    "author": "alice@example.com",
    "subject": "Hello",
    "date": "...",
    "folder": { "accountId": "account1", "path": "/INBOX" }
  }
]
```

You can customize the posted body with JavaScript in `payloadScript`. The script receives one parameter, `event`, with `event.name` (e.g. `messages.newMail`) and `event.payload` (the default message-header array described above). Return a string to send it verbatim (already-encoded JSON, plain text, etc.); return any other value to have it JSON-encoded for you. For example, to call an OpenClaw-style wake webhook:

```json
{
  "webhooks": {
    "newMail": {
      "url": "https://example.invalid/openclaw/wake",
      "payloadScript": "return { text: `收到一封新邮件：${JSON.stringify(event.payload)}`, mode: 'now' };"
    }
  }
}
```

Message bodies and attachment contents are not pushed by default; call `messages.read` if your receiver needs the full content.

### All Methods

See [INTERNALS.md](INTERNALS.md#available-methods) for the complete method reference.

## OpenClaw Skill

If you use OpenClaw, symlink the included skill for automatic discovery:

```bash
ln -s /path/to/openclaw-betterbird-bridge/skill ~/.openclaw/skills/betterbird-bridge
```

## Requirements

- Betterbird or Thunderbird (Linux, tested on Betterbird 140+)
- Node.js (for the native host)
- `jq` and `curl` (for the `bb-rpc` helper)

## License

MIT
