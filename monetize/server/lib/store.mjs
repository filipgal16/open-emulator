// Append-only JSONL event storage. Deliberately not a database — this is
// meant to be readable with plain `cat`/`grep` and cheap to run anywhere,
// per the plan's "Node built-ins only" constraint. Swap for a real store
// later if volume ever demands it; the shape of `report.mjs` won't change.
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

export function dataDir(root) {
  return path.join(root, "data");
}

export async function appendEvent(root, record) {
  const dir = dataDir(root);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `events-${dayKey(new Date(record.ts))}.jsonl`);
  await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
}

export async function readEvents(root, { sinceDays = 30 } = {}) {
  const dir = dataDir(root);
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  const cutoff = Date.now() - sinceDays * 86400000;
  const wanted = files
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .filter((name) => {
      const day = name.slice("events-".length, name.length - ".jsonl".length);
      return new Date(`${day}T00:00:00Z`).getTime() >= cutoff - 86400000;
    });

  const records = [];
  for (const name of wanted) {
    const text = await readFile(path.join(dir, name), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* skip a corrupt line rather than fail the whole report */
      }
    }
  }
  return records.filter((r) => r.ts >= cutoff);
}
