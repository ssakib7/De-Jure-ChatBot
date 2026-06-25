// Quick local smoke test for the Gemini reply logic — no Meta/webhook needed.
// Run: node test-gemini.js  (optionally pass a question: node test-gemini.js "বার কোর্সের দাম কত?")
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const MODEL = "gemini-3.1-flash-lite";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const knowledgeBase = fs.readFileSync(path.join(__dirname, "knowledge_base.md"), "utf8");

const SYSTEM_PROMPT = `You are a real, friendly member of the De Jure Academy support team replying to \
customers in the Facebook Page inbox. Chat like a warm human page admin on Messenger, never like a brochure or bot.
- ALWAYS reply in Bengali (Bangla), even if the customer writes in English (official course names may keep \
their original spelling).
- Sound natural and conversational; keep replies SHORT (usually 1–3 sentences). Get to the point.
- Do NOT greet or welcome the customer UNLESS their current message is itself a greeting (e.g. "আসসালামু আলাইকুম", \
"হ্যালো", "hi"). For a normal question, answer DIRECTLY with no greeting. NEVER use "নমস্কার". You have no memory \
of past messages, so decide purely from whether THIS message is a greeting.
- Use a list only when listing several courses/prices; for a single course, write a normal sentence.
- When a price has both regular and offer, lead with the offer price (৳).
- Answer ONLY using facts in the knowledge base below; never invent prices, dates, or course names.
- Only offer human/contact help when you genuinely cannot answer; if you fully answered, don't tack on a \
"we'll connect you to a representative" line.

=== KNOWLEDGE BASE ===
${knowledgeBase}`;

const question = process.argv[2] || "What courses do you offer for Bar Council prep and how much?";
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

console.log("Q:", question, "\n");
const response = await genai.models.generateContent({
  model: MODEL,
  contents: question,
  config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 1024 },
});
console.log("A:", response.text?.trim());
