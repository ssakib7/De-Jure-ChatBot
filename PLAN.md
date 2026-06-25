# Plan: Facebook Messenger AI Auto-Reply Bot for De Jure Academy

## Context
Building (for the user's brother) an automation so that when a customer messages the
**De Jure Academy** Facebook Page ("De Jure Academy", Page ID `100877505836688`), an AI
replies to their queries. The business is a Bangladesh law-education platform (founded 2021,
Dhaka) preparing students for **BJS (Judicial Service)** and **Bar Council** exams.

We chose a **custom build** (no-code tools rejected) handling **FAQ / general queries**.
Meta App is already created (App ID `1691917822067872`); the user has the App Secret and a
Page Access Token. Knowledge comes from a **static `knowledge_base.md` snapshot** generated from
the site's public API. The bot **replies in the same language the customer writes** (Bengali or English).

This plan covers: (1) the knowledge base file ✅ done, (2) scaffolding the webhook + Claude
bot, (3) wiring credentials, and (4) end-to-end local testing via ngrok.

## Project location
Standalone project at `e:\dejure-fb-bot\` (separate from the Stockdrifts monorepo — it's a
favor for the brother's separate business).

## Tech stack
- **Node.js + Express** — webhook server (simplest, well-documented for Messenger Platform).
- **@anthropic-ai/sdk** — call Claude for replies. Model: **`claude-haiku-4-5`** (fast + cheap,
  ideal for short FAQ replies; ~fraction of a cent per message). Read the `claude-api` skill
  before writing the SDK call to confirm current model id + Messages API shape.
- **dotenv** — load credentials from `.env`.
- **ngrok** — expose local server over public HTTPS for Meta's webhook during testing.

## Files

### 1. `knowledge_base.md` — the AI's source of truth ✅ DONE
Generated from `api.dejureacademy.com/api/v1/{courses,products,about,socials}`.
Contains: about/mission/vision/core-values, all 11 active courses (BJS + Bar Council) with
online/offline/both prices + durations + start dates, books/products, and answering rules.
User must still fill the `TODO` contact + enroll/pay fields before going live.

### 2. `server.js` — webhook + AI logic
- `GET /webhook` — verification handshake: compares `hub.verify_token` against `VERIFY_TOKEN`
  env and echoes `hub.challenge`.
- `POST /webhook` — receives message events. Validate the `X-Hub-Signature-256` header against
  `APP_SECRET` (security). For each messaging entry with `message.text`:
  1. call `askClaude(text)` → Messages API request with a system prompt =
     (answering rules) + the full `knowledge_base.md` contents loaded at startup.
  2. send the reply via the Send API:
     `POST https://graph.facebook.com/v21.0/me/messages?access_token=PAGE_ACCESS_TOKEN`
     body `{ recipient:{id:senderId}, message:{text: reply} }`.
- Respond `200 EVENT_RECEIVED` quickly; do Claude/Send work without blocking the 200 (Meta
  retries if not answered in time).
- Ignore echoes (`message.is_echo`) and non-text messages (polite "please type your question" fallback).

### 3. `.env.example` + `.env` (gitignored)
```
PAGE_ACCESS_TOKEN=
APP_SECRET=
VERIFY_TOKEN=dejure_bot_2026   # any random string; same value goes in Meta dashboard
ANTHROPIC_API_KEY=
PORT=3000
```

### 4. `package.json`
deps: `express`, `@anthropic-ai/sdk`, `dotenv`. Script: `"start": "node server.js"`.
`.gitignore`: `node_modules`, `.env`.

### 5. `README.md`
Setup + run steps, exact Meta dashboard values to paste (callback URL + verify token),
plus the "Add Subscriptions → messages" reminder.

## Build & test sequence (end-to-end verification)
1. `npm install` in `e:\dejure-fb-bot\`.
2. Fill `.env` with the 4 secrets (App Secret, Page Access Token, a chosen Verify Token, Anthropic key).
3. `npm start` → server on `http://localhost:3000`.
4. `ngrok http 3000` → copy the public `https://...ngrok...` URL.
5. **Meta dashboard → Messenger API Setup → 1. Configure webhooks**:
   - Callback URL = `https://<ngrok>/webhook`
   - Verify token = same `VERIFY_TOKEN` value
   - Click **Verify and save** (server's `GET /webhook` must echo the challenge → success).
6. **2. Generate access tokens → Add Subscriptions** → check **`messages`** (+ `messaging_postbacks`).
7. **Test:** from a Facebook account that is admin/tester of the app, message the De Jure Academy
   page → bot should reply in the matching language with info from `knowledge_base.md`.
   Watch the server console logs to debug.
8. Validate the Page Access Token first (sanity check):
   `curl.exe "https://graph.facebook.com/v21.0/me?access_token=<token>"` → returns the page name/id.

## Notes / follow-ups (not in this build)
- **Going public:** messaging users beyond admins/testers requires Meta **App Review** for
  `pages_messaging` (a few days). Build/test works now without it.
- **Production hosting:** later, deploy to Railway/Render/Vercel and swap the ngrok URL for the
  permanent host URL in the webhook settings.
- **Contact info:** fill the `TODO` fields in `knowledge_base.md` before going live.
- **Refreshing prices:** static snapshot — regenerate `knowledge_base.md` when courses/prices
  change (the API extraction commands are reusable).
