# De Jure Academy — Messenger AI Auto-Reply Bot

A small Node.js webhook that auto-replies to messages sent to the **De Jure Academy**
Facebook Page using Google Gemini. It answers FAQ / general queries (courses, prices, durations,
start dates, books, enrollment) from a static `knowledge_base.md` snapshot, and **always
replies in Bengali** (even when the customer writes in English).

- **Meta App ID:** `1749419626508651`
- **Page ID:** `100877505836688`
- **Model:** `gemini-3.1-flash-lite` (fast + cheap, ideal for short FAQ replies)

## Files
- `server.js` — Express webhook + Gemini reply logic + Messenger Send API.
- `knowledge_base.md` — the AI's source of truth (regenerate when courses/prices change).
- `.env` — your secrets (gitignored). Copy from `.env.example`.

## Setup

1. **Install dependencies**
   ```sh
   npm install
   ```

2. **Create your `.env`** — copy the example and fill in the four secrets:
   ```sh
   cp .env.example .env
   ```
   | Var | Where to get it |
   |---|---|
   | `PAGE_ACCESS_TOKEN` | Meta dashboard → Messenger API Setup → Generate access tokens |
   | `APP_SECRET` | App Settings → Basic → App Secret |
   | `VERIFY_TOKEN` | Any random string you choose (keep the default or change it) |
   | `GEMINI_API_KEY` | https://aistudio.google.com/app/apikey |

3. **Validate the Page Access Token** (sanity check — should print the page name/id):
   ```sh
   curl.exe "https://graph.facebook.com/v21.0/me?access_token=<PAGE_ACCESS_TOKEN>"
   ```

4. **Fill the `TODO` fields** in `knowledge_base.md` (phone/WhatsApp, email, address,
   office hours, enroll/pay process) before going live.

## Run locally + connect the webhook

1. **Start the server**
   ```sh
   npm start
   ```
   → `De Jure Academy bot listening on http://localhost:3000`

2. **Expose it over HTTPS** with ngrok (in a second terminal):
   ```sh
   ngrok http 3000
   ```
   Copy the public `https://<something>.ngrok-free.app` URL.

3. **Meta dashboard → Messenger API Setup → 1. Configure webhooks:**
   - **Callback URL:** `https://<ngrok>/webhook`
   - **Verify token:** the same value as `VERIFY_TOKEN` in your `.env`
   - Click **Verify and save** (the server's `GET /webhook` echoes the challenge → success).

4. **2. Generate access tokens → Add Subscriptions** → check **`messages`**
   (and `messaging_postbacks`).

5. **Test:** from a Facebook account that is an **admin/tester** of the app, message the
   De Jure Academy Page. The bot should reply in the matching language using the knowledge
   base. Watch the server console for logs.

## Notes / follow-ups
- **Going public:** messaging users beyond admins/testers requires Meta **App Review** for
  `pages_messaging` (takes a few days). Build/test works now without it.
- **Production hosting:** later, deploy to Railway/Render/Vercel and swap the ngrok URL for
  the permanent host URL in the webhook settings.
- **Refreshing prices:** `knowledge_base.md` is a static snapshot — regenerate it from the
  site API when courses or prices change.
