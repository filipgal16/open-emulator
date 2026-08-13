import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SERVER_ROOT = path.resolve(__dirname, "..");
export const CONFIG_DIR = path.join(SERVER_ROOT, "config");

const DEV_SECRET = "dev-only-insecure-secret-change-me";

export function env() {
  const clickSigningSecret = process.env.CLICK_SIGNING_SECRET || DEV_SECRET;
  if (clickSigningSecret === DEV_SECRET) {
    console.warn(
      "[monetize/server] CLICK_SIGNING_SECRET is not set — using an insecure default. " +
        "Set a real secret before deploying anywhere reachable from the internet."
    );
  }
  return {
    port: Number(process.env.PORT) || 8787,
    clickSigningSecret,
    licensePublicKeyPath:
      process.env.LICENSE_PUBLIC_KEY_PATH || path.join(SERVER_ROOT, "..", "licensing", "keys", "public.jwk.json")
  };
}

export async function loadJson(relativePath, fallback) {
  try {
    const text = await readFile(path.join(CONFIG_DIR, relativePath), "utf8");
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function loadCampaigns() {
  return loadJson("campaigns.json", { dismissHours: 24, slots: {} });
}

export async function loadPartners() {
  return loadJson("partners.json", {});
}
