---
name: betterbird-bridge
description: Interact with Betterbird/Thunderbird mailboxes via a local HTTP RPC bridge. Supports listing accounts, folders, messages, reading email bodies/attachments, searching, composing/sending, and write operations (mark read, move, archive, trash, delete). All calls go through a localhost HTTP endpoint with bearer token auth.
---

# Betterbird Bridge — Local Mail RPC

Control Betterbird/Thunderbird mailboxes through a local RPC bridge that talks to a MailExtension addon via Native Messaging.

## Prerequisites

- Betterbird (or Thunderbird) running with the `openclaw-betterbird-bridge` addon loaded
- `bb-rpc` command available in PATH (installed by `scripts/deploy.sh`)

## Usage

```bash
bb-rpc <method> [json-params]
```

Returns JSON: `{"id":...,"ok":true,"result":{...}}` or `{"id":...,"ok":false,"error":{...}}`

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
| `messages.get` | `{messageId}` | Get a single message header |
| `messages.read` | `{messageId, includeAttachments?}` | Get header + body (plain/html) + attachments list |
| `messages.latest` | `{folderId, count?}` | Latest N messages from a folder (default 10) |
| `messages.latestAll` | `{accountId?, count?}` | Latest N messages across all folders (default 10) |
| `messages.search` | `{folderId, queryInfo?, count?}` | Search with queryInfo filter |
| `messages.unread` | `{accountId?, folderId?, count?}` | Unread messages across all accounts/folders (default 25) |
| `messages.getRaw` | `{messageId}` | Full RFC 822 source as base64 |
| `attachments.get` | `{messageId, partName}` | Attachment content as base64 |

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

## Common Workflows

### Check Unread Mail

```bash
bb-rpc messages.unread '{}'
```

### Read an Email

```bash
bb-rpc messages.read '{"messageId":12345}'
# .result.header — sender, subject, date, etc.
# .result.text   — { plain, html } body
# .result.attachments — attachment metadata
```

### Search

```bash
bb-rpc messages.search '{"folderId":"FOLDER_ID","queryInfo":{"author":"alice@example.com"},"count":5}'
bb-rpc messages.search '{"folderId":"FOLDER_ID","queryInfo":{"subject":"invoice"},"count":10}'
```

### Organize

```bash
bb-rpc messages.markRead '{"messageIds":[12345,12346]}'
bb-rpc messages.trash '{"messageIds":[12345]}'
bb-rpc messages.move '{"messageIds":[12345],"folderId":"TARGET_FOLDER_ID"}'
```

### Compose

```bash
bb-rpc compose.new '{"to":"bob@example.com","subject":"Hello","body":"<p>Hi Bob!</p>"}'
bb-rpc compose.reply '{"messageId":12345,"body":"<p>Thanks!</p>"}'
```
