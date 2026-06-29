// Lead capture sinks: append to a Google Sheet (via an Apps Script web app) and
// notify the team's Telegram chat (via the Telegram Bot API). Both are optional and
// independent — whatever is configured in .env runs; the rest is skipped.
//
// Env vars are read at call time (not import time) because dotenv.config() in server.js
// runs after this module is imported.

export function isLeadConfigured() {
  const e = process.env;
  return Boolean(e.GOOGLE_SHEET_WEBAPP_URL || (e.TELEGRAM_BOT_TOKEN && e.TELEGRAM_CHAT_ID));
}

// Append a row to the Google Sheet through the deployed Apps Script web app.
async function saveToSheet(lead) {
  const url = process.env.GOOGLE_SHEET_WEBAPP_URL;
  if (!url) return;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: process.env.SHEET_SHARED_TOKEN ?? "", ...lead }),
  });
  if (!res.ok) {
    throw new Error(`Sheet web app responded ${res.status}: ${await res.text()}`);
  }
}

// Post a notification to the team's Telegram chat via the Telegram Bot API.
async function notifyTelegram(lead) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;

  const text =
    `🆕 New lead from Messenger\n` +
    `Name: ${lead.name}\n` +
    `Phone: ${lead.phone}\n` +
    `Time: ${lead.time}`;

  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) {
    throw new Error(`Telegram responded ${res.status}: ${await res.text()}`);
  }
}

// Save a lead to every configured sink. Sinks run independently — one failing
// doesn't block the other, and neither throws to the caller (the customer is
// thanked regardless; failures are logged for follow-up).
export async function saveLead(lead) {
  const results = await Promise.allSettled([saveToSheet(lead), notifyTelegram(lead)]);
  const labels = ["Google Sheet", "Telegram"];
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`Lead -> ${labels[i]} failed:`, r.reason);
  });
  return results.some((r) => r.status === "fulfilled");
}
