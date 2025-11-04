# @ideadesignmedia/gmail-mcp

Private MCP server and CLI that links multiple Gmail inboxes and exposes tools over stdio. Tokens are stored in SQLite and can be encrypted-at-rest with a password. When locked, every command and the MCP server require a password to run.

- Transport: stdio (suitable for MCP clients that launch a local command)
- Default DB: `~/.idm/gmail-mcp/db.sqlite`
- Node requirement: >= 18.17

## Run with npx (recommended)

You do not need to install anything globally. Use `npx` to run the CLI and server. On first run, `npx` will download the package; later runs use the cached copy.

Show help:

```bash
npx @ideadesignmedia/gmail-mcp --help
```

Add an account (loopback OAuth):

```bash
# Define or export your Google OAuth client credentials
export GOOGLE_CLIENT_ID=your_client_id
export GOOGLE_CLIENT_SECRET=your_client_secret

# Start the OAuth flow and link the Gmail account
npx -y @ideadesignmedia/gmail-mcp add \
  --client-id "$GOOGLE_CLIENT_ID" \
  --client-secret "$GOOGLE_CLIENT_SECRET"
```

Add an account (device code flow; headless-safe):

```bash
export GOOGLE_CLIENT_ID=your_client_id
export GOOGLE_CLIENT_SECRET=your_client_secret

npx -y @ideadesignmedia/gmail-mcp add \
  --device \
  --client-id "$GOOGLE_CLIENT_ID" \
  --client-secret "$GOOGLE_CLIENT_SECRET"
```

Lock the database with a password:

```bash
npx -y @ideadesignmedia/gmail-mcp passwd --pass 'your-strong-pass'
```

Start the MCP server over stdio (for your MCP client to launch):

```bash
export GMAIL_MCP_DB_PASS='your-strong-pass'   # only required if the DB is locked
npx -y @ideadesignmedia/gmail-mcp start
```

Notes for `npx` usage:

- `-y` auto-confirms the download prompt on first run.
- You can pass `--db /custom/path.sqlite` to store the database elsewhere.
- Use `--read-only` with `start` to disable write actions (send/label modify).

## Quick start (end‑to‑end)

1) Create a Google OAuth client (see "Google OAuth setup").

2) Link one or more Gmail accounts:

```bash
export GOOGLE_CLIENT_ID=...
export GOOGLE_CLIENT_SECRET=...
npx -y @ideadesignmedia/gmail-mcp add --client-id "$GOOGLE_CLIENT_ID" --client-secret "$GOOGLE_CLIENT_SECRET"
```

3) (Optional but recommended) Lock the DB with a password so tokens are encrypted at rest:

```bash
npx -y @ideadesignmedia/gmail-mcp passwd --pass 'your-strong-pass'
```

4) Point your MCP client to run the server command. Most clients let you configure a command, arguments, and environment variables. An example configuration looks like:

```jsonc
{
  "command": "npx",
  "args": ["-y", "@ideadesignmedia/gmail-mcp", "start", "--read-only"],
  "env": { "GMAIL_MCP_DB_PASS": "your-strong-pass" }
}
```

Exact configuration format depends on your MCP client. The server speaks stdio.

5) Use the tools provided by the server from your MCP client (see "MCP tools").

## CLI reference

Global options (apply to all commands unless stated otherwise):

- `--db <path>`: SQLite DB path (default `~/.idm/gmail-mcp/db.sqlite`)
- `--pass <pass>`: Database password or new password (also available via `GMAIL_MCP_DB_PASS`)
- `--read-only`: Start server with write operations disabled (only used by `start`)

Commands:

```bash
# Start the MCP server over stdio
npx -y @ideadesignmedia/gmail-mcp start [--db <path>] [--pass <pass>] [--read-only]

# Link a Gmail account (loopback or device flow)
npx -y @ideadesignmedia/gmail-mcp add \
  [--db <path>] [--pass <pass>] \
  [--client-id <id>] [--client-secret <secret>] [--device] [--listen-port <port>]

# List linked accounts
npx -y @ideadesignmedia/gmail-mcp list [--db <path>] [--pass <pass>]

# Remove an account (by email or id)
npx -y @ideadesignmedia/gmail-mcp remove <email|id> [--db <path>] [--pass <pass>]

# Lock the DB, set password, or rotate existing password
npx -y @ideadesignmedia/gmail-mcp passwd [--db <path>] [--pass <new>] [--rotate] [--old-pass <old>] [--hint <text>]
```

Behavioral details:

- When the DB is locked, all commands require a password (`--pass` or `GMAIL_MCP_DB_PASS`).
- When unlocked, you can operate without a password and lock later with `passwd`.
- `passwd --rotate --old-pass <old> --pass <new>` rotates the encryption KEK without re‑adding accounts.
- `start --read-only` disables `send_message` and `label_message` tools and prevents modification APIs.

## Google OAuth setup

Create a Web application OAuth client in Google Cloud Console and enable the Gmail API.

Loopback (default) flow requirements:

- Authorized redirect URI: `http://127.0.0.1:43112/oauth2/callback`
- Scopes requested by this tool:
  - `https://www.googleapis.com/auth/gmail.readonly`
  - `https://www.googleapis.com/auth/gmail.modify`
  - `https://www.googleapis.com/auth/gmail.send`
  - `openid`, `email`, `profile` (used to fetch the account email/id on first link)

Device code flow (headless) requirements:

- No redirect URI needed. You will be shown a verification URL and user code to enter in a browser.

Tips:

- If you get no `refresh_token`, ensure `access_type=offline` and `prompt=consent` are set and you have not previously granted this client for the user. You can revoke previous grants at https://myaccount.google.com/permissions.

## Environment variables

- `GMAIL_MCP_DB_PASS`: Password for a locked DB (also accepted via `--pass`).
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`: Used by `add` if flags are not provided.

## MCP tools

The server exposes these tools. Names and parameters are stable and validated with zod. Unless noted, responses mirror the Gmail REST API types.

1) `list_accounts`

- Input: `{}`
- Output: `{ accounts: Array<{ id: string, email: string, displayName: string | null }> }`

2) `search_mail`

- Input: `{ query: string, account?: string, limit?: number }`
- Behavior: If `account` omitted, searches all accounts up to a capped total (`limit` per account up to 200).
- Output: `{ messages: Array<{ accountId: string, messageId: string | null, threadId: string | null }> }`

3) `get_message`

- Input: `{ account: string, messageId: string, body?: 'metadata' | 'snippet' | 'full' }`
- Output: Gmail `Message` resource.

4) `get_thread`

- Input: `{ account: string, threadId: string, body?: 'metadata' | 'full' }`
- Output: Gmail `Thread` resource.

5) `download_attachment`

- Input: `{ account: string, messageId: string, attachmentId: string }`
- Output: Gmail `MessagePartBody` with base64url `data`.

6) `label_message`

- Input: `{ account: string, messageId: string, add?: string[], remove?: string[] }`
- Writes: Adds/removes label IDs on a message. Disabled in `--read-only` mode.
- Output: Gmail `Message` resource (post-modify).

7) `send_message`

- Input: `{ account: string, to: string, subject: string, text?: string, html?: string, replyToMessageId?: string }`
- Behavior: Builds a minimal RFC822 message (text or html) and sends via `users.messages.send`. Attachments and custom headers are not yet supported. `replyToMessageId` is currently accepted but not used to set threading headers.
- Writes: Sends email on the selected account. Disabled in `--read-only` mode.
- Output: Gmail `Message` resource for the sent message.

Account selection:

- For any tool, `account` accepts either the account’s email or its internal `id` (see `list_accounts`).

## Security model

- Stored tokens are encrypted-at-rest when the DB is locked with `passwd`.
- Losing the password means losing access to encrypted refresh tokens; there is no recovery.
- Anyone who can launch the server or CLI with the password can access all linked inboxes.
- No message bodies or tokens are logged.

## Troubleshooting

- Node not recent enough: ensure Node >= 18.17 (`node -v`).
- No refresh token after OAuth: revoke prior grants and try again, ensuring `prompt=consent` and first-time approval for this client.
- Locked DB errors: provide `--pass` or set `GMAIL_MCP_DB_PASS` for all commands, including `list` and `remove`.
- Device flow polling errors: if you see `authorization_pending` or `slow_down`, just wait; the CLI automatically retries.

## Optional: global install

You can install globally if you prefer shorter commands:

```bash
npm i -g @ideadesignmedia/gmail-mcp
gmail-mcp --help
```

All examples above work the same without `npx` once installed globally.
