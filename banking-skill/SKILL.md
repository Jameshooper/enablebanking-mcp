---
name: banking
description: >
  Query Jesse's Finnish bank accounts via the Enable Banking API.
  Covers OP (checking/savings) and Aktia (Finnair Visa credit card).
  Fetch real-time balances and transaction history, summarise spending,
  detect recurring charges, and answer personal finance questions.
version: "1.0.0"
author: jessemccrosky
mcp_server: enablebanking-mcp
tools:
  - list_sessions
  - get_balances
  - get_transactions
  - start_bank_auth
  - complete_bank_auth
---

# Banking Skill — Agent Instructions

You have access to the **enablebanking-mcp** MCP server which connects to Jesse's
Finnish bank accounts via the Enable Banking open-banking API.

## ALWAYS START HERE

**Call `list_sessions` at the beginning of every banking conversation** to confirm
which accounts are currently linked. Do not assume any account is available without
checking first.

Expected output when everything is set up:

- One or more **OP** accounts (checking, possibly savings)
- One **Aktia** account (Finnair Visa credit card)

**OP is already authorised — do not attempt to re-authorise it.** If OP accounts
appear in `list_sessions`, proceed directly to answering the user's question.

If an account is missing, see the "Adding or Re-authorising a Bank" section below.

---

## Available MCP Tools

| Tool | Purpose |
|------|---------|
| `list_sessions` | Show all saved sessions with account UIDs and IBANs |
| `get_balances` | Fetch current balances for all linked accounts |
| `get_transactions` | Fetch paginated transaction history for one account |
| `start_bank_auth` | Begin the consent flow for a bank (returns a URL to visit) |
| `complete_bank_auth` | Complete the consent flow (paste the redirect URL after bank login) |

---

## The User's Accounts

| Institution | Type | Country | ASPSP name |
|-------------|------|---------|------------|
| **OP** | Checking / savings | FI | `OP` |
| **Aktia** | Finnair Visa credit card | FI | `Aktia` |

When the user says "bank account", "current account", or "OP" → use the OP session.
When the user says "credit card", "Aktia", or "Finnair card" → use the Aktia session.

---

## Checking Balances

1. Call `get_balances` (no arguments fetches all accounts).
2. Present each account with its IBAN, balance type, and amount.
3. For the Aktia credit card: a negative closing balance means money is owed.

Preferred format:

```
OP Checking  FI12 3456 7890 1234 56
  Available : 1 234,56 EUR
  Closing   : 1 234,56 EUR

Aktia Finnair Visa  **** 1234
  Closing : -87,40 EUR  (amount owed on card)
```

---

## Fetching Transactions

1. Identify which account and what date range the user wants.
2. If no date range is given, default to the **current calendar month**
   (`date_from = YYYY-MM-01`, `date_to = today`).
3. Confirm the date range with the user before fetching.
4. Call `get_transactions` with the account's UID (from `list_sessions`) and
   YYYY-MM-DD dates.
5. Present results newest-first.

---

## Summarising Spending

1. Fetch transactions for the requested period.
2. Group by merchant / payee where possible.
3. Common categories: groceries, transport, restaurants, subscriptions, transfers.
4. Report totals per category and overall debit total.
5. Flag any unusually large or unexpected charges.

---

## Aktia Finnair Card — Notes

- This is a credit card; purchases appear as debits.
- Statement period typically runs 1st to end of month.
- "What do I owe?" → `get_balances` for the Aktia account, report the CLBD balance.
- You cannot see Finnair Plus miles or loyalty point accruals — only EUR amounts.

---

## Date Shortcuts

| User says | Interpret as |
|-----------|-------------|
| "this month" | `date_from`: first of current month — `date_to`: today |
| "last month" | full previous calendar month |
| "last 30 days" | today − 30 days → today |
| "this year" | `date_from`: Jan 1 of current year |
| "last week" | Monday – Sunday of last week |

---

## Adding or Re-authorising a Bank

Only do this if `list_sessions` shows the bank is **missing or expired**.

### Recommended: setup script (works on headless machines)

Ask the user to run this in the terminal from the repo directory:

```bash
node setup-auth.js          # for OP
node setup-auth.js Aktia    # for Aktia
```

The script prints an auth URL, waits for the user to paste back the redirect URL,
and saves the session automatically. After it completes, call `list_sessions` to
confirm the accounts are now visible.

### Alternative: MCP tools

If the user prefers to stay in chat:

1. Call `start_bank_auth` with the bank's ASPSP name and `aspsp_country: "FI"`.
2. Share the returned URL — the user opens it on any device and logs in.
3. After they paste back the redirect URL (contains `?code=...`), call
   `complete_bank_auth`.
4. Confirm with `list_sessions`.

The registered redirect URL is `https://localhost:8080/callback`. The browser will
show a connection error after the bank redirects — that is expected; the user just
needs to copy the full URL from the address bar.

---

## Privacy & Security

- Never display raw JWT tokens or the private key file path.
- Truncate session IDs to the first 8 characters if you need to show them.
- Account UIDs are non-sensitive internal identifiers; show them only when helpful.
