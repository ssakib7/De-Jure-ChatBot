// Multi-turn memory test — simulates a back-and-forth so we can confirm the bot
// uses prior context. Mirrors server.js's history mechanism (contents array of turns).
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
- ALWAYS reply in Bengali (Bangla), even if the customer writes in English (official course names may keep their original spelling).
- Sound natural and conversational; keep replies SHORT (usually 1–3 sentences).
- Do NOT greet unless THIS message is itself a greeting. NEVER use "নমস্কার".
- Answer ONLY using facts in the knowledge base below; never invent prices, dates, or course names.

=== KNOWLEDGE BASE ===
${knowledgeBase}`;

const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const history = [];

async function turn(userText) {
  history.push({ role: "user", parts: [{ text: userText }] });
  const response = await genai.models.generateContent({
    model: MODEL,
    contents: history,
    config: { systemInstruction: SYSTEM_PROMPT, maxOutputTokens: 1024 },
  });
  const reply = response.text?.trim() || "(no reply)";
  history.push({ role: "model", parts: [{ text: reply }] });
  console.log("👤", userText);
  console.log("🤖", reply, "\n");
}

await turn("apnader notun class shuru hoyeche??");
await turn("Bar Council"); // short follow-up — only makes sense WITH memory
