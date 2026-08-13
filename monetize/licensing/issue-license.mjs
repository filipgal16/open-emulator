#!/usr/bin/env node
// Issues one signed Pro license key. Stands in for "the payment webhook
// calls this" until real checkout automation exists (see docs/ROADMAP.md)
// — for now, run it by hand after a sale closes however it closed.
//
// Usage:
//   node monetize/licensing/issue-license.mjs --email buyer@example.com [--tier pro] [--days 0]
//
// --days 0 (default) issues a license that never expires (a lifetime key).
// Prints the license string to paste into the app's "Activate" field.
import { createPrivateKey, randomUUID, sign as cryptoSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalize } from "../server/lib/license.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE_PATH = path.join(__dirname, "keys", "private.jwk.json");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email) {
    console.error("Usage: node issue-license.mjs --email buyer@example.com [--tier pro] [--days 0]");
    process.exit(1);
  }

  let privateJwk;
  try {
    privateJwk = JSON.parse(await readFile(PRIVATE_PATH, "utf8"));
  } catch {
    console.error(`No private key at ${PRIVATE_PATH} — run keygen.mjs first.`);
    process.exit(1);
  }

  const days = Number(args.days) || 0;
  const payload = {
    id: `lic_${randomUUID().replace(/-/g, "")}`,
    email: args.email,
    tier: args.tier || "pro",
    issuedAt: new Date().toISOString(),
    expiresAt: days > 0 ? new Date(Date.now() + days * 86400000).toISOString() : null
  };

  const privateKey = createPrivateKey({ key: privateJwk, format: "jwk" });
  const signature = cryptoSign(null, Buffer.from(canonicalize(payload)), privateKey).toString("base64url");
  const license = Buffer.from(JSON.stringify({ payload, signature })).toString("base64url");

  console.log("License payload:");
  console.log(JSON.stringify(payload, null, 2));
  console.log("\nLicense key (paste into the app):\n");
  console.log(license);
}

main();
