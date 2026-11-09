import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { importPKCS8, SignJWT } from "jose";
import { readFileSync, writeFileSync, existsSync, chmodSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Load .env relative to this file's location
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const API_BASE = "https://api.enablebanking.com";
const APP_ID = process.env.ENABLE_BANKING_APP_ID;
const SESSIONS_FILE = resolve(__dirname, process.env.SESSIONS_FILE || "./sessions.json");

if (!APP_ID) throw new Error("ENABLE_BANKING_APP_ID not set in .env");

// ---------------------------------------------------------------------------
// Key loading — supports inline env var or file path
// ---------------------------------------------------------------------------
function loadKeyPem() {
  if (process.env.ENABLE_BANKING_PRIVATE_KEY) {
    // Inline key in .env — dotenv preserves newlines inside double-quoted values
    return process.env.ENABLE_BANKING_PRIVATE_KEY;
  }
  const keyPath = resolve(__dirname, process.env.ENABLE_BANKING_KEY_PATH || "./Enable Banking Certificate.pem");
  if (!existsSync(keyPath)) throw new Error(`Private key not found at: ${keyPath}`);
  return readFileSync(keyPath, "utf8");
}

// ---------------------------------------------------------------------------
// JWT generation — RS256 signed, valid 1 hour
// ---------------------------------------------------------------------------
let cachedPrivateKey = null;

async function getPrivateKey() {
  if (!cachedPrivateKey) {
    cachedPrivateKey = await importPKCS8(loadKeyPem(), "RS256");
  }
  return cachedPrivateKey;
}

async function generateJWT() {
  const privateKey = await getPrivateKey();
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: APP_ID })
    .setIssuer("enablebanking.com")
    .setAudience("api.enablebanking.com")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

// ---------------------------------------------------------------------------
// API helper
// ---------------------------------------------------------------------------
async function apiRequest(method, path, body = null) {
  const jwt = await generateJWT();
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${jwt}`,
      "Content-Type": "application/json",
    },
  };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);
  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Enable Banking API ${res.status} on ${method} ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : {};
}

// ---------------------------------------------------------------------------
// Session persistence (plain JSON file, good enough for personal use)
// ---------------------------------------------------------------------------
function loadSessions() {
  if (existsSync(SESSIONS_FILE)) {
    return JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  }
  return [];
}

function saveSessions(sessions) {
  // 0o600: session tokens should be readable only by the owner
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), { mode: 0o600 });
  chmodSync(SESSIONS_FILE, 0o600);
}

function sessionSummary(session) {
  const accounts = (session.accounts || []).map((a) => {
    const iban = a.details?.iban || a.account_id?.iban || "";
    const currency = a.details?.currency || "?";
    return `  • uid=${a.uid}${iban ? "  iban=" + iban : ""}  (${currency})`;
  });
  return (
    `Session: ${session.session_id}  [created ${session.created_at}]\n` +
    (accounts.length ? accounts.join("\n") : "  (no accounts)")
  );
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------
const server = new Server(
  { name: "enablebanking-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

// ---- Tool definitions -------------------------------------------------------
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "start_bank_auth",
      description:
        "Start the bank consent/authorization flow for a specific bank. Returns a URL that the user must open in their browser to grant access. Supported Finnish banks: OP, Aktia, Nordea, S-Pankki, Handelsbanken, etc.",
      inputSchema: {
        type: "object",
        properties: {
          aspsp_name: {
            type: "string",
            description:
              "Bank ASPSP name as recognized by Enable Banking, e.g. 'OP', 'Aktia', 'Nordea', 'S-Pankki'",
          },
          aspsp_country: {
            type: "string",
            description: "ISO 3166-1 alpha-2 country code, e.g. 'FI'",
            default: "FI",
          },
          redirect_url: {
            type: "string",
            description:
              "Redirect URL registered in Enable Banking console (default: https://localhost:8080/callback)",
            default: "https://localhost:8080/callback",
          },
          valid_days: {
            type: "number",
            description: "Number of days of data access to request (default: 90)",
            default: 90,
          },
        },
        required: ["aspsp_name"],
      },
    },
    {
      name: "complete_bank_auth",
      description:
        "Complete the bank authorization flow. After visiting the URL from start_bank_auth and authorizing, you are redirected back. Paste the full redirect URL here to create a session.",
      inputSchema: {
        type: "object",
        properties: {
          redirect_url: {
            type: "string",
            description:
              "The full URL your browser was redirected to after bank authorization (contains ?code=... parameter)",
          },
        },
        required: ["redirect_url"],
      },
    },
    {
      name: "list_sessions",
      description:
        "List all saved bank sessions and their associated accounts (with UIDs and IBANs).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_balances",
      description:
        "Fetch current balances for all linked accounts across all sessions. Optionally filter to a single session.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "Optional: restrict to a specific session ID",
          },
        },
      },
    },
    {
      name: "get_transactions",
      description:
        "Fetch transactions for a specific account between two dates. Automatically follows pagination.",
      inputSchema: {
        type: "object",
        properties: {
          account_id: {
            type: "string",
            description:
              "The account UID (from list_sessions or get_balances output)",
          },
          date_from: {
            type: "string",
            description: "Start date in YYYY-MM-DD format (inclusive)",
          },
          date_to: {
            type: "string",
            description:
              "End date in YYYY-MM-DD format (inclusive, optional — defaults to today)",
          },
        },
        required: ["account_id", "date_from"],
      },
    },
  ],
}));

// ---- Tool implementations ---------------------------------------------------
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // -----------------------------------------------------------------------
      case "start_bank_auth": {
        const {
          aspsp_name,
          aspsp_country = "FI",
          redirect_url = "https://localhost:8080/callback",
          valid_days = 90,
        } = args;

        const validUntil = new Date(
          Date.now() + valid_days * 24 * 60 * 60 * 1000
        ).toISOString();
        const state = crypto.randomUUID();

        const result = await apiRequest("POST", "/auth", {
          access: { valid_until: validUntil },
          aspsp: { name: aspsp_name, country: aspsp_country },
          state,
          redirect_url,
          psu_type: "personal",
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `Authorization URL ready for ${aspsp_name} (${aspsp_country}).`,
                ``,
                `1. Open this URL in your browser:`,
                `   ${result.url}`,
                ``,
                `2. Log in and authorize access at ${aspsp_name}.`,
                ``,
                `3. You will be redirected to: ${redirect_url}?code=...`,
                `   Copy that FULL URL and call complete_bank_auth with it.`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "complete_bank_auth": {
        const { redirect_url } = args;
        let code;
        try {
          code = new URL(redirect_url).searchParams.get("code");
        } catch {
          throw new Error("redirect_url is not a valid URL");
        }
        if (!code) throw new Error("No 'code' parameter found in redirect_url");

        const result = await apiRequest("POST", "/sessions", { code });

        const sessions = loadSessions();
        const session = {
          session_id: result.session_id,
          accounts: result.accounts || [],
          created_at: new Date().toISOString(),
        };
        sessions.push(session);
        saveSessions(sessions);

        return {
          content: [
            {
              type: "text",
              text: [
                `Session created and saved!`,
                ``,
                sessionSummary(session),
                ``,
                `Use get_balances or get_transactions with the account UIDs above.`,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "list_sessions": {
        const sessions = loadSessions();
        if (sessions.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No sessions saved yet. Use start_bank_auth → complete_bank_auth to add a bank.",
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text: sessions.map(sessionSummary).join("\n\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      case "get_balances": {
        const sessions = loadSessions();
        if (sessions.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No sessions found. Run start_bank_auth first.",
              },
            ],
          };
        }

        const targetSessions = args?.session_id
          ? sessions.filter((s) => s.session_id === args.session_id)
          : sessions;

        const lines = [];
        for (const session of targetSessions) {
          for (const account of session.accounts || []) {
            const iban =
              account.details?.iban ||
              account.account_id?.iban ||
              account.uid;
            const currency = account.details?.currency || "";
            try {
              const data = await apiRequest(
                "GET",
                `/accounts/${encodeURIComponent(account.uid)}/balances`
              );
              const balances = (data.balances || [])
                .map((b) => {
                  const amt = b.balance_amount || b.amount || {};
                  return `  ${b.balance_type || b.type}: ${amt.amount} ${amt.currency ?? currency}`;
                })
                .join("\n");
              lines.push(`${iban} [uid: ${account.uid}]\n${balances || "  (no balance data)"}`);
            } catch (e) {
              lines.push(`${iban} [uid: ${account.uid}]\n  Error: ${e.message}`);
            }
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n\n") || "No accounts found." }],
        };
      }

      // -----------------------------------------------------------------------
      case "get_transactions": {
        const { account_id, date_from, date_to } = args;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(date_from)) {
          throw new Error("date_from must be in YYYY-MM-DD format");
        }
        if (date_to && !/^\d{4}-\d{2}-\d{2}$/.test(date_to)) {
          throw new Error("date_to must be in YYYY-MM-DD format");
        }

        const allTxns = [];
        let continuationKey = null;

        do {
          const params = new URLSearchParams({ date_from });
          if (date_to) params.set("date_to", date_to);
          if (continuationKey) params.set("continuation_key", continuationKey);

          const data = await apiRequest(
            "GET",
            `/accounts/${encodeURIComponent(account_id)}/transactions?${params}`
          );

          const txns = data.transactions || data.booked || [];
          allTxns.push(...txns);
          continuationKey = data.continuation_key ?? null;
        } while (continuationKey);

        if (allTxns.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No transactions found for account ${account_id} from ${date_from}${date_to ? " to " + date_to : ""}.`,
              },
            ],
          };
        }

        const lines = allTxns.map((t) => {
          const date =
            t.transaction_date ||
            t.booking_date ||
            t.value_date ||
            "?";
          const indicator = t.credit_debit_indicator || t.creditDebitIndicator || "";
          const amountObj = t.transaction_amount || t.amount || {};
          const sign = indicator === "DBIT" ? "-" : indicator === "CRDT" ? "+" : "";
          const amount = amountObj.amount ?? amountObj;
          const currency = amountObj.currency || "";
          const desc =
            t.remittance_information?.unstructured ||
            (Array.isArray(t.remittance_information?.unstructured_array)
              ? t.remittance_information.unstructured_array.join(" ")
              : "") ||
            t.additional_information ||
            t.creditor?.name ||
            t.debtor?.name ||
            "";
          return `${date}  ${sign}${amount} ${currency}  ${desc}`;
        });

        return {
          content: [
            {
              type: "text",
              text: [
                `Transactions for account ${account_id}`,
                `Period: ${date_from} → ${date_to || "today"}`,
                `Count: ${allTxns.length}`,
                ``,
                ...lines,
              ].join("\n"),
            },
          ],
        };
      }

      // -----------------------------------------------------------------------
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [{ type: "text", text: `Error: ${error.message}` }],
      isError: true,
    };
  }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
