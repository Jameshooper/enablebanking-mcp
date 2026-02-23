# enablebanking-mcp

An MCP server that connects to the [Enable Banking API](https://enablebanking.com) to fetch Finnish bank account balances and transactions. Packaged as an OpenClaw skill for personal finance queries.

Supported accounts: **OP** (checking/savings) and **Aktia Finnair Visa** (credit card).

---

## Prerequisites

- Node.js 18+
- An [Enable Banking](https://enablebanking.com) application with:
  - An **Application ID** (UUID)
  - A downloaded **private RSA key** (`.pem` file, PKCS#8 format)
  - The key's public certificate uploaded in the Enable Banking console
  - A registered redirect URL (this app uses `https://localhost:8080/callback`)

---

## Setup

### 1. Clone and install

```bash
git clone https://github.com/jessemccrosky/enablebanking-mcp
cd enablebanking-mcp
npm install
```

### 2. Add your credentials

Copy your private key file into the repo directory, then create `.env`:

```bash
cp .env.example .env
```

Edit `.env`:

```env
ENABLE_BANKING_APP_ID=your-application-id-here
ENABLE_BANKING_KEY_PATH=./your-private-key.pem
SESSIONS_FILE=./sessions.json
```

### 3. Verify your credentials

```bash
node test-auth.js
```

All three checks should pass: key loads, JWT is generated, and the Enable Banking API accepts it.

### 4. Configure OpenClaw

Add the MCP server to your OpenClaw (or Claude Code) config. The exact file is `~/.claude.json` for Claude Code, or your `openclaw.json`:

```json
{
  "mcpServers": {
    "enablebanking-mcp": {
      "command": "node",
      "args": ["/path/to/enablebanking-mcp/server.js"]
    }
  }
}
```

> **Note:** The server reads `.env` from its own directory at startup, so credentials do not need to be set in the MCP config itself.

Then add the skill:

```json
{
  "skills": [
    { "path": "/path/to/enablebanking-mcp/banking-skill" }
  ]
}
```

---

## Authorising Your Banks

Each bank requires a one-time consent flow. Sessions are saved in `sessions.json` and persist until the bank revokes access (typically 90 days).

### Using the setup script (recommended, works headless)

Run `setup-auth.js` from the repo directory — it handles the full flow interactively in the terminal:

```bash
node setup-auth.js          # authorise OP (default)
node setup-auth.js Aktia    # authorise Aktia
```

The script will:
1. Print an auth URL — open it on any device (phone, laptop) and log in at the bank.
2. Your browser is redirected to `https://localhost:8080/callback?code=...` (the page will error — that's fine).
3. Copy the full URL from the address bar and paste it into the terminal.
4. The script exchanges the code, saves the session, and prints the linked accounts.

### Using the MCP tools (via OpenClaw)

If you prefer to let the agent handle it, ask:

> "Authorise my Aktia Finnair card"

OpenClaw will call `start_bank_auth`, give you the URL to visit, then call `complete_bank_auth` once you paste the redirect URL back into chat.

---

## MCP Tools

| Tool | Description |
|------|-------------|
| `list_sessions` | Show all saved sessions and their account UIDs/IBANs |
| `get_balances` | Current balances for all linked accounts |
| `get_transactions` | Transaction history for one account (`account_id`, `date_from`, `date_to` in YYYY-MM-DD) |
| `start_bank_auth` | Begin consent flow for a bank — returns a URL to visit |
| `complete_bank_auth` | Complete consent flow — paste the redirect URL after authorising |

---

## Example Queries

- "What's my OP balance?"
- "Show my Aktia card transactions for February 2026"
- "How much did I spend on restaurants last month?"
- "Did any transactions over €200 go through this week?"

---

## Security Notes

- `.env`, `*.pem`, `*.key`, and `sessions.json` are gitignored and never committed.
- The private key is read from disk only at startup; the JWT it produces expires after 1 hour.
- Session tokens are stored only in the local `sessions.json` file.
