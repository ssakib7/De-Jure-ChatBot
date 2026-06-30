// Admin web panel for editing the knowledge base.
// Mounted at the root ("/") by server.js. Auth is a signed, httpOnly session cookie (no DB, no extra deps).
import crypto from "node:crypto";
import express from "express";

import {
  loadKb,
  saveKb,
  DEFAULT_SYSTEM_PROMPT,
  loadSystemPrompt,
  saveSystemPrompt,
  loadPromptSections,
  savePromptSections,
  DEFAULT_ANSWERING_RULES,
  loadAnsweringRules,
  saveAnsweringRules,
} from "./kb.js";
import {
  DEFAULT_LEAD_INSTRUCTION,
  DEFAULT_ASK_AFTER_TURNS,
  loadLeadCapture,
  saveLeadCapture,
} from "./lead_capture.js";

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
    --navy: #070E1B; --navy-mid: #0C1929; --panel: rgba(12, 22, 38, 0.72);
    --panel-solid: #0C1929; --ink: #EAF2FB; --muted: #8BAAC8; --muted-2: #5A7798;
    --line: rgba(0, 202, 255, 0.10); --line-strong: rgba(139, 170, 200, 0.20);
    --accent: #00CAFF; --accent-ink: #00b0e0; --orange: #F5821E;
    --red: #ff6b6b; --ok: #4fd6a0; --ok-bg: rgba(79, 214, 160, 0.08);
    --serif: 'Inter', ui-sans-serif, system-ui, sans-serif;
    --sans: 'Hind Siliguri', 'Inter', ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Noto Sans Bengali", sans-serif;
    --radius: 12px;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; background: var(--navy); color: var(--ink); font-family: var(--sans);
    font-size: 15px; line-height: 1.55;
    background-image: radial-gradient(1200px 600px at 80% -10%, rgba(0,202,255,.06), transparent 60%),
      radial-gradient(900px 500px at -10% 110%, rgba(245,130,30,.05), transparent 55%); }
  a { color: var(--accent); }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em;
    background: rgba(0,202,255,.10); color: #b9e9ff; padding: 1px 5px; border-radius: 4px; }

  /* Layout: fixed sidebar + content */
  .layout { display: grid; grid-template-columns: 248px minmax(0, 1fr); min-height: 100vh; }
  .sidebar { position: sticky; top: 0; align-self: start; height: 100vh; overflow-y: auto;
    background: rgba(9, 18, 32, 0.85); backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
    border-right: 1px solid var(--line); padding: 22px 16px;
    display: flex; flex-direction: column; gap: 4px; }
  .brand { display: flex; align-items: center; gap: 11px; padding: 2px 6px 18px;
    border-bottom: 1px solid var(--line); margin-bottom: 16px; }
  .mark { width: 38px; height: 38px; flex: none; border-radius: 10px;
    background: linear-gradient(145deg, #0B1929, #0E2040);
    border: 1px solid rgba(0, 202, 255, 0.28);
    box-shadow: 0 0 0 1px rgba(245,130,30,.12), 0 0 18px rgba(0,202,255,.14);
    color: #fff; display: grid; place-items: center; font-size: 19px; }
  .brand-name { font-family: var(--serif); font-weight: 800; font-size: 15px; line-height: 1.15; letter-spacing: .5px; }
  .brand-name .ai { color: var(--accent); }
  .brand-sub { font-size: 11px; color: var(--orange); letter-spacing: 1.5px; text-transform: uppercase; font-weight: 600; }
  .nav { display: flex; flex-direction: column; gap: 1px; }
  .nav a { display: block; padding: 8px 11px; border-radius: 8px; color: var(--muted);
    text-decoration: none; font-size: 14px; font-weight: 500; transition: background .15s, color .15s; }
  .nav a:hover { background: rgba(0,202,255,.08); color: var(--ink); }
  .nav a.nav-active { background: rgba(0,202,255,.12); color: var(--ink); font-weight: 600; }
  .nav-label { font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: var(--muted-2); padding: 14px 11px 5px; }
  .nav a.nav-sub { padding: 5px 11px 5px 22px; font-size: 13px; color: var(--muted-2); }
  .nav a.nav-sub:hover { color: var(--ink); }
  .nav-foot { margin-top: auto; padding-top: 14px; border-top: 1px solid var(--line); }
  .nav-foot form { margin: 0; }
  .nav-foot button { width: 100%; }

  .main { padding: 38px 44px 120px; max-width: 940px; }
  .page-title { font-family: var(--serif); font-size: 28px; font-weight: 700; letter-spacing: -.01em; margin: 0 0 6px; }
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
  .card { background: var(--panel); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
    border: 1px solid var(--line); border-radius: var(--radius);
    padding: 22px 22px 24px; margin: 0 0 18px;
    box-shadow: 0 1px 0 0 rgba(255,255,255,.03) inset, 0 0 40px rgba(0,0,0,.3); }
  .card h2 { font-family: var(--serif); font-size: 18px; font-weight: 700; margin: 0; }
  .card .hint { color: var(--muted-2); font-size: 13px; margin: 4px 0 0; }
  .card h2 + .grid, .card h2 + .table-wrap, .card .hint + .grid,
  .card .hint + label, .card h2 + label { margin-top: 16px; }

  label { display: block; font-size: 12.5px; font-weight: 600; color: var(--muted); margin: 16px 0 6px;
    letter-spacing: .005em; }
  label:first-of-type { margin-top: 0; }
  input, textarea, select { width: 100%; font: inherit; color: var(--ink); background: rgba(255,255,255,0.04);
    border: 1px solid var(--line-strong); border-radius: 8px; padding: 9px 11px;
    transition: border-color .15s, box-shadow .15s, background .15s; }
  input::placeholder, textarea::placeholder { color: var(--muted-2); }
  input:focus, textarea:focus { outline: none; border-color: var(--accent);
    background: rgba(0,202,255,.05); box-shadow: 0 0 0 3px rgba(0,202,255,.15); }
  textarea { min-height: 130px; resize: vertical; line-height: 1.55; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 18px; }
  @media (max-width: 560px) { .grid { grid-template-columns: 1fr; } }

  /* Course table — spreadsheet feel: borderless cells until hover/focus */
  .table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; min-width: 800px; font-size: 14px; }
  thead th { background: rgba(0,202,255,.05); text-align: left; font-size: 11px; font-weight: 700;
    letter-spacing: .05em; text-transform: uppercase; color: var(--muted);
    padding: 11px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  tbody td { padding: 5px 7px; border-bottom: 1px solid var(--line); vertical-align: middle; }
  tbody tr:last-child td { border-bottom: 0; }
  td input { border: 1px solid transparent; background: transparent; border-radius: 6px; padding: 7px 9px; font-size: 13.5px; }
  td input:hover { border-color: var(--line-strong); }
  td input:focus { background: rgba(0,202,255,.06); }
  .col-name { min-width: 240px; }
  .col-num input { text-align: right; }
  .price-pair { display: flex; align-items: center; gap: 4px; }
  .price-pair input { width: 78px; }
  .price-pair .sep { color: var(--muted-2); }

  /* Buttons */
  button { font: inherit; font-weight: 600; font-size: 14px; cursor: pointer; border-radius: 8px;
    border: 1px solid transparent; padding: 9px 16px; transition: background .15s, border-color .15s, box-shadow .15s, transform .15s; }
  .btn-primary { background: linear-gradient(135deg, var(--orange) 0%, #d96d0e 42%, #0098c0 72%, var(--accent) 100%);
    background-size: 220% 220%; color: #fff; box-shadow: 0 4px 18px rgba(245,130,30,.28); }
  .btn-primary:hover { transform: translateY(-1px); box-shadow: 0 8px 26px rgba(245,130,30,.34), 0 8px 26px rgba(0,202,255,.18); }
  .btn-ghost { background: rgba(255,255,255,0.04); color: var(--ink); border-color: var(--line-strong); }
  .btn-ghost:hover { background: rgba(0,202,255,.08); border-color: var(--accent); }
  .add-row { background: rgba(0,202,255,.04); color: var(--accent); border: 1px dashed var(--line-strong);
    font-size: 13px; padding: 8px 14px; margin-top: 14px; }
  .add-row:hover { border-color: var(--accent); background: rgba(0,202,255,.10); }
  .icon-btn { background: transparent; color: var(--muted-2); border: 1px solid transparent;
    width: 30px; height: 30px; padding: 0; line-height: 1; font-size: 14px; border-radius: 6px; }
  .icon-btn:hover { background: rgba(255,107,107,.12); color: var(--red); border-color: rgba(255,107,107,.3); }

  /* Add-course / add-column actions under each table */
  .table-actions { display: flex; gap: 10px; flex-wrap: wrap; }

  /* Custom (admin-added) free-form sections */
  .custom-head { display: flex; align-items: center; gap: 10px; margin: 0 0 4px; }
  .custom-title { font-family: var(--serif); font-size: 18px; font-weight: 700; color: var(--ink);
    background: transparent; border: 1px solid transparent; border-radius: 8px; padding: 6px 9px; }
  .custom-title::placeholder { color: var(--muted-2); font-weight: 600; }
  .custom-title:hover { border-color: var(--line-strong); }
  .custom-title:focus { outline: none; background: rgba(0,202,255,.06); border-color: var(--accent);
    box-shadow: 0 0 0 3px rgba(0,202,255,.15); }
  .custom-head .icon-btn { flex: none; }
  .custom-empty { color: var(--muted); font-size: 14px; margin: 0 0 14px; }
  #sec-custom > .add-row { margin-top: 0; }

  /* System prompt — long instructions, so a tall editor with a monospace feel */
  textarea.prompt-input { min-height: 340px; font-size: 13.5px; line-height: 1.6; }

  /* Examples & scenarios group (admin-added prompt sections) */
  .group-head { font-family: var(--serif); font-size: 18px; font-weight: 700; margin: 26px 0 2px; }
  .group-sub { color: var(--muted); font-size: 13.5px; margin: 0 0 14px; max-width: 72ch; }
  #sec-scenarios > .add-row { margin-top: 0; }

  /* Custom (admin-added) text columns */
  .extra-col { min-width: 130px; }
  .col-head { display: flex; align-items: center; gap: 4px; }
  .col-head input { font-size: 11px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase;
    color: var(--muted); background: transparent; border: 1px solid transparent; padding: 5px 6px; min-width: 86px; }
  .col-head input:hover { border-color: var(--line-strong); }
  .col-head input:focus { background: rgba(0,202,255,.06); color: var(--ink); }
  .col-del { background: transparent; color: var(--muted-2); border: 0; width: 20px; height: 20px;
    padding: 0; font-size: 12px; line-height: 1; border-radius: 5px; flex: none; }
  .col-del:hover { background: rgba(255,107,107,.15); color: var(--red); }

  /* Sticky save bar — starts after the sidebar so it never covers the Log out button */
  .savebar { position: fixed; left: 248px; right: 0; bottom: 0; z-index: 25;
    background: rgba(9, 18, 32, 0.86); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
    border-top: 1px solid var(--line); }
  .savebar-inner { padding: 12px 44px; display: flex; align-items: center; gap: 14px; }
  .savebar .note { color: var(--muted); font-size: 13px; }
  .savebar .spacer { flex: 1; }
  @media (max-width: 860px) { .savebar { left: 0; } .savebar-inner { padding: 12px 18px; } }

  /* Flash */
  .flash { display: flex; align-items: center; gap: 9px; background: var(--ok-bg);
    border: 1px solid rgba(79,214,160,.3); color: var(--ok); padding: 12px 14px; border-radius: 8px;
    margin: 0 0 20px; font-size: 14px; }
`;

const LOGIN_STYLE = `
  :root {
    --navy:        #070E1B;
    --navy-mid:    #0C1929;
    --navy-card:   rgba(9, 18, 32, 0.88);
    --orange:      #F5821E;
    --orange-dim:  rgba(245, 130, 30, 0.22);
    --cyan:        #00CAFF;
    --cyan-dim:    rgba(0, 202, 255, 0.18);
    --white:       #FFFFFF;
    --silver:      #8BAAC8;
    --muted:       #3D5A78;
    --input-bg:    rgba(255,255,255,0.04);
    --input-bdr:   rgba(255,255,255,0.09);
    --radius-card: 22px;
    --radius-inp:  12px;
    --f-bn:        'Hind Siliguri', sans-serif;
    --f-lat:       'Inter', sans-serif;
  }

  *, *::before, *::after { margin:0; padding:0; box-sizing:border-box; }

  html, body {
    height: 100%;
    background: var(--navy);
    font-family: var(--f-bn);
    color: var(--white);
    overflow: hidden;
  }

  /* Animated circuit canvas */
  #cvs { position: fixed; inset: 0; width: 100%; height: 100%; z-index: 0; }

  /* Page shell */
  .page {
    position: relative;
    z-index: 10;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px 16px;
    overflow-y: auto;
  }

  /* Card */
  .card {
    width: 100%;
    max-width: 440px;
    background: var(--navy-card);
    backdrop-filter: blur(24px);
    -webkit-backdrop-filter: blur(24px);
    border: 1px solid rgba(0, 202, 255, 0.13);
    border-radius: var(--radius-card);
    padding: 44px 36px 36px;
    position: relative;
    box-shadow:
      0 2px 0   0 rgba(255,255,255,0.04) inset,
      0 0 60px  0 rgba(0,0,0,0.6),
      0 0 120px 0 rgba(0,202,255,0.04);
    animation: cardIn .55s cubic-bezier(.22,.68,0,1.2) both;
  }

  @keyframes cardIn {
    from { opacity:0; transform: translateY(28px) scale(.97); }
    to   { opacity:1; transform: translateY(0)    scale(1);   }
  }

  /* top shimmer line */
  .card::before {
    content: '';
    position: absolute;
    top: 0; left: 10%; right: 10%; height: 1.5px;
    background: linear-gradient(90deg, transparent, var(--orange) 30%, var(--cyan) 70%, transparent);
    border-radius: 0 0 4px 4px;
  }

  /* Logo */
  .logo-wrap { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 28px; }
  .logo-box {
    width: 68px; height: 68px;
    background: linear-gradient(145deg, #0B1929, #0E2040);
    border-radius: 17px;
    border: 1px solid rgba(0, 202, 255, 0.28);
    display: flex; align-items: center; justify-content: center;
    position: relative;
    box-shadow: 0 0 0 1px rgba(245,130,30,.12), 0 0 28px rgba(0,202,255,.12), 0 6px 30px rgba(0,0,0,.5);
  }
  .logo-box::after {
    content: '';
    position: absolute;
    inset: -3px; border-radius: 20px;
    background: conic-gradient(from 190deg, var(--orange) 0deg 80deg, transparent 80deg 260deg, var(--cyan) 260deg 340deg, transparent 340deg 360deg);
    z-index: -1; opacity: .55; animation: spin 6s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .logo-brain { font-size: 32px; line-height: 1; filter: drop-shadow(0 0 8px rgba(0,202,255,.6)); }
  .logo-name {
    font-family: var(--f-lat); font-size: 26px; font-weight: 800; letter-spacing: 1.5px;
    color: var(--white); display: flex; align-items: center; gap: 3px; line-height: 1;
  }
  .logo-name .ai { color: var(--cyan); }
  .logo-name .dot { font-size: 13px; color: var(--orange); margin: 0 1px; }
  .logo-badge {
    font-family: var(--f-lat); font-size: 11px; font-weight: 600; letter-spacing: 2.4px;
    text-transform: uppercase; color: var(--orange); opacity: .9;
  }

  /* Welcome */
  .welcome { text-align: center; margin-bottom: 30px; }
  .welcome h1 { font-size: 23px; font-weight: 700; color: var(--white); margin-bottom: 7px; line-height: 1.35; }
  .welcome p { font-size: 14px; color: var(--silver); line-height: 1.65; }
  .welcome p strong { color: var(--cyan); font-weight: 600; }

  /* Form */
  .field { margin-bottom: 18px; }
  .field label { display: block; font-size: 13.5px; font-weight: 500; color: var(--silver); margin-bottom: 7px; padding-left: 2px; }
  .inp-wrap { position: relative; display: flex; align-items: center; }
  .inp-icon { position: absolute; left: 14px; color: var(--muted); font-size: 15px; pointer-events: none; transition: color .25s; }
  .inp-wrap:focus-within .inp-icon { color: var(--cyan); }
  input.inp {
    width: 100%;
    padding: 13.5px 14px 13.5px 42px;
    background: var(--input-bg);
    border: 1px solid var(--input-bdr);
    border-radius: var(--radius-inp);
    color: var(--white);
    font-size: 14.5px;
    font-family: var(--f-bn);
    outline: none;
    transition: border-color .25s, box-shadow .25s, background .25s;
    -webkit-appearance: none;
  }
  input.inp::placeholder { color: var(--muted); font-size: 13.5px; }
  input.inp:focus { border-color: var(--cyan); background: rgba(0,202,255,.05); box-shadow: 0 0 0 3px rgba(0,202,255,.15); }
  .inp.pr { padding-right: 44px; }
  .pw-toggle {
    position: absolute; right: 13px; background: none; border: none; color: var(--muted);
    cursor: pointer; font-size: 15px; padding: 4px; transition: color .25s;
  }
  .pw-toggle:hover { color: var(--cyan); }

  /* Row */
  .row-opts { display: flex; justify-content: space-between; align-items: center; margin-bottom: 26px; flex-wrap: wrap; gap: 10px; }
  .chk-label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13.5px; color: var(--silver); user-select: none; }
  .chk-label input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--cyan); cursor: pointer; border-radius: 4px; }
  .forgot { font-size: 13.5px; color: var(--cyan); text-decoration: none; transition: color .25s; }
  .forgot:hover { color: var(--orange); }

  /* Button */
  .btn-login {
    width: 100%; padding: 15px; border: none; border-radius: var(--radius-inp);
    font-family: var(--f-bn); font-size: 17px; font-weight: 700; color: var(--white); cursor: pointer;
    background: linear-gradient(135deg, var(--orange) 0%, #d96d0e 40%, #0098c0 70%, var(--cyan) 100%);
    background-size: 250% 250%; animation: btnShift 5s ease infinite;
    box-shadow: 0 4px 22px rgba(245,130,30,.35);
    transition: transform .2s, box-shadow .25s; position: relative; overflow: hidden; letter-spacing: .3px;
  }
  @keyframes btnShift { 0% { background-position: 0% 50%; } 50% { background-position: 100% 50%; } 100% { background-position: 0% 50%; } }
  .btn-login:hover { transform: translateY(-2px); box-shadow: 0 8px 32px rgba(245,130,30,.4), 0 8px 32px rgba(0,202,255,.2); }
  .btn-login:active { transform: translateY(0); }
  .btn-login:disabled { opacity: .65; cursor: not-allowed; transform: none; }

  /* Divider */
  .divider { display: flex; align-items: center; gap: 10px; margin: 22px 0; }
  .divider::before, .divider::after { content:''; flex:1; height:1px; background: var(--input-bdr); }
  .divider span { font-size: 12px; color: var(--muted); white-space: nowrap; }

  /* Footer */
  .card-foot { text-align: center; margin-top: 20px; font-size: 13.5px; color: var(--muted); }
  .card-foot a { color: var(--cyan); text-decoration: none; font-weight: 500; }
  .card-foot a:hover { color: var(--orange); }

  /* Bottom bar */
  .bottom-bar { margin-top: 20px; text-align: center; font-family: var(--f-lat); font-size: 11.5px; color: var(--muted); letter-spacing: .3px; opacity: .75; }

  /* Field-level error state */
  .err-msg { display: none; font-size: 12.5px; color: #ff6b6b; margin-top: 6px; padding-left: 2px; }
  .field.has-error input.inp { border-color: #ff6b6b; box-shadow: 0 0 0 3px rgba(255,107,107,.15); }
  .field.has-error .err-msg { display: block; }

  /* Server-side error banner */
  .server-err {
    background: rgba(255,107,107,.08); border: 1px solid rgba(255,107,107,.35); color: #ff6b6b;
    font-size: 13.5px; font-weight: 500; padding: 11px 14px; border-radius: var(--radius-inp);
    margin-bottom: 22px; display: flex; align-items: center; gap: 8px;
  }

  /* Sparkle badge top-right */
  .badge-ai {
    position: absolute; top: 18px; right: 20px;
    font-family: var(--f-lat); font-size: 10px; font-weight: 700; letter-spacing: 1px; color: var(--cyan);
    border: 1px solid rgba(0,202,255,.3); border-radius: 20px; padding: 3px 9px;
    display: flex; align-items: center; gap: 4px; opacity: .8;
  }
  .badge-ai .dot-pulse { width: 6px; height: 6px; background: var(--cyan); border-radius: 50%; animation: pulse 1.6s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity:1; transform: scale(1); } 50% { opacity:.4; transform: scale(.7); } }

  /* Responsive */
  @media (max-width: 480px) {
    .card { padding: 38px 22px 30px; }
    .welcome h1 { font-size: 20px; }
    .btn-login { font-size: 16px; }
    .row-opts { flex-direction: column; align-items: flex-start; }
  }
  @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: .01ms !important; } }
`;

function loginPage({ error } = {}) {
  return `<!doctype html><html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>De Jure Academy — Admin Login</title>
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>${LOGIN_STYLE}</style></head>
<body>
<canvas id="cvs"></canvas>
<div class="page">
  <div class="card">
    <div class="badge-ai"><span class="dot-pulse"></span> LIVE AI</div>

    <div class="logo-wrap">
      <div class="logo-box"><span class="logo-brain">🧠</span></div>
      <div class="logo-name">SOJAG <span class="dot">✦</span> <span class="ai">AI</span></div>
      <div class="logo-badge">De Jure Academy</div>
    </div>

    <div class="welcome">
      <h1>আপনাকে স্বাগতম! ✨</h1>
      <p>বাংলাদেশের সবচেয়ে শক্তিশালী<br/>
        <strong>AI এজেন্ট</strong>-এ আপনার অ্যাকাউন্টে লগইন করুন</p>
    </div>

    ${error ? `<div class="server-err"><i class="fa-solid fa-circle-exclamation"></i><span>${esc(error)}</span></div>` : ""}

    <form id="loginForm" method="post" action="/login" novalidate>
      <div class="field" id="f-user">
        <label for="username">ইউজারনেম / ইমেইল</label>
        <div class="inp-wrap">
          <i class="fa-solid fa-envelope inp-icon"></i>
          <input id="username" name="username" type="text" class="inp"
            placeholder="আপনার ইউজারনেম বা ইমেইল লিখুন" autocomplete="username" autofocus>
        </div>
        <div class="err-msg">⚠️ এই ঘরটি পূরণ করা আবশ্যক</div>
      </div>

      <div class="field" id="f-pass">
        <label for="password">পাসওয়ার্ড</label>
        <div class="inp-wrap">
          <i class="fa-solid fa-lock inp-icon"></i>
          <input id="password" name="password" type="password" class="inp pr"
            placeholder="আপনার পাসওয়ার্ড লিখুন" autocomplete="current-password">
          <button type="button" class="pw-toggle" id="pwToggle" aria-label="পাসওয়ার্ড দেখুন">
            <i class="fa-solid fa-eye" id="eyeIcon"></i>
          </button>
        </div>
        <div class="err-msg">⚠️ পাসওয়ার্ড দিতে হবে</div>
      </div>

      <div class="row-opts">
        <label class="chk-label"><input type="checkbox" name="remember"> আমাকে মনে রাখুন</label>
        <a href="#" class="forgot">পাসওয়ার্ড ভুলে গেছেন?</a>
      </div>

      <button type="submit" class="btn-login" id="submitBtn">লগইন করুন &nbsp;→</button>
    </form>

    <div class="divider"><span>অথবা</span></div>
    <div class="card-foot">অ্যাকাউন্ট নেই? &nbsp;<a href="#">অ্যাডমিনের সাথে যোগাযোগ করুন</a></div>
  </div>

  <div class="bottom-bar">© 2025 SOJAG AI &nbsp;·&nbsp; Powered by De Jure Academy &nbsp;·&nbsp; Bangladesh</div>
</div>

<script>
/* Circuit board background */
(function () {
  var cvs = document.getElementById('cvs');
  var ctx = cvs.getContext('2d');
  var W, H, nodes = [], lines = [];
  var ORANGE = '#F5821E', CYAN = '#00CAFF';

  function buildGraph() {
    nodes = []; lines = [];
    var cols = Math.ceil(W / 110) + 1, rows = Math.ceil(H / 110) + 1;
    for (var c = 0; c < cols; c++) {
      for (var r = 0; r < rows; r++) {
        if (Math.random() < .55) {
          nodes.push({
            x: c * 110 + (Math.random() - .5) * 55,
            y: r * 110 + (Math.random() - .5) * 55,
            r: Math.random() * 1.8 + 1,
            ph: Math.random() * Math.PI * 2,
            color: c < cols / 2 ? ORANGE : CYAN,
            speed: .018 + Math.random() * .012,
          });
        }
      }
    }
    nodes.forEach(function (a, i) {
      nodes.slice(i + 1).forEach(function (b) {
        var dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
        if (d < 165 && Math.random() < .45) {
          var ex = Math.random() < .5 ? a.x : b.x;
          var ey = Math.random() < .5 ? a.y : b.y;
          lines.push({ a: a, b: b, ex: ex, ey: ey, color: a.color, alpha: (1 - d / 165) * .18 });
        }
      });
    });
  }

  function resize() {
    W = cvs.width = window.innerWidth;
    H = cvs.height = window.innerHeight;
    buildGraph();
  }

  function draw() {
    ctx.clearRect(0, 0, W, H);
    var bg = ctx.createRadialGradient(W*.5, H*.4, 0, W*.5, H*.5, Math.max(W,H)*.8);
    bg.addColorStop(0, '#0E1F38'); bg.addColorStop(1, '#060C18');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    lines.forEach(function (l) {
      ctx.beginPath();
      ctx.moveTo(l.a.x, l.a.y);
      ctx.lineTo(l.ex, l.ey === l.a.y ? l.a.y : l.ey);
      ctx.lineTo(l.b.x, l.b.y);
      ctx.strokeStyle = l.color === ORANGE ? 'rgba(245,130,30,' + l.alpha + ')' : 'rgba(0,202,255,' + l.alpha + ')';
      ctx.lineWidth = 1; ctx.stroke();
    });
    nodes.forEach(function (n) {
      n.ph += n.speed;
      var glow = .45 + Math.sin(n.ph) * .2;
      var g = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, 9);
      var isO = n.color === ORANGE;
      g.addColorStop(0, isO ? 'rgba(245,130,30,' + (glow*.6) + ')' : 'rgba(0,202,255,' + (glow*.6) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(n.x - 9, n.y - 9, 18, 18);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + Math.sin(n.ph) * .4, 0, Math.PI * 2);
      ctx.fillStyle = n.color; ctx.globalAlpha = glow + .15; ctx.fill(); ctx.globalAlpha = 1;
    });
    requestAnimationFrame(draw);
  }

  window.addEventListener('resize', resize);
  resize();
  draw();
})();

/* Password toggle */
document.getElementById('pwToggle').addEventListener('click', function () {
  var inp = document.getElementById('password'), icon = document.getElementById('eyeIcon');
  if (inp.type === 'password') { inp.type = 'text'; icon.classList.replace('fa-eye', 'fa-eye-slash'); }
  else { inp.type = 'password'; icon.classList.replace('fa-eye-slash', 'fa-eye'); }
});

/* Client-side validation, then let the form submit normally to the server */
document.getElementById('loginForm').addEventListener('submit', function (e) {
  var userVal = document.getElementById('username').value.trim();
  var passVal = document.getElementById('password').value.trim();
  var fUser = document.getElementById('f-user'), fPass = document.getElementById('f-pass');
  fUser.classList.remove('has-error'); fPass.classList.remove('has-error');
  var ok = true;
  if (!userVal) { fUser.classList.add('has-error'); ok = false; }
  if (!passVal) { fPass.classList.add('has-error'); ok = false; }
  if (!ok) { e.preventDefault(); return; }
  var btn = document.getElementById('submitBtn');
  btn.disabled = true;
  btn.textContent = '⏳  লগইন হচ্ছে...';
  /* no preventDefault — the browser submits the form to /login */
});
</script>
</body></html>`;
}

// Render one course row. `cols` is the category's extra columns: [{ k, name }, ...].
function courseRow(ci, ri, course = {}, cols = []) {
  const path = `categories[${ci}][courses][${ri}]`;
  const cell = (mode) => {
    const p = course[mode] ?? {};
    return `<td class="col-num"><div class="price-pair">
      <input type="text" name="${path}[${mode}][offer]" value="${esc(p.offer)}" placeholder="offer">
      <span class="sep">/</span>
      <input type="text" name="${path}[${mode}][regular]" value="${esc(p.regular)}" placeholder="reg">
    </div></td>`;
  };
  // Extra cells carry the column's key in data-col so the browser can add/remove columns by key.
  const extraCells = cols
    .map(
      (col) =>
        `<td data-col="${col.k}"><input type="text" name="${path}[extra][${col.k}]" value="${esc(course.extra?.[col.k])}" placeholder="—"></td>`
    )
    .join("");
  return `<tr data-row="${ri}">
    <td class="col-name"><input type="text" name="${path}[name]" value="${esc(course.name)}" placeholder="Course name"></td>
    ${cell("online")}${cell("offline")}${cell("onlineOffline")}
    <td><input type="text" name="${path}[duration]" value="${esc(course.duration)}" placeholder="e.g. 6 mo"></td>
    <td><input type="text" name="${path}[starts]" value="${esc(course.starts)}" placeholder="YYYY-MM-DD"></td>
    ${extraCells}
    <td><button type="button" class="icon-btn" title="Remove course" onclick="this.closest('tr').remove()">✕</button></td>
  </tr>`;
}

function categoryTable(ci, cat) {
  // Stored as a clean array, so the column key is simply its index.
  const cols = (cat.extraColumns ?? []).map((name, k) => ({ k, name }));
  const courses = cat.courses ?? [];
  const rows = courses.map((course, ri) => courseRow(ci, ri, course, cols)).join("\n");
  const extraHeads = cols
    .map(
      (col) =>
        `<th class="extra-col" data-col="${col.k}"><div class="col-head">
      <input type="text" name="categories[${ci}][extraColumns][${col.k}]" value="${esc(col.name)}" placeholder="Column name">
      <button type="button" class="col-del" title="Remove column" onclick="removeColumn(${ci}, ${col.k})">✕</button>
    </div></th>`
    )
    .join("");
  // Rows/columns added in the browser start their index above the existing count.
  return `<section class="card">
  <h2>${esc(cat.name)}</h2>
  <p class="hint">Prices are in BDT. Enter the offer price first, then the regular price (leave blank if there's no discount or the mode isn't offered). Use “+ Add column” for any extra detail (e.g. class days, instructor).</p>
  <input type="hidden" name="categories[${ci}][name]" value="${esc(cat.name)}">
  <div class="table-wrap"><table><thead><tr>
    <th>Course</th><th>Online · offer / reg</th><th>Offline</th><th>Online+Offline</th>
    <th>Duration</th><th>Starts</th>${extraHeads}<th></th>
  </tr></thead>
  <tbody data-cat="${ci}" data-next="${courses.length}" data-nextcol="${cols.length}">
  ${rows}
  </tbody></table></div>
  <div class="table-actions">
    <button type="button" class="add-row" onclick="addRow(${ci})">+ Add course</button>
    <button type="button" class="add-row" onclick="addColumn(${ci})">+ Add column</button>
  </div>
  </section>`;
}

// One admin-defined free-form section: an editable title + a markdown body.
function customSectionCard(i, section = {}) {
  const path = `customSections[${i}]`;
  return `<section class="card custom-section" data-section="${i}">
  <div class="custom-head">
    <input type="text" class="custom-title" name="${path}[title]" value="${esc(section.title)}"
      placeholder="Section title (e.g. Lead messages, FAQ, Promotions)">
    <button type="button" class="icon-btn" title="Remove section" onclick="this.closest('.custom-section').remove()">✕</button>
  </div>
  <p class="hint">Markdown. The bot uses this as part of its knowledge base, exactly as written.</p>
  <textarea name="${path}[body]" placeholder="Write this section's content here…">${esc(section.body)}</textarea>
</section>`;
}

// One admin-defined prompt scenario: an editable title + a markdown body, appended to the
// system prompt so the AI follows it (example conversations, "when X do Y" guidance).
function scenarioCard(i, section = {}) {
  const path = `promptSections[${i}]`;
  return `<section class="card scenario-section" data-section="${i}">
  <div class="custom-head">
    <input type="text" class="custom-title" name="${path}[title]" value="${esc(section.title)}"
      placeholder="Scenario title (e.g. Example lead, Refund question)">
    <button type="button" class="icon-btn" title="Remove scenario" onclick="this.closest('.scenario-section').remove()">✕</button>
  </div>
  <p class="hint">Markdown, added to the system prompt. Great for an example conversation or a “when a customer does X, respond with Y” rule.</p>
  <textarea name="${path}[body]" placeholder="e.g. When a customer wants to enroll, warmly ask for their name and phone number, then…">${esc(section.body)}</textarea>
</section>`;
}

// Shared document head (fonts + styles). `title` shows in the browser tab.
function pageHead(title) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} — De Jure Academy</title>
<link href="https://fonts.googleapis.com/css2?family=Hind+Siliguri:wght@300;400;500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>${PAGE_STYLE}</style></head>
<body>`;
}

// Shared sidebar shown on both admin pages. `active` is "kb" or "prompt". Knowledge-base
// links are in-page anchors on the KB page and full links to the root ("/") from elsewhere, so
// the nav works the same from either page.
function renderSidebar(active, csrf) {
  const kbLink = (anchor, label) =>
    `<a href="${active === "kb" ? "#" + anchor : "/#" + anchor}">${label}</a>`;
  return `<aside class="sidebar">
  <div class="brand">
    <div class="mark">🧠</div>
    <div>
      <div class="brand-name">SOJAG <span class="ai">AI</span></div>
      <div class="brand-sub">De Jure Academy</div>
    </div>
  </div>
  <nav class="nav">
    <a href="/system-prompt"${active === "prompt" ? ' class="nav-active"' : ""}>Bot behaviour</a>${
    active === "prompt"
      ? `\n    <a class="nav-sub" href="#sec-prompt">System prompt</a>\n    <a class="nav-sub" href="#sec-rules">Answering rules</a>\n    <a class="nav-sub" href="#sec-scenarios">Examples &amp; scenarios</a>\n    <a class="nav-sub" href="#sec-lead">Lead capture</a>`
      : ""
  }
    <div class="nav-label">Knowledge base</div>
    ${kbLink("sec-about", "About")}
    ${kbLink("sec-contact", "Contact")}
    ${kbLink("sec-courses", "Courses")}
    ${kbLink("sec-books", "Books &amp; products")}
    ${kbLink("sec-enroll", "Enrollment")}
    ${kbLink("sec-custom", "Custom sections")}
  </nav>
  <div class="nav-foot">
    <form method="post" action="/logout">
      <input type="hidden" name="_csrf" value="${esc(csrf)}">
      <button type="submit" class="btn-ghost">Log out</button>
    </form>
  </div>
</aside>`;
}

// The "Bot behaviour" page: the system prompt + the examples & scenarios that shape how the bot
// replies, on one page with a single Save. Kept separate from the knowledge-base facts. The
// prompt lives in system_prompt.txt; scenarios in prompt_sections.json.
function botVoicePage(promptText, promptSections, leadCapture, answeringRules, { csrf, saved } = {}) {
  const sections = promptSections ?? [];
  const scenarioCards = sections.map((s, i) => scenarioCard(i, s)).join("\n");
  const lead = leadCapture ?? {};

  return `${pageHead("Bot behaviour")}
<div class="layout">
${renderSidebar("prompt", csrf)}
<main class="main">
<h1 class="page-title">Bot behaviour</h1>
<p class="lede">How the bot replies: its <strong>system prompt</strong> (core instructions for the AI) and <strong>examples &amp; scenarios</strong> (guidance for specific situations — like collecting a lead). The AI writes every reply from these; the <a href="/">knowledge base</a> — the facts — lives separately. Changes take effect for new replies as soon as you save — no restart needed.</p>
${saved ? `<div class="flash">Saved. The bot is now using the updated settings.</div>` : ""}

<form method="post" action="/system-prompt">
<input type="hidden" name="_csrf" value="${esc(csrf)}">

<section class="card" id="sec-prompt">
  <h2>System prompt</h2>
  <p class="hint">The core instructions sent to the AI on every message. The knowledge base is appended automatically, so don't paste facts here. Leave blank to restore the built-in default (shown as the placeholder).</p>
  <textarea id="systemPrompt" name="systemPrompt" class="prompt-input" placeholder="${esc(DEFAULT_SYSTEM_PROMPT)}">${esc(promptText)}</textarea>
</section>

<section class="card" id="sec-rules">
  <h2>Answering rules</h2>
  <p class="hint">Do's and don'ts the bot always follows (e.g. never invent prices, always reply in Bengali). Added to the prompt as instructions. Markdown. Leave blank to restore the default (shown as placeholder).</p>
  <textarea id="answeringRules" name="answeringRules" placeholder="${esc(DEFAULT_ANSWERING_RULES)}">${esc(answeringRules)}</textarea>
</section>

<div id="sec-scenarios">
  <h2 class="group-head">Examples &amp; scenarios</h2>
  <p class="group-sub">Free-form guidance appended to the system prompt. Use it for an example lead conversation, or a “when a customer does X, respond with Y” rule — the bot follows these instead of relying on fixed canned replies.</p>
  <div class="scenario-list" data-next="${sections.length}">
  ${scenarioCards}
  </div>
  <p class="custom-empty"${sections.length ? ' style="display:none"' : ""}>No scenarios yet. Add an example lead, a refund-question playbook, or any “when X, do Y” rule — the bot will follow it.</p>
  <button type="button" class="add-row" onclick="addScenario()">+ Add scenario</button>
</div>

<section class="card" id="sec-lead">
  <h2>Lead capture</h2>
  <p class="hint">How and when the bot collects a customer's contact details. It asks them to send their name + phone, then a <code>save_lead</code> tool saves it to your Sheet/Telegram (the phone is validated in code). Only used when lead capture is configured. Leave the instruction blank to restore the default (shown as placeholder).</p>
  <label for="leadInstruction">Lead-capture instruction (added to the prompt)</label>
  <textarea id="leadInstruction" name="leadInstruction" placeholder="${esc(DEFAULT_LEAD_INSTRUCTION)}">${esc(lead.instruction)}</textarea>
  <label for="leadAskAfterTurns">Proactively ask after this many messages</label>
  <input type="number" id="leadAskAfterTurns" name="leadAskAfterTurns" min="1" max="20" value="${esc(lead.askAfterTurns)}" style="max-width:130px">
  <p class="hint" style="margin-top:6px">The bot also asks sooner if it senses clear intent — this is the backstop. Default ${DEFAULT_ASK_AFTER_TURNS}.</p>
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
function addScenario() {
  var list = document.querySelector('#sec-scenarios .scenario-list');
  var i = parseInt(list.getAttribute('data-next'), 10);
  list.setAttribute('data-next', i + 1);
  var path = 'promptSections[' + i + ']';
  var sec = document.createElement('section');
  sec.className = 'card scenario-section';
  sec.setAttribute('data-section', i);
  sec.innerHTML =
    '<div class="custom-head">' +
      '<input type="text" class="custom-title" name="' + path + '[title]" placeholder="Scenario title (e.g. Example lead, Refund question)">' +
      '<button type="button" class="icon-btn" title="Remove scenario" onclick="this.closest(\\'.scenario-section\\').remove()">✕</button>' +
    '</div>' +
    '<p class="hint">Markdown, added to the system prompt so the AI follows it.</p>' +
    '<textarea name="' + path + '[body]" placeholder="e.g. When a customer wants to enroll, ask for their name and phone…"></textarea>';
  list.appendChild(sec);
  var empty = document.querySelector('#sec-scenarios .custom-empty');
  if (empty) empty.style.display = 'none';
  sec.querySelector('input').focus();
}
</script>
</body></html>`;
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
  const customSections = kb.customSections ?? [];
  const customCards = customSections.map((s, i) => customSectionCard(i, s)).join("\n");

  return `${pageHead("Knowledge Base")}
<div class="layout">
${renderSidebar("kb", csrf)}

<main class="main">
<h1 class="page-title">Knowledge Base</h1>
<p class="lede">The facts the bot answers from. Its core instructions live separately under <a href="/system-prompt">System prompt</a>. Changes take effect for new replies as soon as you save — no restart needed.</p>
${saved ? `<div class="flash">Saved. The bot is now using the updated knowledge base.</div>` : ""}

<form method="post" action="/save">
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

<div id="sec-custom">
  <div class="custom-list" data-next="${customSections.length}">
  ${customCards}
  </div>
  <p class="custom-empty"${customSections.length ? ' style="display:none"' : ""}>
    No custom sections yet. Add one for anything not covered above — lead messages, FAQs, promotions, policies — and the bot will use it.
  </p>
  <button type="button" class="add-row" onclick="addSection()">+ Add section</button>
</div>


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
function tableFor(ci) {
  return document.querySelector('tbody[data-cat="' + ci + '"]').closest('table');
}
// Current extra-column keys for a category, in display order.
function currentCols(ci) {
  var cols = [];
  tableFor(ci).querySelectorAll('thead th.extra-col').forEach(function (th) {
    cols.push(th.getAttribute('data-col'));
  });
  return cols;
}
function addRow(ci) {
  var tbody = document.querySelector('tbody[data-cat="' + ci + '"]');
  var ri = parseInt(tbody.getAttribute('data-next'), 10);
  tbody.setAttribute('data-next', ri + 1);
  var path = 'categories[' + ci + '][courses][' + ri + ']';
  var extra = currentCols(ci).map(function (k) {
    return '<td data-col="' + k + '"><input type="text" name="' + path + '[extra][' + k + ']" placeholder="—"></td>';
  }).join('');
  var tr = document.createElement('tr');
  tr.setAttribute('data-row', ri);
  tr.innerHTML =
    '<td class="col-name"><input type="text" name="' + path + '[name]" placeholder="Course name"></td>' +
    priceCell(path, 'online') + priceCell(path, 'offline') + priceCell(path, 'onlineOffline') +
    '<td><input type="text" name="' + path + '[duration]" placeholder="e.g. 6 mo"></td>' +
    '<td><input type="text" name="' + path + '[starts]" placeholder="YYYY-MM-DD"></td>' +
    extra +
    '<td><button type="button" class="icon-btn" title="Remove course" onclick="this.closest(\\'tr\\').remove()">✕</button></td>';
  tbody.appendChild(tr);
  tr.querySelector('input').focus();
}
function addColumn(ci) {
  var table = tableFor(ci);
  var tbody = table.querySelector('tbody');
  var k = parseInt(tbody.getAttribute('data-nextcol'), 10);
  tbody.setAttribute('data-nextcol', k + 1);
  // New header cell (sits before the trailing empty <th> used for the remove-row button).
  var headRow = table.querySelector('thead tr');
  var th = document.createElement('th');
  th.className = 'extra-col';
  th.setAttribute('data-col', k);
  th.innerHTML = '<div class="col-head">' +
    '<input type="text" name="categories[' + ci + '][extraColumns][' + k + ']" placeholder="Column name">' +
    '<button type="button" class="col-del" title="Remove column" onclick="removeColumn(' + ci + ',' + k + ')">✕</button>' +
    '</div>';
  headRow.insertBefore(th, headRow.lastElementChild);
  // Matching cell on every existing row.
  tbody.querySelectorAll('tr').forEach(function (tr) {
    var ri = tr.getAttribute('data-row');
    var td = document.createElement('td');
    td.setAttribute('data-col', k);
    td.innerHTML = '<input type="text" name="categories[' + ci + '][courses][' + ri + '][extra][' + k + ']" placeholder="—">';
    tr.insertBefore(td, tr.lastElementChild);
  });
  th.querySelector('input').focus();
}
function removeColumn(ci, k) {
  var table = tableFor(ci);
  var th = table.querySelector('thead th[data-col="' + k + '"]');
  if (th) th.remove();
  table.querySelectorAll('tbody td[data-col="' + k + '"]').forEach(function (td) { td.remove(); });
}
function addSection() {
  var list = document.querySelector('#sec-custom .custom-list');
  var i = parseInt(list.getAttribute('data-next'), 10);
  list.setAttribute('data-next', i + 1);
  var path = 'customSections[' + i + ']';
  var sec = document.createElement('section');
  sec.className = 'card custom-section';
  sec.setAttribute('data-section', i);
  sec.innerHTML =
    '<div class="custom-head">' +
      '<input type="text" class="custom-title" name="' + path + '[title]" placeholder="Section title (e.g. Lead messages, FAQ, Promotions)">' +
      '<button type="button" class="icon-btn" title="Remove section" onclick="this.closest(\\'.custom-section\\').remove()">✕</button>' +
    '</div>' +
    '<p class="hint">Markdown. The bot uses this as part of its knowledge base, exactly as written.</p>' +
    '<textarea name="' + path + '[body]" placeholder="Write this section\\'s content here…"></textarea>';
  list.appendChild(sec);
  var empty = document.querySelector('#sec-custom .custom-empty');
  if (empty) empty.style.display = 'none';
  sec.querySelector('input').focus();
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

// Turn a save failure into a clear, actionable page instead of Express's blank
// "Internal Server Error". The usual culprit in production is a filesystem permission
// error: the mounted data files aren't writable by the container's user (uid 1000).
function sendSaveError(res, err) {
  console.error("Admin save failed:", err);
  const permission = err && (err.code === "EACCES" || err.code === "EROFS" || err.code === "EPERM");
  const detail = permission
    ? `The bot couldn't write to its data files${err.path ? ` (“${err.path}”)` : ""}. ` +
      `This is a permissions issue on the server, not your edit. On the server, in the project ` +
      `directory, make the mounted files writable by the container user and try again:`
    : (err && err.message) || "Unknown error while saving.";
  const fix = "sudo chown -R 1000:1000 data knowledge_base.json knowledge_base.md";
  res
    .status(500)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Couldn't save</title>` +
        `<body style="font-family:system-ui,sans-serif;max-width:660px;margin:48px auto;padding:0 18px;color:#1a2433">` +
        `<h1 style="font-size:20px">Couldn't save your changes</h1>` +
        `<p>${esc(detail)}</p>` +
        (permission
          ? `<pre style="background:#f3f5f8;padding:12px 14px;border-radius:8px;overflow:auto">${esc(fix)}</pre>`
          : "") +
        `<p><a href="javascript:history.back()">← Go back</a></p></body>`
    );
}

function price(p) {
  return { offer: (p?.offer ?? "").trim(), regular: (p?.regular ?? "").trim() };
}

// Like toArray, but keeps each item's original (possibly sparse) key alongside its value.
// Columns are sparse after one is removed in the browser, so we read each course's value
// from the SAME key as its header to keep them aligned.
function orderedEntries(x) {
  if (Array.isArray(x)) return x.map((v, i) => [String(i), v]);
  if (x && typeof x === "object") {
    return Object.keys(x)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => [k, x[k]]);
  }
  return [];
}

function readExtra(extra, k) {
  if (Array.isArray(extra)) return extra[Number(k)];
  if (extra && typeof extra === "object") return extra[k];
  return "";
}

function formToKb(body) {
  const categories = toArray(body.categories).map((cat) => {
    // Keep only columns with a non-empty header; remember their keys to align course values.
    const colEntries = orderedEntries(cat.extraColumns)
      .map(([k, name]) => [k, (name ?? "").trim()])
      .filter(([, name]) => name);
    const colKeys = colEntries.map(([k]) => k);
    const extraColumns = colEntries.map(([, name]) => name);

    return {
      name: (cat.name ?? "").trim(),
      extraColumns,
      courses: toArray(cat.courses)
        .map((course) => ({
          name: (course.name ?? "").trim(),
          duration: (course.duration ?? "").trim(),
          starts: (course.starts ?? "").trim(),
          online: price(course.online),
          offline: price(course.offline),
          onlineOffline: price(course.onlineOffline),
          // Stored as a clean array aligned to extraColumns by index.
          extra: colKeys.map((k) => (readExtra(course.extra, k) ?? "").trim()),
        }))
        // Drop fully-empty rows the admin added but left blank.
        .filter((course) => course.name),
    };
  });

  // Admin-added free-form sections: keep title (trimmed) + raw markdown body.
  // Drop any the admin added but left entirely blank.
  const customSections = toArray(body.customSections)
    .map((s) => ({ title: (s?.title ?? "").trim(), body: s?.body ?? "" }))
    .filter((s) => s.title || s.body.trim());

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
    customSections,
  };
}

// --- Router factory ---
// `onSaved` is called after a successful save so the server can hot-reload the prompt.
export function createAdminRouter({ adminUsername, adminPassword, sessionSecret, onSaved }) {
  const router = express.Router();

  const requireAuth = (req, res, next) => {
    const cookies = parseCookies(req.headers.cookie);
    const session = verifySession(sessionSecret, cookies[COOKIE_NAME]);
    if (!session) return res.redirect("/login");
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
    if (verifySession(sessionSecret, cookies[COOKIE_NAME])) return res.redirect("/");
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
      path: "/",
    });
    res.redirect("/");
  });

  router.post("/logout", requireAuth, requireCsrf, (req, res) => {
    res.clearCookie(COOKIE_NAME, { path: "/" });
    res.redirect("/login");
  });

  router.get("/", requireAuth, (req, res) => {
    const csrf = csrfToken(sessionSecret, req.sessionValue);
    res.type("html").send(editorPage(loadKb(), { csrf, saved: req.query.saved === "1" }));
  });

  router.post("/save", requireAuth, requireCsrf, (req, res) => {
    try {
      const kb = formToKb(req.body ?? {});
      saveKb(kb);
      if (typeof onSaved === "function") onSaved();
      res.redirect("/?saved=1");
    } catch (err) {
      sendSaveError(res, err);
    }
  });

  // The bot's voice — system prompt + scripted messages — on its own page, each in its own
  // file, separate from the knowledge base.
  router.get("/system-prompt", requireAuth, (req, res) => {
    const csrf = csrfToken(sessionSecret, req.sessionValue);
    res.type("html").send(
      botVoicePage(loadSystemPrompt(), loadPromptSections(), loadLeadCapture(), loadAnsweringRules(), {
        csrf,
        saved: req.query.saved === "1",
      })
    );
  });

  router.post("/system-prompt", requireAuth, requireCsrf, (req, res) => {
    try {
      saveSystemPrompt(req.body?.systemPrompt ?? "");
      savePromptSections(toArray(req.body?.promptSections));
      saveLeadCapture({
        instruction: req.body?.leadInstruction ?? "",
        askAfterTurns: req.body?.leadAskAfterTurns,
      });
      saveAnsweringRules(req.body?.answeringRules ?? "");
      if (typeof onSaved === "function") onSaved();
      res.redirect("/system-prompt?saved=1");
    } catch (err) {
      sendSaveError(res, err);
    }
  });

  return router;
}
