#!/usr/bin/env node
// Generates the Ed25519 keypair that backs Pro license keys. Run this once
// per real deployment — the demo keypair committed for local testing is
// NOT meant for production; see monetize/README.md.
//
// Usage: node monetize/licensing/keygen.mjs [--force]
import { generateKeyPairSync } from "node:crypto";
import { mkdir, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = path.join(__dirname, "keys");
const PRIVATE_PATH = path.join(KEYS_DIR, "private.jwk.json");
const PUBLIC_PATH = path.join(KEYS_DIR, "public.jwk.json");
const CLIENT_PUBLIC_PATH = path.resolve(__dirname, "..", "..", "desktop", "config", "license-public-key.json");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const force = process.argv.includes("--force");
  if (!force && (await exists(PRIVATE_PATH))) {
    console.error(`A key already exists at ${PRIVATE_PATH}. Pass --force to overwrite (this invalidates every`);
    console.error("license key issued with the old one).");
    process.exit(1);
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicJwk = publicKey.export({ format: "jwk" });
  const privateJwk = privateKey.export({ format: "jwk" });

  await mkdir(KEYS_DIR, { recursive: true });
  await writeFile(PRIVATE_PATH, `${JSON.stringify(privateJwk, null, 2)}\n`, { mode: 0o600 });
  await writeFile(PUBLIC_PATH, `${JSON.stringify(publicJwk, null, 2)}\n`);

  // The client only ever needs the public half, baked in at build time for
  // fully offline verification — never point the app at PRIVATE_PATH.
  await mkdir(path.dirname(CLIENT_PUBLIC_PATH), { recursive: true });
  await writeFile(CLIENT_PUBLIC_PATH, `${JSON.stringify(publicJwk, null, 2)}\n`);

  console.log(`Wrote private key: ${PRIVATE_PATH} (gitignored — back this up somewhere safe, losing it means`);
  console.log("re-issuing every outstanding license under a new key).");
  console.log(`Wrote public key:  ${PUBLIC_PATH}`);
  console.log(`Copied public key into the client: ${CLIENT_PUBLIC_PATH}`);
}

main();
