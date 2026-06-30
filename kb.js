// Knowledge base data layer.
// `knowledge_base.json` is the canonical source of truth (edited via the admin panel).
// The markdown file and the Gemini system prompt are GENERATED from it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, "knowledge_base.json");
const MD_PATH = path.join(__dirname, "knowledge_base.md");
// The admin-editable prompt files live in the writable, persisted data dir (a Docker volume) —
// not in the image's /app dir, which the container's non-root user can't write to.
// The system prompt lives in its own file, separate from the knowledge base.
const PROMPT_PATH = path.join(DATA_DIR, "system_prompt.txt");
// Admin-defined prompt scenarios (examples / "when X do Y" guidance), appended to the prompt.
const PROMPT_SECTIONS_PATH = path.join(DATA_DIR, "prompt_sections.json");
// Admin-editable answering rules (AI do's and don'ts), appended to the prompt as instructions.
const ANSWERING_RULES_PATH = path.join(DATA_DIR, "answering_rules.txt");

// Make sure the data dir exists before writing a config file into it.
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// The bot's core instructions (persona + writing/answering style). This is the DEFAULT used
// whenever the admin hasn't set a custom system prompt in the admin panel. The knowledge base
// is assembled onto this separately (see buildSystemPrompt), so editing one never touches the
// other. Keep this in sync with the writing/answering style we want from the bot.
export const DEFAULT_SYSTEM_PROMPT = `You are a real, friendly member of the De Jure Academy support team replying to \
customers in the Facebook Page inbox. De Jure Academy is a Bangladesh law-education platform (BJS Judicial \
Service and Bar Council exam preparation). Chat the way a warm, helpful human page admin would on Messenger \
— never like a brochure or a bot.

How to write:
- ALWAYS reply in Bengali (Bangla), even if the customer writes in English. (Official course names may keep \
their original spelling as in the knowledge base.)
- Sound like a real person: warm, natural, conversational. Keep replies SHORT — usually 1–3 sentences. \
Get to the point.
- Do NOT greet or welcome the customer UNLESS their current message is itself a greeting (e.g. they wrote \
"আসসালামু আলাইকুম", "হ্যালো", "hi", "hello"). For any normal question or request — like asking about a course, \
price, or schedule — answer DIRECTLY with no greeting and no welcome line. NEVER use "নমস্কার". \
(Note: you have no memory of past messages, so never assume whether this is the first message — decide purely \
from whether THIS message is a greeting.)
- Use a numbered/bulleted list ONLY when you are actually listing several courses or prices. For a single \
course or a short answer, write it as a normal sentence or two, not a formatted list.
- When a price has both a regular and an offer price, lead with the current offer price. Use ৳ for amounts.

What to answer:
- Answer ONLY using facts in the knowledge base below. NEVER invent prices, dates, guarantees, course names, \
phone numbers, or anything not written there.
- Only offer to connect the customer to a human or share contact details when you genuinely CANNOT answer from \
the knowledge base — e.g. exact payment steps, a personal account/payment status, refunds, or a schedule that \
isn't listed. If you have already fully answered the question, do NOT tack on a "we'll connect you to a \
representative" line — just answer warmly and stop.`;

// Structural marker placed between the instructions above and the generated knowledge base.
const KB_SEPARATOR = "\n\n=== KNOWLEDGE BASE ===\n";

// Read and parse the canonical JSON data.
export function loadKb() {
  return JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
}

// Read the admin-edited system prompt from its own file, or the built-in default when the
// file is missing or blank. Kept separate from the knowledge base by design.
export function loadSystemPrompt() {
  try {
    const text = fs.readFileSync(PROMPT_PATH, "utf8");
    return text.trim() ? text : DEFAULT_SYSTEM_PROMPT;
  } catch {
    return DEFAULT_SYSTEM_PROMPT;
  }
}

// Persist the system prompt to its own file. Stored raw; a blank value reverts to the
// default at read time (see loadSystemPrompt).
export function saveSystemPrompt(text) {
  ensureDataDir();
  fs.writeFileSync(PROMPT_PATH, String(text ?? ""), "utf8");
}

// Admin-defined prompt scenarios: an array of { title, body } appended to the system prompt
// (examples, "when X do Y" guidance). Stored alongside the prompt, separate from the KB.
export function loadPromptSections() {
  try {
    const arr = JSON.parse(fs.readFileSync(PROMPT_SECTIONS_PATH, "utf8"));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function savePromptSections(sections) {
  const clean = (Array.isArray(sections) ? sections : [])
    .map((s) => ({ title: (s?.title ?? "").trim(), body: s?.body ?? "" }))
    .filter((s) => s.title || s.body.trim());
  ensureDataDir();
  fs.writeFileSync(PROMPT_SECTIONS_PATH, JSON.stringify(clean, null, 2) + "\n", "utf8");
}

// Default answering rules (AI do's and don'ts). Edit the copy in the panel to change them;
// a blank value restores this default.
export const DEFAULT_ANSWERING_RULES = `- Answer **only** using facts in the knowledge base below. If asked something not covered there \
(exact batch schedules beyond those listed, refunds, a customer's individual account/payment status), \
say you'll connect them to a human and share the phone/Facebook page — do not guess.
- **Never invent** prices, dates, guarantees, or course names.
- **Always reply in Bengali (Bangla)**, regardless of the language the customer writes in.
- Keep replies **short, warm, and helpful**. Use ৳ for prices.
- If a price has both a regular and offer price, mention the current offer price first.`;

// Read the answering rules. If the file exists, it wins (a blank file means the admin cleared
// it → use the default). If the file doesn't exist yet, fall back once to the value still in
// knowledge_base.json (migration), else the built-in default.
export function loadAnsweringRules() {
  try {
    const text = fs.readFileSync(ANSWERING_RULES_PATH, "utf8");
    return text.trim() ? text : DEFAULT_ANSWERING_RULES;
  } catch {
    /* no file yet — migrate from the KB json below */
  }
  try {
    const kb = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    if ((kb.answeringRules ?? "").trim()) return kb.answeringRules;
  } catch {
    /* fall through */
  }
  return DEFAULT_ANSWERING_RULES;
}

// Persist answering rules to their own file. A blank value reverts to the default at read time.
export function saveAnsweringRules(text) {
  ensureDataDir();
  fs.writeFileSync(ANSWERING_RULES_PATH, String(text ?? ""), "utf8");
}

// Group digits with thousands commas: "22000" -> "22,000". Non-numeric input is returned as-is.
function groupDigits(value) {
  const s = String(value ?? "").trim();
  if (!s || !/^\d+$/.test(s)) return s;
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Format one mode's price cell: "৳22,000", "৳20,000 (reg 22,000)", or "—" when blank.
function formatPrice(price) {
  const offer = (price?.offer ?? "").trim();
  if (!offer) return "—";
  const regular = (price?.regular ?? "").trim();
  const base = `৳${groupDigits(offer)}`;
  return regular ? `${base} (reg ${groupDigits(regular)})` : base;
}

// Build the markdown knowledge base from the structured data. Mirrors the original layout.
export function renderMarkdown(kb) {
  const lines = [];
  lines.push("# De Jure Academy — Knowledge Base");
  lines.push("");
  lines.push("> Source of truth for the Facebook Messenger AI auto-reply bot.");
  lines.push("> Generated from knowledge_base.json via the admin panel. Edit there, not here.");
  lines.push("");

  // `about` holds the intro plus the Core values / Mission / Vision subsections as markdown.
  lines.push("## About");
  lines.push(kb.about?.trim() ?? "");
  lines.push("");

  const c = kb.contact ?? {};
  lines.push("## Contact");
  lines.push(`- Phone / WhatsApp: ${c.phone?.trim() || "TODO"}`);
  lines.push(`- Email: ${c.email?.trim() || "TODO"}`);
  lines.push(`- Address / Campus: ${c.address?.trim() || "TODO"}`);
  lines.push(`- Office hours: ${c.officeHours?.trim() || "TODO"}`);
  lines.push("");

  lines.push("## Courses");
  lines.push('Prices are in BDT (৳). "Offer" = current sale price; "regular" shown when different.');
  lines.push("Modes: **online** = live online classes · **offline** = campus classes · **online+offline** = both.");
  lines.push("Seats are limited per batch.");
  lines.push("");
  for (const cat of kb.courseCategories ?? []) {
    lines.push(`### ${cat.name}`);
    const extraCols = cat.extraColumns ?? [];
    const headers = ["Course", "Online", "Offline", "Online+Offline", "Duration", "Starts", ...extraCols];
    lines.push(`| ${headers.join(" | ")} |`);
    lines.push(`|${headers.map(() => "---").join("|")}|`);
    for (const course of cat.courses ?? []) {
      const cells = [
        course.name,
        formatPrice(course.online),
        formatPrice(course.offline),
        formatPrice(course.onlineOffline),
        course.duration?.trim() || "—",
        course.starts?.trim() || "—",
        ...extraCols.map((_, k) => (course.extra?.[k] ?? "").trim() || "—"),
      ];
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  lines.push("## Books / Products (BDT ৳)");
  lines.push(kb.books?.trim() ?? "");
  lines.push("");
  lines.push("## How to enroll / pay");
  lines.push(kb.enroll?.trim() ?? "");
  lines.push("");

  // Admin-defined free-form sections (added via the admin panel). Each is plain markdown
  // appended to the knowledge base as written, so the bot treats it like any other fact.
  for (const section of kb.customSections ?? []) {
    const title = (section?.title ?? "").trim();
    const body = (section?.body ?? "").trim();
    if (!title && !body) continue;
    lines.push(`## ${title || "Additional information"}`);
    lines.push(body);
    lines.push("");
  }

  return lines.join("\n");
}

// Render admin-defined prompt scenarios into a block appended to the system prompt, so the
// AI follows them (example conversations, "when X do Y" rules). Empty when none are set.
function renderPromptSections(sections) {
  const blocks = (sections ?? [])
    .map((s) => {
      const title = (s?.title ?? "").trim();
      const body = (s?.body ?? "").trim();
      if (!title && !body) return "";
      return `\n\n### ${title || "Scenario"}\n${body}`;
    })
    .filter(Boolean)
    .join("");
  return blocks ? `\n\n=== EXAMPLES & SCENARIOS ===${blocks}` : "";
}

// The full system instruction sent to Gemini: the system prompt (or default), then the answering
// rules, then any prompt scenarios, then the generated knowledge base. Prompt, rules, and
// scenarios are passed in explicitly — they live in their own files, separate from the KB.
export function buildSystemPrompt(kb, systemPrompt, promptSections = [], answeringRules = "") {
  const header = (systemPrompt ?? "").trim() || DEFAULT_SYSTEM_PROMPT;
  const rules = (answeringRules ?? "").trim();
  const rulesBlock = rules ? `\n\n=== ANSWERING RULES ===\n${rules}` : "";
  return header + rulesBlock + renderPromptSections(promptSections) + KB_SEPARATOR + renderMarkdown(kb);
}

// Persist the structured data, and regenerate the human-readable markdown alongside it.
export function saveKb(kb) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(kb, null, 2) + "\n", "utf8");
  fs.writeFileSync(MD_PATH, renderMarkdown(kb), "utf8");
}
