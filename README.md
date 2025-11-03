# @ideadesignmedia/gmail-mcp

Private MCP server and CLI that links multiple Gmail inboxes and exposes tools over stdio. Tokens are stored in SQLite. You can lock the database with a password so the server and all commands require a pass before use.

## Install

```bash
npm i -g @ideadesignmedia/gmail-mcp
# or as npx on first run
npx @ideadesignmedia/gmail-mcp --help
```

## Quick start

1. Choose a SQLite path or accept the default.
2. Link an account with your Google OAuth client.
3. Lock the database with a password if you want strict access control.
4. Start the server.

```bash
# Add an account using loopback auth
gmail-mcp add --client-id $GOOGLE_CLIENT_ID --client-secret $GOOGLE_CLIENT_SECRET

# Or device flow if headless
gmail-mcp add --device --client-id $GOOGLE_CLIENT_ID --client-secret $GOOGLE_CLIENT_SECRET

# Lock the DB so every command and the server require a password
gmail-mcp passwd --pass 'your-strong-pass'

# Start MCP server over stdio
export GMAIL_MCP_DB_PASS='your-strong-pass'
gmail-mcp start
```

Defaults:
- DB path: `~/.idm/gmail-mcp/db.sqlite`
- Password can be passed with `--pass` or `GMAIL_MCP_DB_PASS`.
- When the database is locked you must provide a password for all commands.
- When unlocked you can operate without a password. Lock any time with `gmail-mcp passwd`.

## CLI

```
gmail-mcp [start] [--db <path>] [--pass <pass>] [--read-only]
gmail-mcp add [--db <path>] [--pass <pass>] [--client-id ...] [--client-secret ...] [--device]
gmail-mcp list [--db <path>] [--pass <pass>]
gmail-mcp remove <email|id> [--db <path>] [--pass <pass>]
gmail-mcp passwd [--db <path>] [--pass <new>] [--rotate] [--old-pass <old>] [--hint <text>]
```

## MCP tools

- `list_accounts()`
- `search_mail({ query, account?, limit? })`
- `get_message({ account, messageId, body? })`
- `get_thread({ account, threadId, body? })`
- `download_attachment({ account, messageId, attachmentId })`
- `label_message({ account, messageId, add?, remove? })`
- `send_message({ account, to, subject, text?, html?, replyToMessageId? })`

`account` accepts email or internal id.

## Google OAuth setup

Create OAuth client credentials in Google Cloud Console. For loopback add a redirect like `http://127.0.0.1:43112/oauth2/callback`. For device flow no redirect is needed.

Scopes used by default:
- gmail.readonly
- gmail.modify
- gmail.send

You can run the server in `--read-only` mode which disables send and modify tools at registration time.

## Environment

- `GMAIL_MCP_DB_PASS` optional and required if DB is locked
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` for `add` if not passed as flags

## Notes

- This server is private by design. Anyone who can invoke it has full access to the linked accounts.
- If the password is lost there is no recovery. You must re-add accounts.
- No message bodies or tokens are logged.
- Outgoing messages are base64url-encoded before calling Gmail's `users.messages.send` API, matching the format Gmail expects.
