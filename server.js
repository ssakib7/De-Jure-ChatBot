import crypto from "node:crypto";

import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

import { loadKb, buildSystemPrompt } from "./kb.js";
import { createAdminRouter } from "./admin.js";

dotenv.config();

const {
  PAGE_ACCESS_TOKEN,
  APP_SECRET,
  VERIFY_TOKEN,
  GEMINI_API_KEY,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  PORT = 3000,
} = process.env;

// Fail fast if a required secret is missing — clearer than a cryptic runtime error later.
for (const [name, value] of Object.entries({
  PAGE_ACCESS_TOKEN,
  APP_SECRET,
  VERIFY_TOKEN,
  GEMINI_API_KEY,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  SESSION_SECRET,
})) {
  if (!value) {
    console.error(`Missing required env var: ${name}. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
}

const GRAPH_API = "https://graph.facebook.com/v21.0";
const MODEL = "gemini-3.1-flash-lite"; // fast + cheap, ideal for short FAQ replies

// Build the AI's system prompt from the knowledge base. `let` so the admin panel can hot-reload it.
let systemPrompt = buildSystemPrompt(loadKb());

// Re-read knowledge_base.json and rebuild the prompt — called after an admin saves an edit,
// so new replies use the new data without restarting the bot.
function reloadKb() {
  systemPrompt = buildSystemPrompt(loadKb());
  console.log("Knowledge base reloaded from admin edit.");
}

const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- In-memory conversation memory (per Facebook sender) ---
// Lets the bot follow up naturally ("which course?" -> "the second one").
// Note: this lives in process memory, so it resets if the server restarts.
const SESSION_TTL_MS = 30 * 60 * 1000; // forget a conversation after 30 min idle
const MAX_HISTORY = 10; // keep the last 10 messages (~5 exchanges) per customer
const sessions = new Map(); // senderId -> { history: Content[], lastActive: number }

function getSession(senderId) {
  const now = Date.now();
  const existing = sessions.get(senderId);
  if (!existing || now - existing.lastActive > SESSION_TTL_MS) {
    const fresh = { history: [], lastActive: now };
    sessions.set(senderId, fresh);
    return fresh;
  }
  existing.lastActive = now;
  return existing;
}

// Periodically drop idle conversations so memory stays bounded.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS) sessions.delete(id);
  }
}, SESSION_TTL_MS).unref();

const app = express();

// Capture the raw request body so we can verify Meta's X-Hub-Signature-256 HMAC.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// Parse form posts from the admin panel (the webhook stays JSON above).
app.use(express.urlencoded({ extended: true }));

// Admin web panel for editing the knowledge base (login-protected).
app.use(
  "/admin",
  createAdminRouter({
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    sessionSecret: SESSION_SECRET,
    onSaved: reloadKb,
  })
);

// --- Webhook verification handshake (GET /webhook) ---
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verified.");
    res.status(200).send(challenge);
  } else {
    console.warn("Webhook verification failed (bad mode or verify token).");
    res.sendStatus(403);
  }
});

// --- Incoming message events (POST /webhook) ---
app.post("/webhook", (req, res) => {
  if (!verifySignature(req)) {
    console.warn("Invalid X-Hub-Signature-256 — rejecting request.");
    return res.sendStatus(403);
  }

  const body = req.body;
  if (body.object !== "page") {
    return res.sendStatus(404);
  }

  // Acknowledge fast so Meta doesn't retry; do Gemini + Send work afterwards.
  res.status(200).send("EVENT_RECEIVED");

  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      handleMessagingEvent(event).catch((err) =>
        console.error("Error handling event:", err)
      );
    }
  }
});

app.get("/", (_req, res) => res.send("De Jure Academy bot is running."));

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  const message = event.message;

  if (!senderId || !message) return;
  if (message.is_echo) return; // our own outgoing messages echoed back

  if (!message.text) {
    // Non-text (sticker, image, etc.) — polite fallback.
    await sendMessage(
      senderId,
      "অনুগ্রহ করে আপনার প্রশ্নটি লিখে পাঠান, আমরা সাহায্য করতে পেরে আনন্দিত হবো।"
    );
    return;
  }

  const reply = await askGemini(senderId, message.text);
  await sendMessage(senderId, reply);
}

async function askGemini(senderId, userText) {
  const session = getSession(senderId);
  const userTurn = { role: "user", parts: [{ text: userText }] };
  // Send prior turns + this new message so Gemini has the conversation context.
  const contents = [...session.history, userTurn];

  try {
    const response = await genai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: systemPrompt,
        maxOutputTokens: 1024,
      },
    });
    const reply =
      response.text?.trim() ||
      "দুঃখিত, একটি সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।";

    // Commit this exchange to memory, then trim oldest pairs to the cap.
    session.history.push(userTurn, { role: "model", parts: [{ text: reply }] });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }
    return reply;
  } catch (err) {
    console.error("Gemini API error:", err);
    // Don't store failed turns, so a transient error doesn't pollute history.
    return "দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।";
  }
}

async function sendMessage(recipientId, text) {
  try {
    const res = await fetch(`${GRAPH_API}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text },
      }),
    });
    if (!res.ok) {
      console.error("Send API error:", res.status, await res.text());
    }
  } catch (err) {
    console.error("Send API request failed:", err);
  }
}

// Verify the request really came from Meta using HMAC-SHA256 over the raw body.
function verifySignature(req) {
  const signature = req.get("x-hub-signature-256");
  if (!signature || !req.rawBody) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(req.rawBody).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  return sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf);
}

app.listen(PORT, () => {
  console.log(`De Jure Academy bot listening on http://localhost:${PORT}`);
});
