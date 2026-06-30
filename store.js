// Lightweight, dependency-free persistence for conversation state and known customers.
//
// At runtime everything lives in memory (see the Maps in server.js); this module just
// snapshots that state to a JSON file so a restart/redeploy doesn't lose active chats,
// pending follow-up nudges, or the roster of customers we've already captured.
//
// File shape (data/bot.db.json):
//   { "version": 1,
//     "sessions":  [[senderId, session], ...],
//     "customers": [[senderId, customer], ...] }
//
// Notes:
// - Writes are atomic (temp file + rename) so a crash mid-write can't corrupt the db.
// - The live `followUpTimer` (a Node Timeout) is never serialized — on load, server.js
//   recomputes and re-arms pending nudges from each session's `lastActive`.
// - Matches the project's existing file-based persistence (knowledge_base.json) — no DB
//   server and no native modules, which keeps the node:22-alpine image simple.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Writable, persisted data directory (mounted as a volume in Docker). Holds bot.db.json plus
// the admin-editable config files (system prompt, scenarios, answering rules, lead capture),
// which the container's non-root user can't write into the image's /app dir.
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "bot.db.json");
const TMP_PATH = DB_PATH + ".tmp";

// Set whenever in-memory state changes; flush() is a no-op until something is dirty.
let dirty = false;
export function markDirty() {
  dirty = true;
}

// Read persisted state. Returns { sessions, customers } as Maps — empty when there's no
// file yet or it's unreadable/corrupt (we log and start fresh rather than crash on boot).
export function load() {
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    return {
      sessions: new Map(data.sessions ?? []),
      customers: new Map(data.customers ?? []),
    };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Could not read ${DB_PATH}; starting with empty state:`, err.message);
    }
    return { sessions: new Map(), customers: new Map() };
  }
}

// Drop the non-serializable live timer before writing a session.
function serializeSession(session) {
  const { followUpTimer, ...rest } = session;
  return rest;
}

// Atomically write current state to disk. Synchronous so it can run from a shutdown
// handler. No-op when nothing changed since the last flush (unless forced).
export function flush(sessions, customers, { force = false } = {}) {
  if (!dirty && !force) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const payload = {
      version: 1,
      sessions: [...sessions].map(([id, s]) => [id, serializeSession(s)]),
      customers: [...customers],
    };
    fs.writeFileSync(TMP_PATH, JSON.stringify(payload), "utf8");
    fs.renameSync(TMP_PATH, DB_PATH);
    dirty = false;
  } catch (err) {
    console.error("Failed to persist state:", err.message);
  }
}

export { DB_PATH };
