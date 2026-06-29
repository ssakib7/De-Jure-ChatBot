import crypto from "node:crypto";

import express from "express";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";

import { loadKb, buildSystemPrompt } from "./kb.js";
import { createAdminRouter } from "./admin.js";
import { isLeadConfigured, saveLead } from "./lead.js";
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

const LEADS_ON = isLeadConfigured();

// Appended to the prompt only when lead capture is configured: lets Gemini flag, with a
// hidden marker, the moments a human follow-up makes sense (enroll / payment / wants a person).
const LEAD_MARKER = "[[LEAD]]";
const LEAD_INSTRUCTION = `

=== LEAD CAPTURE ===
If the customer clearly wants to enroll, asks how to pay/admit, or asks to talk to a person — and you \
cannot fully complete that for them from the knowledge base — append a final line containing EXACTLY \
${LEAD_MARKER} and nothing else. Still answer their question warmly above that line. Never mention or \
explain this marker to the customer, and never use it more than once in a conversation.`;

// Engagement fallback: if the customer never trips intent detection but keeps chatting,
// offer a callback anyway once they've sent this many messages (still only once per chat).
// Configurable via .env; defaults to 3 if unset or invalid.
const LEAD_MSG_THRESHOLD = Number.parseInt(process.env.LEAD_MSG_THRESHOLD, 10) || 3;

// Build the AI's system prompt from the knowledge base. `let` so the admin panel can hot-reload it.
function buildPrompt() {
  return buildSystemPrompt(loadKb()) + (LEADS_ON ? LEAD_INSTRUCTION : "");
}
let systemPrompt = buildPrompt();

// Re-read knowledge_base.json and rebuild the prompt — called after an admin saves an edit,
// so new replies use the new data without restarting the bot.
function reloadKb() {
  systemPrompt = buildPrompt();
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
const { sessions, customers } = store.load();

// Re-engagement: if a customer goes quiet after chatting, send ONE follow-up nudge after
// this delay. Configurable via .env (minutes); defaults to 120 (2h). Set 0 to disable.
// Keep it under 24h — Meta only allows a plain text reply inside the 24-hour messaging window.
const FOLLOWUP_DELAY_MINUTES = Number.parseInt(process.env.FOLLOWUP_DELAY_MINUTES ?? "", 10);
const FOLLOWUP_DELAY_MS =
  Number.isFinite(FOLLOWUP_DELAY_MINUTES) && FOLLOWUP_DELAY_MINUTES >= 0
    ? FOLLOWUP_DELAY_MINUTES * 60 * 1000
    : 120 * 60 * 1000;

// Fresh per-conversation lead state. `stage` drives the capture flow:
//   null -> not collecting · "name" -> waiting for name · "phone" -> waiting for phone.
function freshLead() {
  return { stage: null, name: null, asked: false, captured: false, msgCount: 0 };
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
    const known = customers.get(senderId);
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
const PERSIST_INTERVAL_MS = 10 * 1000;
setInterval(() => store.flush(sessions, customers), PERSIST_INTERVAL_MS).unref();
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    store.flush(sessions, customers, { force: true });
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

// The one-off re-engagement message. Tailored if we were mid lead-capture when they went quiet.
async function sendFollowUp(senderId, session) {
  if (LEADS_ON && session.lead.stage) {
    await sendMessage(
      senderId,
      "আপনি কি এখনও আগ্রহী? 😊 আপনার নাম ও মোবাইল নম্বরটি দিলে আমাদের একজন প্রতিনিধি আপনার সাথে যোগাযোগ করবেন।"
    );
    return;
  }
  await sendMessage(
    senderId,
    "আপনি কি আরও কিছু জানতে চান? 😊 De Jure Academy সম্পর্কে যেকোনো প্রশ্ন থাকলে নির্দ্বিধায় জিজ্ঞাসা করুন।"
  );
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

  const session = getSession(senderId);
  await sendAction(senderId, "mark_seen");

  // They just messaged, so reset the 2-hour silence clock (covers both paths below).
  scheduleFollowUp(senderId, session);

  // If we're mid lead-capture, this message is the customer's name or phone — handle it
  // directly and skip the AI for this turn.
  if (LEADS_ON && session.lead.stage) {
    await handleLeadCapture(senderId, session, message.text);
    return;
  }

  // Show the typing bubble while Gemini thinks; it clears when we send the reply.
  await sendAction(senderId, "typing_on");
  const { text, wantsLead } = await askGemini(session, message.text);
  await sendMessage(senderId, text);

  // Count this Q&A turn (mid-capture turns return earlier, so they don't count here).
  session.lead.msgCount += 1;

  // Start collecting name + phone when Gemini flags buying/contact intent, OR — even
  // without intent — once the customer has stayed engaged for a few messages. Either way,
  // only once per conversation and never after a lead is already captured.
  const engagedEnough = session.lead.msgCount >= LEAD_MSG_THRESHOLD;
  if (LEADS_ON && (wantsLead || engagedEnough) && !session.lead.asked && !session.lead.captured) {
    session.lead.asked = true;
    session.lead.stage = "name";
    await sendMessage(
      senderId,
      "আপনি চাইলে আমাদের একজন প্রতিনিধি আপনার সাথে যোগাযোগ করে বিস্তারিত জানাতে পারেন। অনুগ্রহ করে আপনার নামটি লিখুন।"
    );
  }

  store.markDirty(); // history and/or lead state changed this turn
}

// Drive the deterministic name -> phone capture flow. Returns nothing; replies are sent here.
async function handleLeadCapture(senderId, session, text) {
  const lead = session.lead;
  const input = text.trim();
  store.markDirty(); // this turn mutates lead state regardless of branch

  // Let the customer back out at any point.
  if (/^(cancel|বাতিল|না|no)$/i.test(input)) {
    lead.stage = null;
    await sendMessage(senderId, "ঠিক আছে! আর কোনো প্রশ্ন থাকলে নির্দ্বিধায় জিজ্ঞাসা করুন।");
    return;
  }

  if (lead.stage === "name") {
    if (input.length < 2) {
      await sendMessage(senderId, "অনুগ্রহ করে আপনার নামটি লিখুন।");
      return;
    }
    lead.name = input;
    lead.stage = "phone";
    await sendMessage(senderId, "ধন্যবাদ! এবার আপনার মোবাইল নম্বরটি দিন (যেমন: 01XXXXXXXXX)।");
    return;
  }

  if (lead.stage === "phone") {
    const phone = normalizePhone(input);
    if (!phone) {
      await sendMessage(
        senderId,
        "নম্বরটি ঠিক বুঝতে পারিনি। অনুগ্রহ করে ১১ সংখ্যার মোবাইল নম্বর দিন (যেমন: 01712345678)।"
      );
      return;
    }
    lead.phone = phone;
    lead.stage = null;
    lead.captured = true;

    // Remember this customer long-term so we recognize them on their next visit.
    const now = Date.now();
    const prev = customers.get(senderId);
    customers.set(senderId, {
      name: lead.name,
      phone,
      captured: true,
      firstSeen: prev?.firstSeen ?? now,
      lastSeen: now,
    });
    session.returning = true;
    session.customerName = lead.name;
    store.markDirty();

    await saveLead({
      name: lead.name,
      phone,
      senderId,
      time: new Date().toISOString(),
      source: "messenger",
    });

    await sendMessage(
      senderId,
      "ধন্যবাদ! আমাদের প্রতিনিধি খুব শীঘ্রই আপনার সাথে যোগাযোগ করবেন। 😊"
    );
  }
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

async function askGemini(session, userText) {
  const userTurn = { role: "user", parts: [{ text: userText }] };
  // Send prior turns + this new message so Gemini has the conversation context.
  const contents = [...session.history, userTurn];

  // For a returning customer we already captured, add a per-call note so Gemini can address
  // them by name and knows not to ask for contact details again.
  const instruction =
    session.returning && session.customerName
      ? `${systemPrompt}\n\n=== RETURNING CUSTOMER ===\nThis customer has contacted us before; their name is ${session.customerName}, and we already have their contact details. You may warmly address them by name when it feels natural, and you must NOT ask for their name or phone number again.`
      : systemPrompt;

  try {
    const response = await genai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: instruction,
        maxOutputTokens: 1024,
      },
    });
    const raw =
      response.text?.trim() ||
      "দুঃখিত, একটি সমস্যা হয়েছে। অনুগ্রহ করে আবার চেষ্টা করুন।";

    // Gemini appends [[LEAD]] when it senses buying/contact intent. Detect it, then strip
    // it so the customer never sees the marker.
    const wantsLead = raw.includes(LEAD_MARKER);
    const text = raw.replaceAll(LEAD_MARKER, "").trim();

    // Commit the cleaned exchange to memory, then trim oldest pairs to the cap.
    session.history.push(userTurn, { role: "model", parts: [{ text }] });
    if (session.history.length > MAX_HISTORY) {
      session.history.splice(0, session.history.length - MAX_HISTORY);
    }
    return { text, wantsLead };
  } catch (err) {
    console.error("Gemini API error:", err);
    // Don't store failed turns, so a transient error doesn't pollute history.
    return {
      text: "দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।",
      wantsLead: false,
    };
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
  console.log(`Memory: ${sessions.size} session(s) restored, ${customers.size} known customer(s).`);
});
