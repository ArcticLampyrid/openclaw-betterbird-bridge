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

## Status

Scaffold in progress. Next milestone: get a minimal `ping + accounts.list + messages.query + messages.read` roundtrip working.
