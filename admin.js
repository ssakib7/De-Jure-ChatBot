// Admin web panel for editing the knowledge base.
// Mounted at /admin by server.js. Auth is a signed, httpOnly session cookie (no DB, no extra deps).
import crypto from "node:crypto";
import express from "express";

import { loadKb, saveKb } from "./kb.js";

const COOKIE_NAME = "dj_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// --- Cookie signing / verification (HMAC-SHA256 over a small JSON payload) ---

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

function signSession(secret, username) {
  const payload = b64url(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS }));
  return `${payload}.${hmac(secret, payload)}`;
}

// Returns the payload object if the cookie is valid and unexpired, else null.
function verifySession(secret, value) {
  if (!value || !value.includes(".")) return null;
  const [payload, sig] = value.split(".");
  const expected = hmac(secret, payload);
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

// CSRF token derived from the session cookie value — unguessable without the httpOnly cookie.
function csrfToken(secret, sessionValue) {
  return hmac(secret, sessionValue + ":csrf");
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Constant-time string equality that tolerates differing lengths.
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// --- HTML rendering ---

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

const PAGE_STYLE = `
  :root {
    --bg: #f6f6f4; --panel: #ffffff; --ink: #1a2233; --muted: #6a7184;
    --line: #e8e8e3; --line-strong: #d8d9d2;
    --accent: #1e3a5f; --accent-ink: #16304e; --gold: #b08423;
    --red: #b4452f; --ok: #2f6b46; --ok-bg: #eef4ee;
    --serif: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Times New Roman", serif;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Bengali", sans-serif;
    --radius: 8px;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans);
    font-size: 15px; line-height: 1.55; }
  a { color: var(--accent); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;
    background: #ecece7; padding: 1px 5px; border-radius: 4px; }

  /* Layout: fixed sidebar + content */
  .layout { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
  .sidebar { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
    background: #fbfbf9; border-right: 1px solid var(--line); padding: 22px 16px;
    display: flex; flex-direction: column; gap: 4px; }
  .brand { display: flex; align-items: center; gap: 11px; padding: 2px 6px 18px;
    border-bottom: 1px solid var(--line); margin-bottom: 16px; }
  .mark { width: 36px; height: 36px; flex: none; border-radius: 7px; background: var(--accent);
    color: #fff; display: grid; place-items: center; font-family: var(--serif); font-weight: 700;
    font-size: 15px; letter-spacing: .5px; }
  .brand-name { font-weight: 650; font-size: 14.5px; line-height: 1.15; }
  .brand-sub { font-size: 12px; color: var(--muted); }
  .nav { display: flex; flex-direction: column; gap: 1px; }
  .nav a { display: block; padding: 8px 11px; border-radius: 7px; color: var(--muted);
    text-decoration: none; font-size: 14px; font-weight: 500; }
  .nav a:hover { background: #f0efe9; color: var(--ink); }
  .nav-foot { margin-top: auto; padding-top: 14px; border-top: 1px solid var(--line); }
  .nav-foot form { margin: 0; }
  .nav-foot button { width: 100%; }

  .main { padding: 38px 44px 120px; max-width: 940px; }
  .page-title { font-family: var(--serif); font-size: 28px; font-weight: 600; letter-spacing: -.01em; margin: 0 0 6px; }
  .lede { color: var(--muted); margin: 0 0 24px; font-size: 14.5px; max-width: 62ch; }

  @media (max-width: 860px) {
    .layout { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px 18px; }
    .brand { border: 0; margin: 0; padding: 0; flex: 1 0 auto; }
    .nav { flex-direction: row; flex-wrap: wrap; }
    .nav-foot { margin: 0; padding: 0; border: 0; }
    .nav-foot button { width: auto; }
    .main { padding: 22px 18px 120px; }
  }

  /* Section panels */
  [id] { scroll-margin-top: 16px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius);
    padding: 22px 22px 24px; margin: 0 0 18px; }
  .card h2 { font-family: var(--serif); font-size: 18px; font-weight: 600; margin: 0; }
  .card .hint { color: var(--muted); font-size: 13px; margin: 4px 0 0; }
  .card h2 + .grid, .card h2 + .table-wrap, .card .hint + .grid,
  .card .hint + label, .card h2 + label { margin-top: 16px; }

  label { display: block; font-size: 12.5px; font-weight: 600; color: #444b5d; margin: 16px 0 6px;
    letter-spacing: .005em; }
  label:first-of-type { margin-top: 0; }
  input, textarea, select { width: 100%; font: inherit; color: var(--ink); background: #fff;
    border: 1px solid var(--line-strong); border-radius: 7px; padding: 9px 11px;
    transition: border-color .12s, box-shadow .12s; }
  input::placeholder, textarea::placeholder { color: #aeb2bd; }
  input:focus, textarea:focus { outline: none; border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(30,58,95,.12); }
  textarea { min-height: 130px; resize: vertical; line-height: 1.55; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }

  /* Course table — spreadsheet feel: borderless cells until hover/focus */
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 7px; }
  table { width: 100%; border-collapse: collapse; min-width: 800px; font-size: 14px; }
  thead th { background: #faf9f6; text-align: left; font-size: 11px; font-weight: 700;
    letter-spacing: .05em; text-transform: uppercase; color: var(--muted);
    padding: 11px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  tbody td { padding: 5px 7px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  td input { border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 7px 9px; font-size: 13.5px; }
  td input:hover { border-color: var(--line-strong); }
  td input:focus { background: #fff; }
  .col-name { min-width: 240px; }
  .col-num input { text-align: right; }
  .price-pair { display: flex; align-items: center; gap: 4px; }
  .price-pair input { width: 78px; }
  .price-pair .sep { color: #c4c6cc; }

  /* Buttons */
  button { font: inherit; font-weight: 600; font-size: 14px; cursor: pointer; border-radius: 7px;
    border: 1px solid transparent; padding: 9px 16px; transition: background .12s, border-color .12s; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover { background: var(--accent-ink); }
  .btn-ghost { background: #fff; color: var(--ink); border-color: var(--line-strong); }
  .btn-ghost:hover { background: #f4f3ee; }
  .add-row { background: #fff; color: var(--accent); border: 1px dashed var(--line-strong);
    font-size: 13px; padding: 8px 14px; margin-top: 14px; }
  .add-row:hover { border-color: var(--accent); background: #f7f8fa; }
  .icon-btn { background: transparent; color: #b3b6bf; border: 1px solid transparent;
    width: 30px; height: 30px; padding: 0; line-height: 1; font-size: 14px; border-radius: 6px; }
  .icon-btn:hover { background: #fbeeea; color: var(--red); border-color: #ecd2ca; }

  /* Sticky save bar — aligned to content, clears the sidebar */
  .savebar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 25;
    background: rgba(255,255,255,.92); backdrop-filter: blur(8px); border-top: 1px solid var(--line); }
  .savebar-inner { padding: 12px 44px 12px 292px; display: flex; align-items: center; gap: 14px; }
  .savebar .note { color: var(--muted); font-size: 13px; }
  .savebar .spacer { flex: 1; }
  @media (max-width: 860px) { .savebar-inner { padding: 12px 18px; } }

  /* Flash */
  .flash { display: flex; align-items: center; gap: 9px; background: var(--ok-bg);
    border: 1px solid #cfe1d4; color: var(--ok); padding: 12px 14px; border-radius: 7px;
    margin: 0 0 20px; font-size: 14px; }

  /* Login */
  .login-shell { min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: var(--bg); }
  .login-card { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 34px 32px; box-shadow: 0 1px 2px rgba(20,30,50,.05); }
  .login-card .mark { width: 44px; height: 44px; font-size: 17px; margin-bottom: 20px; }
  .login-card h1 { font-family: var(--serif); font-size: 23px; font-weight: 600; margin: 0 0 3px; }
  .login-card .lede { margin-bottom: 22px; }
  .login-card label { margin-top: 16px; }
  .login-card button { width: 100%; margin-top: 22px; padding: 11px; }
  .error { background: #fbeeea; border: 1px solid #ecd2ca; color: var(--red);
    padding: 10px 12px; border-radius: 7px; font-size: 13.5px; font-weight: 500; margin: 0 0 16px; }
`;

function loginPage({ error } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Admin Login — De Jure Academy</title><style>${PAGE_STYLE}</style></head>
<body><div class="login-shell"><div class="login-card">
<div class="mark">DJ</div>
<h1>De Jure Academy</h1>
<p class="lede">Sign in to manage the knowledge base.</p>
${error ? `<div class="error">${esc(error)}</div>` : ""}
<form method="post" action="/admin/login">
  <label for="username">Username</label>
  <input type="text" id="username" name="username" autocomplete="username" autofocus required>
  <label for="password">Password</label>
  <input type="password" id="password" name="password" autocomplete="current-password" required>
  <button type="submit" class="btn-primary">Log in</button>
</form>
</div></div></body></html>`;
}

// Render one course row. `path` is the form-name prefix, e.g. categories[0][courses][3].
function courseRow(path, course = {}) {
  const cell = (mode) => {
    const p = course[mode] ?? {};
    return `<td class="col-num"><div class="price-pair">
      <input type="text" name="${path}[${mode}][offer]" value="${esc(p.offer)}" placeholder="offer">
      <span class="sep">/</span>
      <input type="text" name="${path}[${mode}][regular]" value="${esc(p.regular)}" placeholder="reg">
    </div></td>`;
  };
  return `<tr>
    <td class="col-name"><input type="text" name="${path}[name]" value="${esc(course.name)}" placeholder="Course name"></td>
    ${cell("online")}${cell("offline")}${cell("onlineOffline")}
    <td><input type="text" name="${path}[duration]" value="${esc(course.duration)}" placeholder="e.g. 6 mo"></td>
    <td><input type="text" name="${path}[starts]" value="${esc(course.starts)}" placeholder="YYYY-MM-DD"></td>
    <td><button type="button" class="icon-btn" title="Remove course" onclick="this.closest('tr').remove()">✕</button></td>
  </tr>`;
}

function categoryTable(ci, cat) {
  const courses = cat.courses ?? [];
  const rows = courses
    .map((course, ri) => courseRow(`categories[${ci}][courses][${ri}]`, course))
    .join("\n");
  // Rows added in the browser start their index above the existing count.
  return `<section class="card">
  <h2>${esc(cat.name)}</h2>
  <p class="hint">Prices are in BDT. Enter the offer price first, then the regular price (leave blank if there's no discount or the mode isn't offered).</p>
  <input type="hidden" name="categories[${ci}][name]" value="${esc(cat.name)}">
  <div class="table-wrap"><table><thead><tr>
    <th>Course</th><th>Online · offer / reg</th><th>Offline</th><th>Online+Offline</th>
    <th>Duration</th><th>Starts</th><th></th>
  </tr></thead>
  <tbody data-cat="${ci}" data-next="${courses.length}">
  ${rows}
  </tbody></table></div>
  <button type="button" class="add-row" onclick="addRow(${ci})">+ Add course</button>
  </section>`;
}

function editorPage(kb, { csrf, saved } = {}) {
  const ta = (label, name, value, hint) =>
    `<label for="${name}">${esc(label)}</label>` +
    `<textarea id="${name}" name="${name}">${esc(value)}</textarea>` +
    (hint ? `<p class="hint" style="margin-top:6px">${esc(hint)}</p>` : "");
  const text = (label, name, value, placeholder = "") =>
    `<div><label for="${name}">${esc(label)}</label>` +
    `<input type="text" id="${name}" name="${name}" value="${esc(value)}" placeholder="${esc(placeholder)}"></div>`;

  const c = kb.contact ?? {};
  const categories = (kb.courseCategories ?? []).map((cat, ci) => categoryTable(ci, cat)).join("\n");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edit Knowledge Base — De Jure Academy</title><style>${PAGE_STYLE}</style></head>
<body>
<div class="layout">
<aside class="sidebar">
  <div class="brand">
    <div class="mark">DJ</div>
    <div>
      <div class="brand-name">De Jure Academy</div>
      <div class="brand-sub">Knowledge Base</div>
    </div>
  </div>
  <nav class="nav">
    <a href="#sec-about">About</a>
    <a href="#sec-contact">Contact</a>
    <a href="#sec-courses">Courses</a>
    <a href="#sec-books">Books &amp; products</a>
    <a href="#sec-enroll">Enrollment</a>
    <a href="#sec-rules">AI answering rules</a>
  </nav>
  <div class="nav-foot">
    <form method="post" action="/admin/logout">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button type="submit" class="btn-ghost">Log out</button>
    </form>
  </div>
</aside>

<main class="main">
<h1 class="page-title">Knowledge Base</h1>
<p class="lede">This is the bot's source of truth. Changes take effect for new replies as soon as you save — no restart needed.</p>
${saved ? `<div class="flash">Saved. The bot is now using the updated knowledge base.</div>` : ""}

<form method="post" action="/admin/save">
<input type="hidden" name="_csrf" value="${esc(csrf)}">

<section class="card" id="sec-about">
  <h2>About</h2>
  <p class="hint">Supports markdown. Include core values, mission, and vision here as <code>###</code> subsections.</p>
  ${ta("About De Jure Academy", "about", kb.about)}
</section>

<section class="card" id="sec-contact">
  <h2>Contact</h2>
  <p class="hint">Leave a field blank and the bot will treat it as not-yet-available.</p>
  <div class="grid">
    ${text("Phone / WhatsApp", "contact[phone]", c.phone, "+8801XXXXXXXXX")}
    ${text("Email", "contact[email]", c.email, "info@dejureacademy.com")}
    ${text("Address / Campus", "contact[address]", c.address, "Dhaka")}
    ${text("Office hours", "contact[officeHours]", c.officeHours, "Sat–Thu, 10am–6pm")}
  </div>
</section>

<div id="sec-courses">
${categories}
</div>

<section class="card" id="sec-books">
  <h2>Books &amp; products</h2>
  ${ta("Books", "books", kb.books, "Markdown — one product per line.")}
</section>

<section class="card" id="sec-enroll">
  <h2>How to enroll / pay</h2>
  ${ta("Enrollment instructions", "enroll", kb.enroll, "Markdown.")}
</section>

<section class="card" id="sec-rules">
  <h2>AI answering rules</h2>
  ${ta("Answering rules", "answeringRules", kb.answeringRules, "Markdown — guidance the bot always follows. Edit with care.")}
</section>

<div class="savebar"><div class="savebar-inner">
  <span class="note">Changes apply instantly after saving.</span>
  <span class="spacer"></span>
  <button type="submit" class="btn-primary">Save changes</button>
</div></div>
</form>
</main>
</div>

<script>
function priceCell(path, mode) {
  return '<td class="col-num"><div class="price-pair">' +
    '<input type="text" name="' + path + '[' + mode + '][offer]" placeholder="offer">' +
    '<span class="sep">/</span>' +
    '<input type="text" name="' + path + '[' + mode + '][regular]" placeholder="reg">' +
    '</div></td>';
}
function addRow(ci) {
  var tbody = document.querySelector('tbody[data-cat="' + ci + '"]');
  var ri = parseInt(tbody.getAttribute('data-next'), 10);
  tbody.setAttribute('data-next', ri + 1);
  var path = 'categories[' + ci + '][courses][' + ri + ']';
  var tr = document.createElement('tr');
  tr.innerHTML =
    '<td class="col-name"><input type="text" name="' + path + '[name]" placeholder="Course name"></td>' +
    priceCell(path, 'online') + priceCell(path, 'offline') + priceCell(path, 'onlineOffline') +
    '<td><input type="text" name="' + path + '[duration]" placeholder="e.g. 6 mo"></td>' +
    '<td><input type="text" name="' + path + '[starts]" placeholder="YYYY-MM-DD"></td>' +
    '<td><button type="button" class="icon-btn" title="Remove course" onclick="this.closest(\\'tr\\').remove()">✕</button></td>';
  tbody.appendChild(tr);
  tr.querySelector('input').focus();
}
</script>
</body></html>`;
}

// --- Form body -> kb object ---

// qs (express.urlencoded extended) gives arrays for small indexed groups but objects when large.
// Normalize either shape to an array, ordered by numeric key.
function toArray(x) {
  if (Array.isArray(x)) return x.filter((v) => v != null);
  if (x && typeof x === "object") {
    return Object.keys(x)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => x[k])
      .filter((v) => v != null);
  }
  return [];
}

function price(p) {
  return { offer: (p?.offer ?? "").trim(), regular: (p?.regular ?? "").trim() };
}

function formToKb(body) {
  const categories = toArray(body.categories).map((cat) => ({
    name: (cat.name ?? "").trim(),
    courses: toArray(cat.courses)
      .map((course) => ({
        name: (course.name ?? "").trim(),
        duration: (course.duration ?? "").trim(),
        starts: (course.starts ?? "").trim(),
        online: price(course.online),
        offline: price(course.offline),
        onlineOffline: price(course.onlineOffline),
      }))
      // Drop fully-empty rows the admin added but left blank.
      .filter((course) => course.name),
  }));

  return {
    about: body.about ?? "",
    contact: {
      phone: body.contact?.phone ?? "",
      email: body.contact?.email ?? "",
      address: body.contact?.address ?? "",
      officeHours: body.contact?.officeHours ?? "",
    },
    courseCategories: categories,
    books: body.books ?? "",
    enroll: body.enroll ?? "",
    answeringRules: body.answeringRules ?? "",
  };
}

// --- Router factory ---
// `onSaved` is called after a successful save so the server can hot-reload the prompt.
export function createAdminRouter({ adminUsername, adminPassword, sessionSecret, onSaved }) {
  const router = express.Router();

  const requireAuth = (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySession(sessionSecret, cookies[COOKIE_NAME]);
    if (!session) return res.redirect("/admin/login");
    req.session = session;
    req.sessionValue = cookies[COOKIE_NAME];
    next();
  };

  // Reject forged cross-site POSTs (defense-in-depth on top of SameSite=Strict).
  const requireCsrf = (req, res, next) => {
    const expected = csrfToken(sessionSecret, req.sessionValue);
    if (!safeEqual(req.body?._csrf ?? "", expected)) return res.status(403).send("Invalid CSRF token.");
    next();
  };

  router.get("/login", (req, res) => {
    // Already logged in? Skip the form.
    const cookies = parseCookies(req.headers.cookie);
    if (verifySession(sessionSecret, cookies[COOKIE_NAME])) return res.redirect("/admin");
    res.type("html").send(loginPage());
  });

  router.post("/login", (req, res) => {
    const { username = "", password = "" } = req.body ?? {};
    const ok = safeEqual(username, adminUsername) && safeEqual(password, adminPassword);
    if (!ok) {
      return res.status(401).type("html").send(loginPage({ error: "Wrong username or password." }));
    }
    const value = signSession(sessionSecret, adminUsername);
    res.cookie(COOKIE_NAME, value, {
      httpOnly: true,
      sameSite: "strict",
      secure: process.env.NODE_ENV === "production",
      maxAge: SESSION_TTL_MS,
      path: "/admin",
    });
    res.redirect("/admin");
  });

  router.post("/logout", requireAuth, requireCsrf, (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/admin" });
    res.redirect("/admin/login");
  });

  router.get("/", requireAuth, (req, res) => {
    const csrf = csrfToken(sessionSecret, req.sessionValue);
    res.type("html").send(editorPage(loadKb(), { csrf, saved: req.query.saved === "1" }));
  });

  router.post("/save", requireAuth, requireCsrf, (req, res) => {
    const kb = formToKb(req.body ?? {});
    saveKb(kb);
    if (typeof onSaved === "function") onSaved();
    res.redirect("/admin?saved=1");
  });

  return router;
}
