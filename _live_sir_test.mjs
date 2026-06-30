import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";
import { loadKb, buildSystemPrompt, loadSystemPrompt, loadPromptSections, loadAnsweringRules } from "./kb.js";
import { loadLeadCapture } from "./lead_capture.js";
dotenv.config();

const MODEL = "gemini-3.1-flash-lite";
const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const TOOL = { functionDeclarations: [{ name: "save_lead", description: "Save name + phone for follow-up. Call only after both given.", parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING }, phone: { type: Type.STRING } }, required: ["name", "phone"] } }] };
const instruction = buildSystemPrompt(loadKb(), loadSystemPrompt(), loadPromptSections(), loadAnsweringRules()) + `\n\n=== LEAD CAPTURE ===\n${loadLeadCapture().instruction}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gen(cfg) {
  for (let a = 0; a < 4; a++) {
    try { return await genai.models.generateContent(cfg); }
    catch (e) { if (String(e?.message || e).includes("503") || String(e).includes("UNAVAILABLE")) { await sleep(3000); continue; } throw e; }
  }
  throw new Error("model unavailable after retries");
}

let good = 0, runs = 0;
try {
  for (let i = 0; i < 3; i++) {
    runs++;
    const contents = [{ role: "user", parts: [{ text: "sakib, 01629448001" }] }];
    const r1 = await gen({ model: MODEL, contents, config: { systemInstruction: instruction, tools: [TOOL], maxOutputTokens: 1024 } });
    const call = (r1.functionCalls ?? []).find((c) => c.name === "save_lead");
    let text;
    if (call) {
      const parts = r1.candidates?.[0]?.content?.parts ?? [{ functionCall: call }];
      const r2 = await gen({ model: MODEL, contents: [...contents, { role: "model", parts }, { role: "user", parts: [{ functionResponse: { name: "save_lead", response: { status: "ok" } } }] }], config: { systemInstruction: instruction, maxOutputTokens: 1024 } });
      text = (r2.text || "").trim();
    } else text = (r1.text || "").trim();
    const usesSir = /(স্যার|ম্যাডাম)/.test(text);
    const usesVai = /(ভাই|ভাইয়া|আপু)/.test(text);
    const ok = usesSir && !usesVai;
    if (ok) good++;
    console.log(`run ${i + 1}: ${ok ? "✅" : "❌"} sir/madam=${usesSir} vai=${usesVai} :: ${text.slice(0, 80)}`);
  }
  console.log(`\n${good === runs ? "PASS" : `${good}/${runs} good`} — uses স্যার/ম্যাডাম, no ভাই`);
  process.exit(good === runs ? 0 : 2);
} catch (e) { console.log("ERROR:", e?.message || e); process.exit(3); }
