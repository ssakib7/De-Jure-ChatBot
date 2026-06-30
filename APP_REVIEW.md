# App Review submission — `pages_messaging` (De Jure Academy bot / "SOJAG AI" app)

Copy-paste material for: **Use cases → Messenger from Meta → Permissions and features →
`pages_messaging` → Request Advanced Access → App Review**.

Prerequisites before submitting:
- ✅ Privacy Policy URL set: `https://bot.dejureacademy.net/privacy`
- ⏳ Business Verification completed
- ⏳ Bot deployed and live at `https://bot.dejureacademy.net/webhook` (reviewers will test it)
- A **test Facebook account** is **not** required — reviewers message the public Page directly,
  but make sure the Page is published and the bot is running.

---

## 1. Permission justification — `pages_messaging`
*(Paste into the "Tell us how you'll use this permission" box.)*

> De Jure Academy is a law-education institution in Dhaka, Bangladesh that prepares students for
> the Bangladesh Judicial Service (BJS) and Bar Council exams. We use the `pages_messaging`
> permission to power an automated assistant on our official Facebook Page that replies to
> prospective students who message us.
>
> When a person sends a message to our Page, our server receives the `messages` webhook event and
> sends an automated reply **within the standard 24-hour messaging window**. The assistant answers
> frequently asked questions about our courses, prices, class schedules, study books, and how to
> enroll, using a curated knowledge base. If the person expresses interest in enrolling, the
> assistant asks whether they would like a representative to contact them and, only with their
> consent, collects their name and phone number for follow-up.
>
> We do not send promotional or broadcast messages, and we do not message people who have not
> messaged us first. All replies are sent in direct response to a user-initiated conversation.
> `pages_messaging` is required to receive these inbound messages and send the corresponding replies.

---

## 2. Step-by-step instructions for the reviewer
*(Paste into the "Provide step-by-step instructions" box.)*

> 1. Open Facebook Messenger and go to the **De Jure Academy** Page
>    (Page ID `100877505836688`), or visit `m.me/dejureacademy`.
> 2. Send a message asking a question in English or Bengali, for example:
>    *"What courses do you offer?"* or *"BJS course er price koto?"*
> 3. Within a few seconds the automated assistant replies in Bengali with information about our
>    courses and prices, drawn from our knowledge base.
> 4. Continue the conversation, e.g. *"I want to enroll"* — the assistant will offer to have a
>    representative contact you and ask for your name and mobile number (sharing them is optional).
> 5. The reply is sent using `pages_messaging` within the 24-hour standard messaging window.

---

## 3. Screencast — what to record
A short (30–90s) screen recording, required by App Review. Show the full round-trip:

1. Start on the **De Jure Academy** Page in Messenger.
2. Type and send: **"What courses do you offer?"**
3. Show the bot's Bengali reply arriving.
4. Send a follow-up: **"আমি ভর্তি হতে চাই"** ("I want to enroll").
5. Show the bot offering follow-up and asking for name + number.
6. (Optional) Briefly show the server log / Business Suite inbox to demonstrate it's a real reply.

Keep the App ID/permission visible at the start if recording from the dashboard. Upload the file
in the App Review submission.

---

## 4. Notes
- **Scope requested:** Advanced Access for `pages_messaging` only. We do **not** need
  `pages_messaging_subscriptions` (that is for promotional/broadcast messages outside 24h, which
  this bot does not send).
- **Data handling** is described in the privacy policy at `https://bot.dejureacademy.net/privacy`
  (covers Messenger data, Google Gemini processing, and consent-based lead capture).
- Make sure the Page is **published** and the bot is **running** at submission time, or the
  reviewer's test message will go unanswered and the review will be rejected.
