import crypto from "node:crypto";

import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI, Type } from "@google/genai";

import { loadKb, buildSystemPrompt, loadSystemPrompt, loadPromptSections, loadAnsweringRules } from "./kb.js";
import { createAdminRouter } from "./admin.js";
import { isLeadConfigured, saveLead } from "./lead.js";
import { loadLeadCapture } from "./lead_capture.js";
import * as store from "./store.js";

dotenv.config();

const {
  PAGE_ACCESS_TOKEN,
  APP_SECRET,
  VERIFY_TOKEN,
  GEMINI_API_KEY,
  ADMIN_USERNAME,
  ADMIN_PASSWORD,
  SESSION_SECRET,
  FB_BUSINESS_ID, // optional: for building inbox deep-links on leads
  FB_PAGE_ID, // optional: the page's asset_id in Business Suite
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
const MODEL = "gemini-3.5-flash"; // fast + cheap, ideal for short FAQ replies + tool calls

const LEADS_ON = isLeadConfigured();

// Persistent memory: when on, the bot remembers conversations and captured customers across
// restarts, and skips the lead ask for anyone already captured. Set MEMORY_ENABLED=false to
// PAUSE it during development — nothing is loaded or saved, and no customer is recalled, so the
// lead flow runs fresh on every conversation (handy when testing repeatedly from one account).
const MEMORY_ON = !/^(false|0|off|no)$/i.test((process.env.MEMORY_ENABLED ?? "").trim());

// Build a Business Suite inbox deep-link to a customer's conversation, so the lead team can
// click straight into the chat. `selected_item_id` is the customer's PSID (the webhook
// senderId). Returns null when the page/business ids aren't configured.
function inboxUrl(senderId) {
  if (!FB_BUSINESS_ID || !FB_PAGE_ID) return null;
  const params = new URLSearchParams({
    business_id: FB_BUSINESS_ID,
    asset_id: FB_PAGE_ID,
    selected_item_id: senderId,
  });
  return `https://business.facebook.com/latest/inbox/all/?${params}`;
}

// The lead-capture instruction (when/how to ask + use the tool) and the proactive-ask turn
// threshold are admin-editable — see lead_capture.js. They're loaded in loadFromKb() below.

// The tool the model calls once it has the customer's name + phone. The phone is re-validated
// in code (normalizePhone) before we treat the lead as captured, so bad numbers can't slip in.
const SAVE_LEAD_TOOL = {
  functionDeclarations: [
    {
      name: "save_lead",
      description:
        "Save a customer's contact details so a human representative can follow up. Call this ONLY " +
        "after the customer has provided BOTH their name and their Bangladeshi mobile number in the " +
        "conversation. Never invent or guess these values.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING, description: "The customer's name, exactly as they gave it." },
          phone: { type: Type.STRING, description: "The customer's Bangladeshi mobile number, e.g. 01712345678." },
        },
        required: ["name", "phone"],
      },
    },
  ],
};

// Fallback strings for moments the AI is NOT in the loop (non-text content, an API failure) or
// returns nothing. These can't be model-generated, so they live here as small constants.
const FALLBACK_NON_TEXT = "অনুগ্রহ করে আপনার প্রশ্নটি লিখে পাঠান, আমরা সাহায্য করতে পেরে আনন্দিত হবো।";
const FALLBACK_EMPTY = "দুঃখিত, একটি সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।";
const FALLBACK_ERROR = "দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।";
const FALLBACK_FOLLOWUP =
  "আপনি কি আরও কিছু জানতে চান? 😊 De Jure Academy সম্পর্কে যেকোনো প্রশ্ন থাকলে নির্দ্বিধায় জিজ্ঞাসা করুন।";
const FALLBACK_LEAD_THANKS = "ধন্যবাদ! আমাদের প্রতিনিধি খুব শীঘ্রই আপনার সাথে যোগাযোগ করবেন। 😊";
const FALLBACK_LEAD_RETRY =
  "নম্বরটি ঠিক বুঝতে পারিনি। অনুগ্রহ করে ১১ সংখ্যার সঠিক মোবাইল নম্বরটি দিন (যেমন: 01712345678)।";

// The AI system prompt + the lead-capture trigger threshold, all assembled from editable files.
// `let` so the admin panel can hot-reload them without a restart.
let systemPrompt;
let leadAskAfterTurns;

// Rebuild the prompt (knowledge base + system prompt + scenarios + lead-capture instruction)
// and the lead trigger threshold from their files.
function loadFromKb() {
  const kb = loadKb();
  const lead = loadLeadCapture();
  systemPrompt =
    buildSystemPrompt(kb, loadSystemPrompt(), loadPromptSections(), loadAnsweringRules()) +
    (LEADS_ON ? `\n\n=== LEAD CAPTURE ===\n${lead.instruction}` : "");
  leadAskAfterTurns = lead.askAfterTurns;
}
loadFromKb();

// Called after an admin saves an edit, so new replies use the new data immediately.
function reloadKb() {
  loadFromKb();
  console.log("Knowledge base reloaded from admin edit.");
}

const genai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// --- In-memory conversation memory (per Facebook sender) ---
// Lets the bot follow up naturally ("which course?" -> "the second one").
// Note: this lives in process memory, so it resets if the server restarts.
const SESSION_TTL_MS = 30 * 60 * 1000; // forget a conversation after 30 min idle
const MAX_HISTORY = 10; // keep the last 10 messages (~5 exchanges) per customer
// Load any persisted state so a restart/redeploy resumes active chats, pending follow-ups,
// and the roster of customers we've already captured (see store.js).
//   sessions:  senderId -> { history, lastActive, lead, followUpTimer, followUpSent, returning, customerName }
//   customers: senderId -> { name, phone, captured, firstSeen, lastSeen }  (captured leads, kept long-term)
const { sessions, customers } = MEMORY_ON
  ? store.load()
  : { sessions: new Map(), customers: new Map() };

// Re-engagement: if a customer goes quiet after chatting, send ONE follow-up nudge after
// this delay. Configurable via .env (minutes); defaults to 120 (2h). Set 0 to disable.
// Keep it under 24h — Meta only allows a plain text reply inside the 24-hour messaging window.
const FOLLOWUP_DELAY_MINUTES = Number.parseInt(process.env.FOLLOWUP_DELAY_MINUTES ?? "", 10);
const FOLLOWUP_DELAY_MS =
  Number.isFinite(FOLLOWUP_DELAY_MINUTES) && FOLLOWUP_DELAY_MINUTES >= 0
    ? FOLLOWUP_DELAY_MINUTES * 60 * 1000
    : 120 * 60 * 1000;

// Human-feel reply pacing: instead of replying instantly, the bot keeps the typing bubble up
// for a randomized pause before sending. Configurable via .env (seconds); defaults to 5–10s.
function secEnv(name, def) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}
const REPLY_MIN_MS = secEnv("REPLY_MIN_SECONDS", 5) * 1000;
const REPLY_MAX_MS = Math.max(secEnv("REPLY_MAX_SECONDS", 10) * 1000, REPLY_MIN_MS);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randBetween = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Send a reply the way a person would: show the typing bubble, pause a randomized beat, then
// send. `headStartMs` discounts time already spent (e.g. waiting on Gemini) so the *total*
// feels like the configured 5–10s rather than that plus the model's latency. Pass an explicit
// {minMs,maxMs} for a quicker beat on a follow-on bubble.
async function humanSend(senderId, text, { headStartMs = 0, minMs = REPLY_MIN_MS, maxMs = REPLY_MAX_MS } = {}) {
  await sendAction(senderId, "typing_on");
  const wait = randBetween(minMs, maxMs) - headStartMs;
  if (wait > 0) await sleep(wait);
  await sendMessage(senderId, text);
}

// Fresh per-conversation lead state. The model drives capture via the save_lead tool; we track
// whether we've captured this person, whether we've already done the proactive contact ask, and
// how many Q&A turns they've had (to trigger that ask).
function freshLead() {
  return { captured: false, name: null, asked: false, msgCount: 0 };
}

function getSession(senderId) {
  const now = Date.now();
  const existing = sessions.get(senderId);
  if (!existing || now - existing.lastActive > SESSION_TTL_MS) {
    // Returning after the idle window starts a brand-new conversation; cancel any
    // follow-up still pending from the old one so a stale nudge can't fire.
    if (existing?.followUpTimer) clearTimeout(existing.followUpTimer);

    const lead = freshLead();
    // Recall: if we've captured this person before, carry their details forward so we
    // greet them by name and never ask for name/phone again.
    // When memory is paused, never recall a captured customer — every chat starts fresh.
    const known = MEMORY_ON ? customers.get(senderId) : null;
    if (known) {
      lead.name = known.name ?? null;
      lead.captured = true;
      lead.asked = true;
    }

    const fresh = {
      history: [],
      lastActive: now,
      lead,
      followUpTimer: null,
      followUpSent: false,
      returning: Boolean(known),
      customerName: known?.name ?? null,
    };
    sessions.set(senderId, fresh);
    store.markDirty();
    return fresh;
  }
  existing.lastActive = now;
  return existing;
}

// Outside Meta's 24-hour messaging window a plain-text nudge would be rejected, so we never
// (re)schedule a follow-up once a conversation has been silent this long.
const FOLLOWUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Periodically drop idle conversations so memory stays bounded. Keep any session whose
// follow-up nudge is still pending — it lives longer than the 30-min idle window.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.lastActive > SESSION_TTL_MS && !s.followUpTimer) {
      sessions.delete(id);
      store.markDirty();
    }
  }
}, SESSION_TTL_MS).unref();

// Snapshot state to disk periodically (writes only when something changed since last flush),
// and once more on shutdown so a redeploy/stop doesn't lose the last few seconds of state.
// Skipped entirely when memory is paused (nothing should touch disk).
const PERSIST_INTERVAL_MS = 10 * 1000;
if (MEMORY_ON) setInterval(() => store.flush(sessions, customers), PERSIST_INTERVAL_MS).unref();
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (MEMORY_ON) store.flush(sessions, customers, { force: true });
    process.exit(0);
  });
}

// Arm the follow-up timer to fire after `delay` ms of continued silence.
function armFollowUp(senderId, session, delay) {
  session.followUpTimer = setTimeout(() => {
    session.followUpTimer = null;
    if (session.lead.captured) return; // already have their details — no nudge needed
    session.followUpSent = true;
    // Refresh the idle window so a reply to the nudge keeps its conversation context.
    session.lastActive = Date.now();
    store.markDirty();
    sendFollowUp(senderId, session).catch((err) =>
      console.error("Follow-up send failed:", err)
    );
  }, delay);
  session.followUpTimer.unref?.();
}

// (Re)start the silence timer for a conversation. Called on every incoming message, so the
// clock resets while the customer is active and only fires after real silence.
function scheduleFollowUp(senderId, session) {
  if (FOLLOWUP_DELAY_MS <= 0) return; // disabled via FOLLOWUP_DELAY_MINUTES=0
  if (session.followUpTimer) clearTimeout(session.followUpTimer);
  if (session.followUpSent) return; // at most one nudge per conversation
  armFollowUp(senderId, session, FOLLOWUP_DELAY_MS);
}

// On boot, re-arm follow-ups for restored sessions (and drop expired ones the periodic
// cleanup would have removed). Timers don't survive a restart, so we recompute the
// remaining wait from each session's lastActive.
function restoreSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    const pending =
      FOLLOWUP_DELAY_MS > 0 &&
      !s.followUpSent &&
      !s.lead?.captured &&
      now - s.lastActive < FOLLOWUP_MAX_AGE_MS;

    if (now - s.lastActive > SESSION_TTL_MS && !pending) {
      sessions.delete(id);
      continue;
    }
    if (pending) {
      const remaining = FOLLOWUP_DELAY_MS - (now - s.lastActive);
      armFollowUp(id, s, remaining > 0 ? remaining : 1000); // overdue while down -> fire shortly
    }
  }
}

// The one-off re-engagement nudge sent after a stretch of silence.
async function sendFollowUp(senderId, _session) {
  await sendMessage(senderId, FALLBACK_FOLLOWUP);
}

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
// Mounted at the root so it loads at http://localhost:PORT directly.
app.use(
  "/",
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

// Liveness check. The admin panel now owns "/", so the bot's "running" probe lives here.
app.get("/health", (_req, res) => res.send("De Jure Academy bot is running."));

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  const message = event.message;

  if (!senderId || !message) return;
  if (message.is_echo) return; // our own outgoing messages echoed back

  if (!message.text) {
    // Non-text (sticker, image, etc.) — polite fallback.
    await sendMessage(senderId, FALLBACK_NON_TEXT);
    return;
  }

  const session = getSession(senderId);

  // They just messaged, so reset the 2-hour silence clock (covers both paths below).
  scheduleFollowUp(senderId, session);

  // A brief "reading" beat before the read receipt, so we don't mark seen the instant the
  // message lands (which feels robotic).
  await sleep(randBetween(800, 2500));
  await sendAction(senderId, "mark_seen");

  // Show the typing bubble while Gemini thinks, then keep it up for the rest of a human-like
  // pause before sending (the model's latency counts toward that pause, not on top of it).
  await sendAction(senderId, "typing_on");
  const start = Date.now();

  // After enough back-and-forth, proactively offer a callback and ask for the customer's name +
  // phone — unless we've already asked or already captured them. The model also asks on its own
  // when it senses clear intent; this turn-count rule is the deterministic backstop.
  session.lead.msgCount += 1;
  const askContact =
    LEADS_ON && !session.lead.captured && !session.lead.asked && session.lead.msgCount >= leadAskAfterTurns;
  if (askContact) session.lead.asked = true;

  const { text, lead } = await askGemini(session, message.text, { askContact });
  await humanSend(senderId, text, { headStartMs: Date.now() - start });

  // The model called save_lead this turn with a valid name + phone — persist and push it once.
  if (LEADS_ON && lead && !session.lead.captured) {
    await captureLead(senderId, session, lead);
  }

  store.markDirty(); // history and/or lead state changed this turn
}

// Persist a captured lead (name + already-validated phone) and push it to the sinks. Runs at
// most once per conversation; the customer-facing confirmation is the model's own reply.
async function captureLead(senderId, session, { name, phone }) {
  session.lead.captured = true;
  session.lead.name = name;

  // Remember this customer long-term so we recognize them on their next visit.
  const now = Date.now();
  const prev = customers.get(senderId);
  customers.set(senderId, {
    name,
    phone,
    captured: true,
    firstSeen: prev?.firstSeen ?? now,
    lastSeen: now,
  });
  session.returning = true;
  session.customerName = name;
  store.markDirty();

  await saveLead({
    name,
    phone,
    senderId,
    time: new Date().toISOString(),
    source: "messenger",
    conversationUrl: inboxUrl(senderId), // null when FB_BUSINESS_ID/FB_PAGE_ID unset
  });
}

// Normalise a Bangladeshi mobile number to 11-digit `01XXXXXXXXX`, or null if invalid.
// Accepts Bengali digits, +880/880 country codes, and spaces/dashes.
function normalizePhone(raw) {
  const bn = "০১২৩৪৫৬৭৮৯";
  let s = String(raw)
    .replace(/[০-৯]/g, (d) => bn.indexOf(d)) // Bengali -> ASCII digits
    .replace(/[^\d+]/g, "")
    .replace(/^\+/, "");
  if (s.startsWith("880")) s = "0" + s.slice(3);
  return /^01\d{9}$/.test(s) ? s : null;
}

async function askGemini(session, userText, { askContact = false } = {}) {
  const userTurn = { role: "user", parts: [{ text: userText }] };
  // Send prior turns + this new message so Gemini has the conversation context.
  const contents = [...session.history, userTurn];

  // Build this call's system instruction: the base prompt plus an optional per-call note.
  let instruction = systemPrompt;
  if (session.returning && session.customerName) {
    // Returning, already-captured customer: greet by name, never ask for contact again.
    instruction += `\n\n=== RETURNING CUSTOMER ===\nThis customer has contacted us before; their name is ${session.customerName}, and we already have their contact details. You may warmly address them by name when it feels natural, you must NOT ask for their name or phone number again, and you must NOT call save_lead for them.`;
  } else if (askContact) {
    // Deterministic nudge: time to collect contact details (wording comes from the editable
    // lead-capture instruction already in the prompt above).
    instruction += `\n\n=== ASK FOR CONTACT THIS TURN ===\nThe customer has engaged enough. After answering their message — and only if you have not already asked earlier in this conversation — follow the lead-capture guidance above: proactively offer a representative callback and ask them to send their name and mobile number together in one message. Do not call save_lead until they actually provide both.`;
  }

  const config = { systemInstruction: instruction, maxOutputTokens: 1024 };
  // Offer the save_lead tool only while we still need this customer's details.
  if (LEADS_ON && !session.lead.captured) config.tools = [SAVE_LEAD_TOOL];

  // Commit the user turn + final reply to memory, then trim oldest pairs to the cap.
  const remember = (text) => {
    session.history.push(userTurn, { role: "model", parts: [{ text }] });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }
  };

  try {
    const response = await genai.models.generateContent({ model: MODEL, contents, config });

    // Did the model decide to capture a lead this turn?
    const call = (response.functionCalls ?? []).find((c) => c.name === "save_lead");
    if (call) {
      const name = String(call.args?.name ?? "").trim();
      const phone = normalizePhone(call.args?.phone ?? "");
      const valid = name.length >= 2 && Boolean(phone);

      // Feed the tool result back (without the tool, so it must reply in text) and let the model
      // write a natural reply: a thank-you when saved, or a re-ask when the number was invalid.
      const modelParts = response.candidates?.[0]?.content?.parts ?? [{ functionCall: call }];
      const toolTurn = {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "save_lead",
              response: valid
                ? { status: "ok", note: "Saved. A representative will follow up shortly." }
                : { status: "invalid_phone", note: "Not a valid Bangladeshi mobile number — ask the customer to resend it." },
            },
          },
        ],
      };
      const followUp = await genai.models.generateContent({
        model: MODEL,
        contents: [...contents, { role: "model", parts: modelParts }, toolTurn],
        config: { systemInstruction: instruction, maxOutputTokens: 1024 },
      });
      const text = followUp.text?.trim() || (valid ? FALLBACK_LEAD_THANKS : FALLBACK_LEAD_RETRY);
      remember(text);
      return { text, lead: valid ? { name, phone } : null };
    }

    const text = response.text?.trim() || FALLBACK_EMPTY;
    remember(text);
    return { text, lead: null };
  } catch (err) {
    console.error("Gemini API error:", err);
    // Don't store failed turns, so a transient error doesn't pollute history.
    return { text: FALLBACK_ERROR, lead: null };
  }
}

// Send a sender action (mark_seen / typing_on / typing_off) to the Messenger user.
async function sendAction(recipientId, action) {
  try {
    const res = await fetch(`${GRAPH_API}/me/messages?access_token=${PAGE_ACCESS_TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        sender_action: action,
      }),
    });
    if (!res.ok) {
      console.error("Sender action error:", action, res.status, await res.text());
    }
  } catch (err) {
    console.error("Sender action request failed:", err);
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

// Re-arm any follow-ups and prune expired sessions restored from disk before we start serving.
restoreSessions();

app.listen(PORT, () => {
  console.log(`De Jure Academy bot listening on http://localhost:${PORT}`);
  console.log(`Lead capture: ${LEADS_ON ? "enabled" : "disabled (no sheet/Telegram configured)"}`);
  console.log(
    `Follow-up nudge: ${
      FOLLOWUP_DELAY_MS > 0 ? `after ${FOLLOWUP_DELAY_MS / 60000} min of silence` : "disabled"
    }`
  );
  console.log(
    `Memory: ${
      MEMORY_ON
        ? `on — ${sessions.size} session(s) restored, ${customers.size} known customer(s)`
        : "PAUSED — no persistence, no customer recall (every chat starts fresh)"
    }.`
  );
});
