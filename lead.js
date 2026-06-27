// Lead capture sinks: append to a Google Sheet (via an Apps Script web app) and
// notify the team's WhatsApp group (via CallMeBot). Both are optional and independent —
// whatever is configured in .env runs; the rest is skipped.
//
// Env vars are read at call time (not import time) because dotenv.config() in server.js
// runs after this module is imported.

export function isLeadConfigured() {
  const e = process.env;
  return Boolean(e.GOOGLE_SHEET_WEBAPP_URL || (e.CALLMEBOT_PHONE && e.CALLMEBOT_APIKEY));
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

// Post a notification to the WhatsApp group via CallMeBot.
async function notifyWhatsApp(lead) {
  const phone = process.env.CALLMEBOT_PHONE;
  const apikey = process.env.CALLMEBOT_APIKEY;
  if (!phone || !apikey) return;

  const text =
    `🆕 New lead from Messenger\n` +
    `Name: ${lead.name}\n` +
    `Phone: ${lead.phone}\n` +
    `Time: ${lead.time}`;

  const url =
    `https://api.callmebot.com/whatsapp.php?phone=${encodeURIComponent(phone)}` +
    `&text=${encodeURIComponent(text)}&apikey=${encodeURIComponent(apikey)}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`CallMeBot responded ${res.status}: ${await res.text()}`);
  }
}

// Save a lead to every configured sink. Sinks run independently — one failing
// doesn't block the other, and neither throws to the caller (the customer is
// thanked regardless; failures are logged for follow-up).
export async function saveLead(lead) {
  const results = await Promise.allSettled([saveToSheet(lead), notifyWhatsApp(lead)]);
  const labels = ["Google Sheet", "WhatsApp"];
  results.forEach((r, i) => {
    if (r.status === "rejected") console.error(`Lead -> ${labels[i]} failed:`, r.reason);
  });
  return results.some((r) => r.status === "fulfilled");
}
