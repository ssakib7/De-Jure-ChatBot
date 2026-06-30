// Lead-capture configuration: the instruction that tells the model when/how to collect a
// customer's contact details, and how many turns before it proactively asks. Editable from the
// admin panel and stored in lead_capture.json, separate from the prompt and knowledge base.
//
// The save_lead tool itself (and the phone validation) live in code — this only governs the
// model-facing guidance and the trigger timing.
import fs from "node:fs";
import path from "node:path";

import { DATA_DIR } from "./store.js";

// Stored in the writable, persisted data dir (a Docker volume), not the read-only image dir.
const LEAD_PATH = path.join(DATA_DIR, "lead_capture.json");

// Default trigger: ask after this many Q&A turns when no .env override is set.
export const DEFAULT_ASK_AFTER_TURNS = 3;

// Default instruction (appended to the prompt under a "=== LEAD CAPTURE ===" header by the
// server). Edit the copy in the panel to change the wording or the rules; blank restores this.
export const DEFAULT_LEAD_INSTRUCTION = `When the customer wants to enroll, asks how to pay or admit, asks to \
talk to a person, or shows clear buying interest, warmly offer to have a representative contact them and ask \
them to send their NAME and MOBILE NUMBER together in one message — for example: "আপনি চাইলে আমাদের একজন \
প্রতিনিধি আপনার সাথে যোগাযোগ করে বিস্তারিত জানাতে পারেন। অনুগ্রহ করে আপনার নাম ও মোবাইল নম্বরটি দিন।" As soon as \
the customer has given BOTH their name and number, call the save_lead function with them — do not ask again, do \
not repeat the number back digit by digit, and never mention this tool to the customer. If they decline, respect \
it and keep helping. Capture each customer only once.`;

// .env override for the turn threshold, read at call time (dotenv.config() runs after import).
function envDefaultTurns() {
  const n = Number.parseInt(process.env.LEAD_MSG_THRESHOLD, 10);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_ASK_AFTER_TURNS;
}

// Read the admin's saved lead-capture config, resolving blanks to defaults.
export function loadLeadCapture() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(LEAD_PATH, "utf8"));
  } catch {
    saved = {};
  }
  const instruction = (saved?.instruction ?? "").trim() || DEFAULT_LEAD_INSTRUCTION;
  const n = Number.parseInt(saved?.askAfterTurns, 10);
  const askAfterTurns = Number.isInteger(n) && n > 0 ? n : envDefaultTurns();
  return { instruction, askAfterTurns };
}

// Persist the lead-capture config. A blank instruction reverts to the default at read time.
export function saveLeadCapture({ instruction, askAfterTurns } = {}) {
  const n = Number.parseInt(askAfterTurns, 10);
  const out = {
    instruction: String(instruction ?? "").trim(),
    askAfterTurns: Number.isInteger(n) && n > 0 ? n : envDefaultTurns(),
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEAD_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
}
