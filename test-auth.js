/**
 * test-auth.js
 *
 * Validates that:
 *  1. The private key is readable and in the right format
 *  2. A valid RS256 JWT can be generated
 *  3. The JWT is accepted by the Enable Banking API (makes a lightweight GET /aspsp)
 *
 * Usage:  node test-auth.js
 */

import { importPKCS8, SignJWT, decodeJwt } from "jose";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, ".env") });

const APP_ID = process.env.ENABLE_BANKING_APP_ID;
const API_BASE = "https://api.enablebanking.com";

// ---- Step 1: load private key -----------------------------------------------
console.log("─".repeat(60));
console.log("Step 1 — Load private key");

let pem;
if (process.env.ENABLE_BANKING_PRIVATE_KEY) {
  pem = process.env.ENABLE_BANKING_PRIVATE_KEY;
  console.log("  Source : ENABLE_BANKING_PRIVATE_KEY (inline in .env)");
} else {
  const keyPath = resolve(
    __dirname,
    process.env.ENABLE_BANKING_KEY_PATH || "./Enable Banking Certificate.pem"
  );
  console.log(`  Source : ${keyPath}`);
  if (!existsSync(keyPath)) {
    console.error(`  ✗  File not found: ${keyPath}`);
    process.exit(1);
  }
  pem = readFileSync(keyPath, "utf8");
}

const keyType = pem.includes("BEGIN PRIVATE KEY")
  ? "PKCS#8 (unencrypted)"
  : pem.includes("BEGIN RSA PRIVATE KEY")
  ? "PKCS#1 (traditional)"
  : "Unknown";

console.log(`  Type   : ${keyType}`);

let privateKey;
try {
  privateKey = await importPKCS8(pem, "RS256");
  console.log("  ✓  Key imported successfully");
} catch (err) {
  console.error(`  ✗  Failed to import key: ${err.message}`);
  process.exit(1);
}

// ---- Step 2: generate JWT ---------------------------------------------------
console.log("\nStep 2 — Generate RS256 JWT");
console.log(`  Application ID : ${APP_ID}`);

const jwt = await new SignJWT({})
  .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: APP_ID })
  .setIssuer("enablebanking.com")
  .setAudience("api.enablebanking.com")
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(privateKey);

const claims = decodeJwt(jwt);
console.log("  ✓  JWT generated");
console.log(`     iss : ${claims.iss}`);
console.log(`     aud : ${claims.aud}`);
console.log(`     iat : ${new Date(claims.iat * 1000).toISOString()}`);
console.log(`     exp : ${new Date(claims.exp * 1000).toISOString()}`);
console.log(`     kid : (in header) ${APP_ID}`);
console.log(`\n  JWT preview (first 80 chars): ${jwt.slice(0, 80)}...`);

// ---- Step 3: hit the Enable Banking API ------------------------------------
console.log("\nStep 3 — Verify JWT against Enable Banking API");
console.log(`  Calling GET ${API_BASE}/application ...`);

let apiOk = false;
try {
  // Step 3a: verify app registration
  const appRes = await fetch(`${API_BASE}/application`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  const appBody = await appRes.text();

  if (appRes.ok) {
    const app = JSON.parse(appBody);
    console.log(`  ✓  Application recognised by Enable Banking API`);
    console.log(`     Name : ${app.name}`);
    console.log(`     Kid  : ${app.kid}`);
    if (app.redirect_urls) {
      console.log(`     Redirect URLs: ${app.redirect_urls.join(", ")}`);
    }
    apiOk = true;
  } else {
    console.error(`  ✗  API returned ${appRes.status}: ${appBody}`);
  }

  // Step 3b: list Finnish banks available
  if (apiOk) {
    console.log(`\n  Calling GET ${API_BASE}/aspsps?country=FI ...`);
    const aspspsRes = await fetch(`${API_BASE}/aspsps?country=FI`, {
      headers: { Authorization: `Bearer ${jwt}` },
    });
    if (aspspsRes.ok) {
      const data = await aspspsRes.json();
      const banks = data.aspsps || [];
      const names = banks.map((b) => b.name).join(", ");
      console.log(`  ✓  Found ${banks.length} Finnish ASPSPs: ${names}`);
    }
  }
} catch (err) {
  console.error(`  ✗  Network error: ${err.message}`);
}

// ---- Summary ----------------------------------------------------------------
console.log("\n" + "─".repeat(60));
if (apiOk) {
  console.log(
    "✓  All checks passed! Your credentials are working correctly."
  );
  console.log(
    "\nNext steps:\n  1. Run the MCP server:  node server.js\n  2. In Claude, call start_bank_auth({ aspsp_name: 'OP', aspsp_country: 'FI' })\n  3. Visit the returned URL, authorize, then call complete_bank_auth with the redirect URL."
  );
} else {
  console.log(
    "✗  Some checks failed — review errors above before using the MCP server."
  );
}
console.log("─".repeat(60) + "\n");
