---
name: betterbird-bridge
description: Interact with Betterbird/Thunderbird mailboxes via a local HTTP RPC bridge. Supports listing accounts, folders, messages, reading email bodies/attachments, searching, composing/sending, and write operations (mark read, move, archive, trash, delete). All calls go through a localhost HTTP endpoint with bearer token auth.
---

# Betterbird Bridge — Local Mail RPC

Control Betterbird/Thunderbird mailboxes through a local RPC server (over Unix domain socket) that talks to a MailExtension addon via Native Messaging.

## Prerequisites

- Betterbird (or Thunderbird) running with the `openclaw-betterbird-bridge` addon loaded
- Native host process running (auto-spawned by the addon)
- Unix socket available (default: `$XDG_RUNTIME_DIR/betterbird-bridge/bridge.sock`, fallback: `~/.cache/betterbird-bridge/bridge.sock`)

## Connection

**Transport:** Unix domain socket (owner-only `0600`)
**No authentication needed** — the socket's file permissions serve as the security boundary.

### Health Check

```bash
curl -s --unix-socket "$SOCKET_PATH" http://localhost/health | jq
```

### RPC Call Format

All RPC calls are `POST /rpc` with JSON body:

```bash
curl -s -X POST \
  --unix-socket "$SOCKET_PATH" \
  -H "content-type: application/json" \
  --data '{"id":1,"method":"METHOD_NAME","params":{...}}' \
  http://localhost/rpc | jq
```

Response: `{"id":1,"ok":true,"result":{...}}` or `{"id":1,"ok":false,"error":{"message":"...","method":"..."}}`

### Helper Script

Use `bb-rpc` (installed to PATH by deploy) for quick calls:

```bash
bb-rpc ping '{}'
bb-rpc accounts.list '{}'
bb-rpc messages.latest '{"folderId":"FOLDER_ID","count":5}'
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
| `folders.getFolderInfo` | `{folderId}` | Get folder info (totalMessageCount, unreadMessageCount, newMessageCount) |
| `messages.list` | `{folderId}` | List messages in a folder (returns MessageList) |
| `messages.query` | `{queryInfo}` | Query messages with filter object |
| `messages.get` | `{messageId}` | Get a single message header |
| `messages.read` | `{messageId, includeAttachments?}` | Get message header + body (plain/html) + attachments list |
| `messages.latest` | `{folderId, count?}` | Get latest N messages from a folder (headers only; default count=10) |
| `messages.latestAll` | `{accountId?, count?}` | Get latest N messages across ALL folders (headers only; default count=10) |
| `messages.search` | `{folderId, queryInfo?, count?}` | Search messages with queryInfo filter (headers only) |
| `messages.unread` | `{accountId?, folderId?, count?}` | Get unread messages across all accounts/folders (headers only; default count=25, sorted by date desc) |
| `messages.getRaw` | `{messageId}` | Get full RFC 822 source as base64 |
| `attachments.get` | `{messageId, partName}` | Get attachment content as base64 |
| `attachments.save` | `{messageId, partName}` | Same as attachments.get |

### Write Methods

| Method | Params | Description |
|--------|--------|-------------|
| `messages.markRead` | `{messageIds}` | Mark messages as read |
| `messages.markUnread` | `{messageIds}` | Mark messages as unread |
| `messages.move` | `{messageIds, folderId}` | Move messages to a folder |
| `messages.archive` | `{messageIds}` | Archive messages |
| `messages.trash` | `{messageIds}` | Move messages to trash |
| `messages.delete` | `{messageIds}` | Permanently delete |

### Compose Methods

| Method | Params | Description |
|--------|--------|-------------|
| `compose.new` | `{to, cc?, bcc?, subject?, body?, isPlainText?, identityId?, attachments?}` | Compose and send a new email |
| `compose.reply` | `{messageId, replyType?, body?, isPlainText?, identityId?, attachments?}` | Reply to a message |
| `compose.forward` | `{messageId, forwardType?, to, cc?, bcc?, body?, isPlainText?, identityId?, attachments?}` | Forward a message |

## Common Workflows

### Check Inbox for New Mail

```bash
# 1. List accounts to find account + inbox folder
bb-rpc accounts.list '{}'

# 2. Get latest messages from a folder (e.g., inbox)
bb-rpc messages.latest '{"folderId":"FOLDER_ID","count":10}'

# 3. Get latest messages across ALL folders
bb-rpc messages.latestAll '{"accountId":"account1","count":5}'

# 4. Get latest messages across all accounts
bb-rpc messages.latestAll '{"count":5}'
```

### Check Unread Mail

```bash
# Get all unread messages across all accounts and folders
bb-rpc messages.unread '{}'

# Get unread messages for a specific account
bb-rpc messages.unread '{"accountId":"account1"}'

# Get unread messages in a specific folder (including subfolders)
bb-rpc messages.unread '{"folderId":"FOLDER_ID","count":10}'
```

### Search for Emails

```bash
# Search by sender
bb-rpc messages.search '{"folderId":"FOLDER_ID","queryInfo":{"author":"alice@example.com"},"count":5}'

# Search by subject
bb-rpc messages.search '{"folderId":"FOLDER_ID","queryInfo":{"subject":"invoice"},"count":10}'

# Search by body text
bb-rpc messages.search '{"folderId":"FOLDER_ID","queryInfo":{"body":"meeting agenda"},"count":5}'
```

### Read an Email

```bash
# Get full message with body and attachments list
bb-rpc messages.read '{"messageId":12345}'

# Response includes:
#   .result.header   — sender, subject, date, etc.
#   .result.text     — { plain, html } body content
#   .result.attachments — list of attachment metadata
```

### Download an Attachment

```bash
# After messages.read, use a partName from the attachments list
bb-rpc attachments.get '{"messageId":12345,"partName":"1.2"}'
# Returns base64-encoded content in .result.dataBase64
```

### Reply to an Email

```bash
bb-rpc compose.reply '{"messageId":12345,"body":"<p>Thanks for your message!</p>"}'
```

### Compose a New Email

```bash
bb-rpc compose.new '{"to":"bob@example.com","subject":"Hello","body":"<p>Hi Bob!</p>"}'
```

### Organize Mail

```bash
# Mark as read
bb-rpc messages.markRead '{"messageIds":[12345,12346]}'

# Move to a folder
bb-rpc messages.move '{"messageIds":[12345],"folderId":"TARGET_FOLDER_ID"}'

# Trash a message
bb-rpc messages.trash '{"messageIds":[12345]}'
```

## Safety Notes

- The bridge is exposed via a Unix domain socket only (no TCP listener).
- Socket permissions are owner-only (`0600`), so only the same local OS user can connect.
- Betterbird must be running — the native host is spawned by the addon and communicates with it via stdio; if Betterbird is closed, the host process exits.
