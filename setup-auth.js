#!/usr/bin/env node
/**
 * setup-auth.js
 *
 * Interactive headless-friendly script to authorise a bank and save the
 * session to sessions.json.  Run this once per bank from the terminal.
 *
 * Usage:
 *   node setup-auth.js              # authorises OP (default)
 *   node setup-auth.js Aktia        # authorises Aktia
 *   node setup-auth.js "Nordea" FI  # any bank + country code
 *
 * Workflow:
 *   1. Generates an auth URL and prints it.
 *   2. You open the URL on any device (phone, laptop) and log in.
 *   3. Your browser is redirected to https://localhost:8080/callback?code=...
 *      (the page will error — that's fine).  Copy the full URL from the
 *      address bar and paste it here.
 *   4. The script exchanges the code for a session and saves it.
 */

import { importPKCS8, SignJWT } from "jose";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const APP_ID        = process.env.ENABLE_BANKING_APP_ID;
const SESSIONS_FILE = resolve(__dirname, process.env.SESSIONS_FILE || "./sessions.json");
const API_BASE      = "https://api.enablebanking.com";
const REDIRECT_URL  = "https://localhost:8080/callback";

function loadKeyPem() {
  if (process.env.ENABLE_BANKING_PRIVATE_KEY) return process.env.ENABLE_BANKING_PRIVATE_KEY;
  const keyPath = resolve(__dirname, process.env.ENABLE_BANKING_KEY_PATH || "./Enable Banking Certificate.pem");
  return readFileSync(keyPath, "utf8");
}

const aspspName    = process.argv[2] || "OP";
const aspspCountry = process.argv[3] || "FI";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function prompt(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function generateJWT() {
  const key = await importPKCS8(loadKeyPem(), "RS256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: APP_ID })
    .setIssuer("enablebanking.com")
    .setAudience("api.enablebanking.com")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(key);
}

async function api(method, path, body = null) {
  const jwt = await generateJWT();
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt}`, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`API ${res.status} on ${method} ${path}: ${text}`);
  return JSON.parse(text);
}

function loadSessions() {
  return existsSync(SESSIONS_FILE) ? JSON.parse(readFileSync(SESSIONS_FILE, "utf8")) : [];
}

function saveSessions(sessions) {
  writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
console.log("\n" + "─".repeat(60));
console.log(`Enable Banking — authorise ${aspspName} (${aspspCountry})`);
console.log("─".repeat(60) + "\n");

// Check if already authorised
const existing = loadSessions();
const alreadyLinked = existing.some((s) =>
  (s.accounts || []).some((a) => {
    const bic = a.account_servicer?.bic_fi || "";
    // rough check — works for OP (OKOYFIHH) and Aktia (HELSFIHH)
    return s.aspsp_name === aspspName || bic.startsWith(aspspName.slice(0, 2).toUpperCase());
  })
);
if (alreadyLinked) {
  console.log(`ℹ  A session for ${aspspName} already exists in sessions.json.`);
  const ans = await prompt("   Authorise again anyway? [y/N] ");
  if (!ans.toLowerCase().startsWith("y")) {
    console.log("Aborted.\n");
    process.exit(0);
  }
}

// Step 1 — generate auth URL
console.log("Step 1 — Generating authorisation URL …\n");
let authUrl;
try {
  const validUntil = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const result = await api("POST", "/auth", {
    access: { valid_until: validUntil },
    aspsp: { name: aspspName, country: aspspCountry },
    state: crypto.randomUUID(),
    redirect_url: REDIRECT_URL,
    psu_type: "personal",
  });
  authUrl = result.url;
} catch (err) {
  console.error(`✗  Failed to get auth URL: ${err.message}`);
  process.exit(1);
}

console.log("Open this URL in any browser (phone, laptop, etc.):\n");
console.log("  " + authUrl);
console.log(`
After logging in to ${aspspName}, your browser will be redirected to:
  ${REDIRECT_URL}?code=...

The page will show a connection error — that is expected.
Copy the FULL URL from your browser's address bar and paste it below.
`);

// Step 2 — wait for callback URL
const callbackUrl = await prompt("Paste redirect URL here: ");

let code;
try {
  code = new URL(callbackUrl).searchParams.get("code");
} catch {
  console.error("✗  That doesn't look like a valid URL.");
  process.exit(1);
}
if (!code) {
  console.error("✗  No 'code' parameter found in that URL.");
  process.exit(1);
}

// Step 3 — exchange code for session
console.log("\nStep 2 — Exchanging code for session …");
let sessionData;
try {
  sessionData = await api("POST", "/sessions", { code });
} catch (err) {
  console.error(`✗  Session creation failed: ${err.message}`);
  process.exit(1);
}

// Step 4 — save
const session = {
  aspsp_name: aspspName,
  aspsp_country: aspspCountry,
  session_id: sessionData.session_id,
  accounts: sessionData.accounts || [],
  created_at: new Date().toISOString(),
};

const sessions = loadSessions();
sessions.push(session);
saveSessions(sessions);

// Step 5 — report
console.log(`\n✓  Session saved to ${SESSIONS_FILE}\n`);
console.log(`Session ID : ${session.session_id.slice(0, 8)}…`);
console.log(`Accounts   : ${session.accounts.length}\n`);

for (const acc of session.accounts) {
  const iban     = acc.account_id?.iban || "(no IBAN)";
  const product  = acc.product || acc.cash_account_type || "account";
  const currency = acc.currency || "EUR";
  console.log(`  • ${product}  ${iban}  (${currency})  uid=${acc.uid}`);
}

console.log("\n" + "─".repeat(60));
console.log("All done. You can now use the banking skill in OpenClaw.");
console.log("─".repeat(60) + "\n");
