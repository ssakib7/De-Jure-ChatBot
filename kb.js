// Knowledge base data layer.
// `knowledge_base.json` is the canonical source of truth (edited via the /admin panel).
// The markdown file and the Gemini system prompt are GENERATED from it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JSON_PATH = path.join(__dirname, "knowledge_base.json");
const MD_PATH = path.join(__dirname, "knowledge_base.md");

// The fixed instructions the AI always gets, with the generated KB appended.
// Keep this in sync with the writing/answering style we want from the bot.
const PROMPT_HEADER = `You are a real, friendly member of the De Jure Academy support team replying to \
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
representative" line — just answer warmly and stop.

=== KNOWLEDGE BASE ===
`;

// Read and parse the canonical JSON data.
export function loadKb() {
  return JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
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
  lines.push("> Generated from knowledge_base.json via the /admin panel. Edit there, not here.");
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
    lines.push("| Course | Online | Offline | Online+Offline | Duration | Starts |");
    lines.push("|---|---|---|---|---|---|");
    for (const course of cat.courses ?? []) {
      lines.push(
        `| ${course.name} | ${formatPrice(course.online)} | ${formatPrice(course.offline)} | ` +
          `${formatPrice(course.onlineOffline)} | ${course.duration?.trim() || "—"} | ${course.starts?.trim() || "—"} |`
      );
    }
    lines.push("");
  }

  lines.push("## Books / Products (BDT ৳)");
  lines.push(kb.books?.trim() ?? "");
  lines.push("");
  lines.push("## How to enroll / pay");
  lines.push(kb.enroll?.trim() ?? "");
  lines.push("");
  lines.push("## Answering rules (instructions to the AI)");
  lines.push(kb.answeringRules?.trim() ?? "");
  lines.push("");

  return lines.join("\n");
}

// The full system instruction sent to Gemini.
export function buildSystemPrompt(kb) {
  return PROMPT_HEADER + renderMarkdown(kb);
}

// Persist the structured data, and regenerate the human-readable markdown alongside it.
export function saveKb(kb) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(kb, null, 2) + "\n", "utf8");
  fs.writeFileSync(MD_PATH, renderMarkdown(kb), "utf8");
}
