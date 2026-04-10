(function() {
"use strict";

/* ─── CONFIG ─────────────────────────────────────────────────
   Priority: window.__LUNA_CONFIG > data-* attributes on script tag > defaults
   ──────────────────────────────────────────────────────────── */
var scriptTag = document.currentScript || document.querySelector('script[src*="widget-core"]');
function attr(name) { return scriptTag && scriptTag.getAttribute("data-" + name); }

var D = {
  name: "Luna AI",
  tagline: "AI ASSISTANT",
  logoText: "L",
  welcome: "Hey there! I'm Luna, your AI assistant. How can I help you today?",
  hints: ["How much does it cost?","What do I get with Ignite?","Do you integrate with Jet2?","What is Travelify?"],
  collectName: true,
  namePrompt: "Before we start, what's your name?",
  skipLabel: "Skip",
  escalateLabel: "Talk to a human",
  leaveLabel: "Leave a message",
  footer: "Powered by Luna AI",
  endpoint: "https://luna-chat-endpoint.vercel.app/api/luna-chat",
  clientName: "Travelgenix",
  ablyKey: "3FpMVA.yN0QIQ:QPBUpoTRGPQkTMkB0GMADarQE96XgRbkRs7C030bxTw",
  airtableKey: "",
  airtableBase: "",
  convTable: "",
  bg: "#1C1C1E",
  headerBg: "#2C2C2E",
  bubbleBg: "#2C2C2E",
  userBubble: "#0A84FF",
  userText: "#FFFFFF",
  botText: "#E5E5EA",
  mutedText: "#8E8E93",
  accent: "#0A84FF",
  accentGlow: "#64D2FF",
  border: "rgba(255,255,255,0.08)",
  inputBg: "#2C2C2E",
  inputText: "#FFFFFF",
  buttonBg: "#0A84FF",
  buttonText: "#FFFFFF",
  pillBg: "rgba(10,132,255,0.12)",
  pillBorder: "rgba(10,132,255,0.3)",
  pillText: "#64D2FF",
  overlayBg: "rgba(0,0,0,0.7)",
  fabBg: "linear-gradient(135deg,#0A84FF,#5E5CE6)",
  fabSize: "60px",
  panelW: "380px",
  panelH: "600px",
  radius: "20px",
  position: "right",
  mobileBubble: "normal"
};

/* Merge phase 1: window config > data-attrs > defaults */
var W = (typeof window.__LUNA_CONFIG === "object") ? window.__LUNA_CONFIG : {};
var C = {};
function rebuildConfig(apiConfig) {
  /* Priority: API config > window.__LUNA_CONFIG > data-attrs > defaults */
  var A = apiConfig || {};
  Object.keys(D).forEach(function(k) {
    C[k] = A[k] !== undefined ? A[k] : (W[k] !== undefined ? W[k] : (attr(k) || D[k]));
  });
  /* Map API theme fields onto widget config keys */
  if (A.theme) {
    var t = A.theme;
    if (t.bg) C.bg = t.bg;
    if (t.headerBg) C.headerBg = t.headerBg;
    if (t.bubbleBg) C.bubbleBg = t.bubbleBg;
    if (t.userBubble) C.userBubble = t.userBubble;
    if (t.userText) C.userText = t.userText;
    if (t.botText) C.botText = t.botText;
    if (t.mutedText) C.mutedText = t.mutedText;
    if (t.accent) C.accent = t.accent;
    if (t.accentGlow) C.accentGlow = t.accentGlow;
    if (t.border) C.border = t.border;
    if (t.inputBg) C.inputBg = t.inputBg;
    if (t.inputText) C.inputText = t.inputText;
    if (t.buttonBg) C.buttonBg = t.buttonBg;
    if (t.buttonText) C.buttonText = t.buttonText;
    if (t.pillBg) C.pillBg = t.pillBg;
    if (t.pillBorder) C.pillBorder = t.pillBorder;
    if (t.pillText) C.pillText = t.pillText;
    if (t.fabBg) C.fabBg = t.fabBg;
    if (t.radius) C.radius = t.radius;
  }
  /* Map API size fields */
  if (A.size) {
    if (A.size.panelW) C.panelW = A.size.panelW;
    if (A.size.panelH) C.panelH = A.size.panelH;
    if (A.size.fabSize) C.fabSize = A.size.fabSize;
    if (A.size.radius) C.radius = A.size.radius;
  }
  /* Map position and mobileBubble */
  if (A.position) C.position = A.position;
  if (A.mobileBubble) C.mobileBubble = A.mobileBubble;
  /* Map autoTrigger */
  if (A.autoTrigger) C.autoTrigger = A.autoTrigger;
  /* Map privacyUrl */
  if (A.privacyUrl) C.privacyUrl = A.privacyUrl;
  /* hints might be a JSON string from data-attr */
  if (typeof C.hints === "string") {
    try { C.hints = JSON.parse(C.hints); } catch(e) { C.hints = D.hints; }
  }
  if (typeof C.collectName === "string") C.collectName = C.collectName === "true";
}
rebuildConfig(null); /* initial merge without API */

/* ─── STATE ──────────────────────────────────────────────── */
var msgs = [];
var history = [];
var userName = "";
var visitorEmail = "";
var marketingConsent = false;
var panelOpen = false;
var nameCollected = false;
var convId = null;
var convStarted = false;
var liveMode = false;
var unread = 0;
var typingTimeout = null;
var ably = null;
var dashChannel = null;
var chatChannel = null;
var visitorCountry = "";
var visitorId = "";
var autoTriggerTimer = null;
var autoTriggered = false;
var visitorInteracted = false;

/* ─── AUTO-TRIGGER HELPERS ───────────────────────────────── */
function cancelAutoTrigger() {
  if (autoTriggerTimer) {
    clearTimeout(autoTriggerTimer);
    autoTriggerTimer = null;
  }
  visitorInteracted = true;
}

function playNotifSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.frequency.value = 880;
    osc.type = "sine";
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.3);
  } catch(e) { /* silent fallback */ }
}

/* ─── LOAD ABLY SDK ──────────────────────────────────────── */
function loadAbly(cb) {
  if (window.Ably) return cb();
  var s = document.createElement("script");
  s.src = "https://cdn.ably.com/lib/ably.min-2.js";
  s.onload = cb;
  s.onerror = function() { console.error("Luna widget: failed to load Ably SDK"); cb(); };
  document.head.appendChild(s);
}

/* ─── INJECT CSS ─────────────────────────────────────────── */
function injectCSS() {
  var s = document.createElement("style");
  s.id = "tgx-cw-styles";
  var isLeft = C.position === "left";
  var fabSide = isLeft ? "left:24px!important" : "right:24px!important";
  var panelSide = isLeft ? "left:24px!important" : "right:24px!important";
  var badgeSide = isLeft ? "right:-4px!important;left:auto!important" : "right:-4px!important";
  s.textContent = '#tgx-cw *{box-sizing:border-box!important;margin:0!important;padding:0!important;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","SF Pro Display","Helvetica Neue",Helvetica,Arial,sans-serif!important;-webkit-font-smoothing:antialiased!important}'
  +'#tgx-cw .tgx-fab{position:fixed!important;bottom:24px!important;'+fabSide+';width:'+C.fabSize+'!important;height:'+C.fabSize+'!important;border-radius:50%!important;background:'+C.fabBg+'!important;border:none!important;cursor:pointer!important;z-index:999998!important;display:flex!important;align-items:center!important;justify-content:center!important;box-shadow:0 4px 24px rgba(0,0,0,0.4)!important;transition:transform .2s cubic-bezier(.4,0,.2,1),box-shadow .2s!important}'
  +'#tgx-cw .tgx-fab:hover{transform:scale(1.08)!important;box-shadow:0 6px 32px rgba(0,0,0,0.5)!important}'
  +'#tgx-cw .tgx-fab svg{width:28px!important;height:28px!important;fill:'+C.buttonText+'!important;transition:transform .3s!important}'
  +'#tgx-cw .tgx-fab.open svg{transform:rotate(90deg)!important}'
  +'#tgx-cw .tgx-badge{position:absolute!important;top:-4px!important;'+badgeSide+';min-width:20px!important;height:20px!important;border-radius:10px!important;background:#FF453A!important;color:#fff!important;font-size:11px!important;font-weight:700!important;display:none!important;align-items:center!important;justify-content:center!important;padding:0 5px!important}'
  +'#tgx-cw .tgx-panel{position:fixed!important;bottom:96px!important;'+panelSide+';width:'+C.panelW+'!important;height:'+C.panelH+'!important;max-height:calc(100vh - 120px)!important;background:'+C.bg+'!important;border-radius:'+C.radius+'!important;border:1px solid '+C.border+'!important;box-shadow:0 20px 60px rgba(0,0,0,0.3)!important;display:flex!important;flex-direction:column!important;overflow:hidden!important;z-index:999999!important;opacity:0!important;visibility:hidden!important;transform:translateY(12px) scale(0.97)!important;transition:opacity .25s cubic-bezier(.4,0,.2,1),transform .25s cubic-bezier(.4,0,.2,1),visibility .25s!important}'
  +'#tgx-cw .tgx-panel.open{opacity:1!important;visibility:visible!important;transform:translateY(0) scale(1)!important}'
  +'#tgx-cw .tgx-hdr{background:'+C.headerBg+'!important;padding:16px 18px!important;display:flex!important;align-items:center!important;gap:12px!important;border-bottom:1px solid '+C.border+'!important;flex-shrink:0!important}'
  +'#tgx-cw .tgx-logo{width:40px!important;height:40px!important;border-radius:12px!important;background:'+C.fabBg+'!important;display:flex!important;align-items:center!important;justify-content:center!important;color:'+C.buttonText+'!important;font-size:18px!important;font-weight:700!important;flex-shrink:0!important}'
  +'#tgx-cw .tgx-hdr-text{flex:1!important}'
  +'#tgx-cw .tgx-hdr-name{color:'+C.botText+'!important;font-size:15px!important;font-weight:600!important;line-height:1.3!important}'
  +'#tgx-cw .tgx-hdr-tag{color:'+C.accentGlow+'!important;font-size:10px!important;font-weight:600!important;letter-spacing:1.2px!important;text-transform:uppercase!important;line-height:1.4!important}'
  +'#tgx-cw .tgx-hdr-status{width:8px!important;height:8px!important;border-radius:50%!important;background:#30D158!important;flex-shrink:0!important;box-shadow:0 0 6px rgba(48,209,88,0.5)!important}'
  +'#tgx-cw .tgx-msgs{flex:1!important;overflow-y:auto!important;padding:16px!important;display:flex!important;flex-direction:column!important;gap:8px!important;scrollbar-width:thin!important;scrollbar-color:'+C.border+' transparent!important}'
  +'#tgx-cw .tgx-msgs::-webkit-scrollbar{width:4px!important}'
  +'#tgx-cw .tgx-msgs::-webkit-scrollbar-thumb{background:'+C.border+'!important;border-radius:2px!important}'
  +'#tgx-cw .tgx-msg{max-width:85%!important;padding:10px 14px!important;border-radius:16px!important;font-size:14px!important;line-height:1.5!important;animation:tgxFadeIn .2s ease!important;word-wrap:break-word!important}'
  +'#tgx-cw .tgx-msg.bot{align-self:flex-start!important;background:'+C.bubbleBg+'!important;color:'+C.botText+'!important;border-bottom-left-radius:6px!important}'
  +'#tgx-cw .tgx-msg.user{align-self:flex-end!important;background:'+C.userBubble+'!important;color:'+C.userText+'!important;border-bottom-right-radius:6px!important}'
  +'#tgx-cw .tgx-msg.agent{align-self:flex-start!important;background:#1A3A2A!important;color:#A8F0C6!important;border-bottom-left-radius:6px!important;border-left:2px solid #30D158!important}'
  +'#tgx-cw .tgx-msg.system{align-self:center!important;background:transparent!important;color:'+C.mutedText+'!important;font-size:12px!important;font-style:italic!important;padding:4px 0!important}'
  +'#tgx-cw .tgx-typing{align-self:flex-start!important;background:'+C.bubbleBg+'!important;padding:10px 18px!important;border-radius:16px!important;border-bottom-left-radius:6px!important;display:none!important}'
  +'#tgx-cw .tgx-typing span{display:inline-block!important;width:7px!important;height:7px!important;border-radius:50%!important;background:'+C.mutedText+'!important;margin:0 2px!important;animation:tgxDot 1.4s infinite!important}'
  +'#tgx-cw .tgx-typing span:nth-child(2){animation-delay:.2s!important}'
  +'#tgx-cw .tgx-typing span:nth-child(3){animation-delay:.4s!important}'
  +'@keyframes tgxDot{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1)}}'
  +'@keyframes tgxFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}'
  +'#tgx-cw .tgx-pills{display:flex!important;flex-wrap:wrap!important;gap:6px!important;padding:0 16px!important;margin-bottom:4px!important}'
  +'#tgx-cw .tgx-pill{background:'+C.pillBg+'!important;border:1px solid '+C.pillBorder+'!important;color:'+C.pillText+'!important;font-size:13px!important;padding:7px 14px!important;border-radius:20px!important;cursor:pointer!important;transition:background .15s,border-color .15s!important;line-height:1.3!important;text-align:left!important}'
  +'#tgx-cw .tgx-pill:hover{background:'+C.pillBg+'!important;border-color:'+C.accent+'!important;filter:brightness(1.2)!important}'
  +'#tgx-cw .tgx-input-wrap{padding:12px 16px!important;border-top:1px solid '+C.border+'!important;display:flex!important;gap:8px!important;align-items:center!important;background:'+C.bg+'!important;flex-shrink:0!important}'
  +'#tgx-cw .tgx-input{flex:1!important;background:'+C.inputBg+'!important;border:1px solid '+C.border+'!important;border-radius:22px!important;padding:10px 16px!important;color:'+C.inputText+'!important;font-size:14px!important;outline:none!important;transition:border-color .15s!important}'
  +'#tgx-cw .tgx-input:focus{border-color:'+C.accent+'!important}'
  +'#tgx-cw .tgx-input::placeholder{color:'+C.mutedText+'!important}'
  +'#tgx-cw .tgx-send{width:38px!important;height:38px!important;border-radius:50%!important;background:'+C.buttonBg+'!important;border:none!important;cursor:pointer!important;display:flex!important;align-items:center!important;justify-content:center!important;flex-shrink:0!important;transition:opacity .15s,transform .1s!important}'
  +'#tgx-cw .tgx-send:hover{opacity:.85!important}'
  +'#tgx-cw .tgx-send:active{transform:scale(.92)!important}'
  +'#tgx-cw .tgx-send svg{width:18px!important;height:18px!important;fill:'+C.buttonText+'!important}'
  +'#tgx-cw .tgx-esc-bar{display:flex!important;gap:8px!important;padding:8px 16px!important;border-top:1px solid '+C.border+'!important;flex-shrink:0!important}'
  +'#tgx-cw .tgx-esc-btn{flex:1!important;padding:9px 0!important;border-radius:12px!important;font-size:12px!important;font-weight:600!important;cursor:pointer!important;text-align:center!important;transition:opacity .15s!important;border:none!important}'
  +'#tgx-cw .tgx-esc-btn:hover{opacity:.8!important}'
  +'#tgx-cw .tgx-esc-btn.human{background:'+C.accent+'!important;color:'+C.buttonText+'!important}'
  +'#tgx-cw .tgx-esc-btn.leave{background:'+C.inputBg+'!important;color:'+C.mutedText+'!important;border:1px solid '+C.border+'!important}'
  +'#tgx-cw .tgx-overlay{position:absolute!important;inset:0!important;background:'+C.overlayBg+'!important;backdrop-filter:blur(8px)!important;-webkit-backdrop-filter:blur(8px)!important;display:flex!important;flex-direction:column!important;align-items:center!important;justify-content:center!important;padding:32px!important;z-index:10!important;border-radius:'+C.radius+'!important}'
  +'#tgx-cw .tgx-overlay h3{color:'+C.botText+'!important;font-size:18px!important;font-weight:600!important;margin-bottom:8px!important;text-align:center!important}'
  +'#tgx-cw .tgx-overlay p{color:'+C.mutedText+'!important;font-size:13px!important;margin-bottom:20px!important;text-align:center!important}'
  +'#tgx-cw .tgx-overlay input,#tgx-cw .tgx-overlay textarea{width:100%!important;background:'+C.inputBg+'!important;border:1px solid '+C.border+'!important;border-radius:12px!important;padding:11px 14px!important;color:'+C.inputText+'!important;font-size:14px!important;outline:none!important;margin-bottom:10px!important}'
  +'#tgx-cw .tgx-overlay textarea{height:80px!important;resize:none!important;font-family:inherit!important}'
  +'#tgx-cw .tgx-overlay .tgx-obtn{width:100%!important;padding:12px!important;border-radius:12px!important;background:'+C.accent+'!important;color:'+C.buttonText+'!important;font-size:14px!important;font-weight:600!important;border:none!important;cursor:pointer!important;margin-bottom:8px!important}'
  +'#tgx-cw .tgx-overlay .tgx-olink{background:none!important;border:none!important;color:'+C.accentGlow+'!important;font-size:13px!important;cursor:pointer!important;text-decoration:underline!important}'
  +'#tgx-cw .tgx-check{display:flex!important;align-items:flex-start!important;gap:8px!important;margin-bottom:14px!important;cursor:pointer!important;text-align:left!important}'
  +'#tgx-cw .tgx-check input[type="checkbox"]{width:16px!important;height:16px!important;margin-top:2px!important;accent-color:'+C.accent+'!important;cursor:pointer!important;flex-shrink:0!important}'
  +'#tgx-cw .tgx-check span{color:'+C.mutedText+'!important;font-size:12px!important;line-height:1.4!important}'
  +'#tgx-cw .tgx-privacy{display:block!important;margin-top:12px!important;color:'+C.mutedText+'!important;font-size:11px!important;text-decoration:none!important;transition:color .15s!important}'
  +'#tgx-cw .tgx-privacy:hover{color:'+C.accent+'!important;text-decoration:underline!important}'
  +'#tgx-cw .tgx-stars{display:flex!important;gap:8px!important;justify-content:center!important;margin-bottom:16px!important}'
  +'#tgx-cw .tgx-star{font-size:36px!important;color:'+C.mutedText+'!important;cursor:pointer!important;transition:color .15s,transform .15s!important;line-height:1!important}'
  +'#tgx-cw .tgx-footer{text-align:center!important;padding:6px!important;color:'+C.mutedText+'!important;font-size:10px!important;flex-shrink:0!important}'
  /* Mobile: panel always full-screen regardless of size config */
  var mobileCSS = '@media(max-width:440px){'
    +'#tgx-cw .tgx-panel{right:0!important;bottom:0!important;left:0!important;top:0!important;width:100vw!important;height:100vh!important;max-height:100vh!important;border-radius:0!important}'
    +'#tgx-cw .tgx-fab.open{display:none!important}';
  /* mobileBubble options */
  if (C.mobileBubble === "small") {
    mobileCSS += '#tgx-cw .tgx-fab{width:44px!important;height:44px!important;box-shadow:0 2px 12px rgba(0,0,0,0.3)!important}'
      +'#tgx-cw .tgx-fab svg{width:22px!important;height:22px!important}';
  } else if (C.mobileBubble === "hidden") {
    mobileCSS += '#tgx-cw .tgx-fab{display:none!important}';
  }
  mobileCSS += '}';
  s.textContent += mobileCSS;
  document.head.appendChild(s);
}

/* ─── BUILD DOM ──────────────────────────────────────────── */
function buildDOM() {
  var root = document.createElement("div");
  root.id = "tgx-cw";
  root.innerHTML = '<button class="tgx-fab" id="tgxFab"><svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/></svg><span class="tgx-badge" id="tgxBadge">0</span></button>'
  +'<div class="tgx-panel" id="tgxPanel">'
  +'<div class="tgx-hdr"><div class="tgx-logo">'+C.logoText+'</div><div class="tgx-hdr-text"><div class="tgx-hdr-name">'+C.name+'</div><div class="tgx-hdr-tag">'+C.tagline+'</div></div><div class="tgx-hdr-status"></div></div>'
  +'<div class="tgx-msgs" id="tgxMsgs"></div>'
  +'<div class="tgx-typing" id="tgxTyping"><span></span><span></span><span></span></div>'
  +'<div id="tgxPills" class="tgx-pills"></div>'
  +'<div class="tgx-input-wrap"><input class="tgx-input" id="tgxInput" placeholder="Ask me anything..." autocomplete="off"><button class="tgx-send" id="tgxSend"><svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button></div>'
  +'<div class="tgx-esc-bar" id="tgxEscBar"><button class="tgx-esc-btn human" id="tgxHuman">'+C.escalateLabel+'</button><button class="tgx-esc-btn leave" id="tgxLeave">'+C.leaveLabel+'</button></div>'
  +'<div class="tgx-footer">'+C.footer+'</div>'
  +'</div>';
  document.body.appendChild(root);
  return root;
}

/* ─── HELPERS ────────────────────────────────────────────── */
var $fab, $panel, $msgs, $input, $send, $pills, $typing, $badge, $escBar;

function scrollBottom() { setTimeout(function(){ $msgs.scrollTop = $msgs.scrollHeight; }, 50); }

function addMsg(role, text, noStore) {
  var cls = role === "user" ? "tgx-msg user" : role === "agent" ? "tgx-msg agent" : role === "system" ? "tgx-msg system" : "tgx-msg bot";
  var div = document.createElement("div");
  div.className = cls;
  var html = text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/\[(.+?)\]\((https?:\/\/.+?)\)/g, '<a href="$2" target="_blank" rel="noopener" style="color:'+C.accentGlow+'!important;text-decoration:underline!important">$1</a>')
    .replace(/\n/g, "<br>");
  div.innerHTML = html;
  $msgs.appendChild(div);
  if (!noStore) msgs.push({role:role, content:text, ts:Date.now()});
  scrollBottom();
}

function showPills(items, onClick) {
  $pills.innerHTML = "";
  items.forEach(function(txt){
    var btn = document.createElement("button");
    btn.className = "tgx-pill";
    btn.textContent = txt;
    btn.addEventListener("click", function(){ onClick(txt); });
    $pills.appendChild(btn);
  });
}
function clearPills() { $pills.innerHTML = ""; }

function parseResponse(text) {
  var fqs = [], opts = [], clean = [];
  text.split("\n").forEach(function(line){
    var trimmed = line.trim();
    if (/^\[FQ\]/i.test(trimmed)) fqs.push(trimmed.replace(/^\[FQ\]\s*/i,""));
    else if (/^\[OPT\]/i.test(trimmed)) opts.push(trimmed.replace(/^\[OPT\]\s*/i,""));
    else clean.push(line);
  });
  return {body: clean.join("\n").trim(), fqs:fqs, opts:opts};
}

/* ─── ABLY: init ─────────────────────────────────────────── */
function initAbly() {
  if (!C.ablyKey || !window.Ably) {
    console.warn("Luna widget: Ably not available, real-time disabled");
    return;
  }
  convId = "conv_" + Date.now() + "_" + Math.random().toString(36).substr(2,6);
  ably = new Ably.Realtime({key: C.ablyKey, clientId: "visitor_" + convId});
  dashChannel = ably.channels.get("luna-dashboard");
  chatChannel = ably.channels.get("luna-chat:" + convId);

  /* Listen for agent messages */
  chatChannel.subscribe("message", function(msg){
    var d = msg.data;
    if (d && d.from === "agent") {
      addMsg("agent", d.text);
      if (!panelOpen) {
        unread++;
        $badge.textContent = unread;
        $badge.style.cssText = "display:flex!important";
      }
    }
  });

  /* Listen for handler changes */
  chatChannel.subscribe("handler_change", function(msg){
    var d = msg.data;
    if (!d) return;
    if (d.handler === "agent" || (d.handler && d.handler !== "waiting" && d.handler !== "ai")) {
      addMsg("system", (d.agentName || "An agent") + " has joined the chat.");
      liveMode = true;
      $escBar.style.cssText = "display:none!important";
    }
    if (d.handler === "resolved" || d.handler === "closed") {
      addMsg("system", "This conversation has been closed.");
      liveMode = false;
      var resolvedChannel = chatChannel;
      showRatingOverlay(resolvedChannel);
      chatChannel.unsubscribe();
      convId = "conv_" + Date.now() + "_" + Math.random().toString(36).substr(2,6);
      chatChannel = ably.channels.get("luna-chat:" + convId);
      convStarted = false;
      $escBar.style.cssText = "display:flex!important";
    }
  });

  /* Listen for agent typing */
  chatChannel.subscribe("typing", function(msg){
    var d = msg.data;
    if (d && d.from === "agent") {
      $typing.style.cssText = "display:block!important";
      scrollBottom();
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(function(){ $typing.style.cssText = "display:none!important"; }, 2000);
    }
  });

  ably.connection.on("connected", function(){
    console.log("Luna widget: Ably connected, convId=" + convId);
  });
}

/* ─── ABLY: publish helpers ──────────────────────────────── */
function ensureConversationStarted() {
  if (convStarted || !dashChannel) return;
  convStarted = true;
  var now = new Date().toISOString();
  var isMobile = /Mobi|Android/i.test(navigator.userAgent);
  dashChannel.publish("new_conversation", {
    convId: convId,
    visitor: {
      name: userName || "Anonymous",
      email: visitorEmail || undefined,
      marketingConsent: marketingConsent,
      page: window.location.href,
      device: isMobile ? "mobile" : "desktop",
      country: visitorCountry,
      visitorId: visitorId
    },
    handler: "ai",
    startedAt: now,
    messages: msgs.map(function(m){ return {from: m.role === "user" ? "visitor" : m.role, text: m.content, timestamp: new Date(m.ts).toISOString()}; })
  });

  /* Also persist to Airtable if configured */
  if (C.airtableKey && C.airtableBase && C.convTable) {
    var botHistory = msgs.filter(function(m){return m.role!=="system";}).map(function(m){return m.role+": "+m.content;}).join("\n");
    fetch("https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable, {
      method:"POST",
      headers:{"Authorization":"Bearer "+C.airtableKey,"Content-Type":"application/json"},
      body:JSON.stringify({records:[{fields:{
        "fldgQj90mYwsVO4yK":convId,"fldqx6k7WvrqE8BW1":userName||"Anonymous",
        "fldYdZq59FCpKQ7Hf":"Bot","fldSoy7BMqyzVb5pp":now,"fld1GghMiUnAmdtow":now,
        "fldZ38GYN4XbHGl03":botHistory
      }}],typecast:true})
    }).catch(function(e){ console.warn("Airtable conv create error:", e); });
  }
}

function publishMessage(from, text) {
  if (!chatChannel) return;
  chatChannel.publish("message", {from: from, text: text, timestamp: new Date().toISOString()});
}

function publishHandlerChange(handler) {
  if (!chatChannel) return;
  chatChannel.publish("handler_change", {handler: handler});
}

/* ─── NAME COLLECTION OVERLAY ────────────────────────────── */
function showNameOverlay() {
  var ov = document.createElement("div");
  ov.className = "tgx-overlay";
  ov.id = "tgxNameOv";
  var html = '<h3>'+C.namePrompt+'</h3><p>This helps us personalise your experience.</p>'
    +'<input type="text" id="tgxNameIn" placeholder="Your name" autofocus>'
    +'<input type="email" id="tgxEmailIn" placeholder="Email (optional)">'
    +'<label class="tgx-check" id="tgxMarketingLabel">'
    +'<input type="checkbox" id="tgxMarketingIn">'
    +'<span>I\'d like to receive offers and updates</span>'
    +'</label>'
    +'<button class="tgx-obtn" id="tgxNameGo">Continue</button>'
    +'<button class="tgx-olink" id="tgxNameSkip">'+C.skipLabel+'</button>';
  if (C.privacyUrl) {
    html += '<a class="tgx-privacy" href="'+C.privacyUrl+'" target="_blank" rel="noopener">See our privacy policy</a>';
  }
  ov.innerHTML = html;
  $panel.appendChild(ov);
  setTimeout(function(){
    var ni = document.getElementById("tgxNameIn");
    var ei = document.getElementById("tgxEmailIn");
    var mi = document.getElementById("tgxMarketingIn");
    ni.focus();
    function doSubmit() {
      userName = ni.value.trim();
      visitorEmail = ei.value.trim();
      marketingConsent = mi.checked;
      nameCollected = true;
      /* If email + marketing consent, call subscribe endpoint */
      if (visitorEmail && marketingConsent) {
        fetch(C.endpoint.replace("/api/luna-chat", "/api/subscribe"), {
          method: "POST",
          headers: {"Content-Type": "application/json"},
          body: JSON.stringify({
            clientName: C.clientName,
            name: userName,
            email: visitorEmail
          })
        }).catch(function(e){ console.warn("Luna widget: subscribe error:", e); });
      }
      ov.remove();
      startChat();
    }
    document.getElementById("tgxNameGo").addEventListener("click", doSubmit);
    document.getElementById("tgxNameSkip").addEventListener("click", function(){
      userName = "";
      visitorEmail = "";
      marketingConsent = false;
      nameCollected = true;
      ov.remove();
      startChat();
    });
    ni.addEventListener("keydown", function(e){
      if (e.key === "Enter") { e.preventDefault(); ei.focus(); }
    });
    ei.addEventListener("keydown", function(e){
      if (e.key === "Enter") { e.preventDefault(); doSubmit(); }
    });
  }, 50);
}

/* ─── LEAVE A MESSAGE OVERLAY ────────────────────────────── */
function showLeaveOverlay() {
  var ov = document.createElement("div");
  ov.className = "tgx-overlay";
  ov.id = "tgxLeaveOv";
  ov.innerHTML = '<h3>Leave us a message</h3><p>We\'ll get back to you as soon as possible.</p>'
    +'<input type="text" id="tgxLeaveEmail" placeholder="Your email address">'
    +'<textarea id="tgxLeaveMsg" placeholder="Your message..."></textarea>'
    +'<button class="tgx-obtn" id="tgxLeaveGo">Send message</button>'
    +'<button class="tgx-olink" id="tgxLeaveCancel">Cancel</button>';
  $panel.appendChild(ov);
  setTimeout(function(){
    document.getElementById("tgxLeaveEmail").focus();
    document.getElementById("tgxLeaveGo").addEventListener("click", doLeaveMessage);
    document.getElementById("tgxLeaveCancel").addEventListener("click", function(){ ov.remove(); });
  }, 50);
}

function doLeaveMessage() {
  var email = document.getElementById("tgxLeaveEmail").value.trim();
  var message = document.getElementById("tgxLeaveMsg").value.trim();
  if (!email || !message) return;
  var ov = document.getElementById("tgxLeaveOv");
  var now = new Date().toISOString();

  /* Notify dashboard */
  if (dashChannel) {
    dashChannel.publish("new_conversation", {
      convId: convId,
      visitor: {name: userName || "Anonymous", email: email, page: window.location.href},
      handler: "closed",
      startedAt: now,
      messages: [{from: "visitor", text: "[Left a message] " + message, timestamp: now}]
    });
  }

  /* Persist to Airtable if configured */
  if (C.airtableKey && C.airtableBase && C.convTable) {
    var botHistory = msgs.filter(function(m){return m.role!=="system";}).map(function(m){return m.role+": "+m.content;}).join("\n");
    fetch("https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable, {
      method:"POST",
      headers:{"Authorization":"Bearer "+C.airtableKey,"Content-Type":"application/json"},
      body:JSON.stringify({records:[{fields:{
        "fldgQj90mYwsVO4yK":convId,"fldqx6k7WvrqE8BW1":userName||"Anonymous","fldZXcvl7k3FS5Gu7":email,
        "fldYdZq59FCpKQ7Hf":"Closed","fldSoy7BMqyzVb5pp":now,"fld1GghMiUnAmdtow":now,
        "fldZ38GYN4XbHGl03":"[Left a message] "+message+"\n\n--- Bot history ---\n"+botHistory
      }}],typecast:true})
    }).catch(function(e){ console.warn("Airtable leave-msg error:", e); });
  }

  if (ov) ov.remove();
  addMsg("system", "Message sent! We'll be in touch soon.");
}

/* ─── RATING OVERLAY (after resolution) ──────────────────── */
function showRatingOverlay(ratingChannel) {
  var ov = document.createElement("div");
  ov.className = "tgx-overlay";
  ov.id = "tgxRatingOv";
  ov.innerHTML = '<h3>How was your experience?</h3><p>Rate your conversation</p>'
    +'<div class="tgx-stars" id="tgxStars">'
    +'<span class="tgx-star" data-v="1">&#9733;</span>'
    +'<span class="tgx-star" data-v="2">&#9733;</span>'
    +'<span class="tgx-star" data-v="3">&#9733;</span>'
    +'<span class="tgx-star" data-v="4">&#9733;</span>'
    +'<span class="tgx-star" data-v="5">&#9733;</span>'
    +'</div>'
    +'<button class="tgx-olink" id="tgxRatingSkip">Skip</button>';
  $panel.appendChild(ov);
  setTimeout(function(){
    var stars = ov.querySelectorAll(".tgx-star");
    stars.forEach(function(star){
      star.addEventListener("mouseenter", function(){
        var val = parseInt(this.getAttribute("data-v"));
        stars.forEach(function(s){
          s.style.cssText = parseInt(s.getAttribute("data-v")) <= val ? "color:#FFD60A!important;transform:scale(1.15)!important" : "color:"+C.mutedText+"!important;transform:scale(1)!important";
        });
      });
      star.addEventListener("click", function(){
        var val = parseInt(this.getAttribute("data-v"));
        if (ratingChannel) {
          ratingChannel.publish("rating", {rating: val});
        }
        ov.innerHTML = '<h3>Thanks for your feedback!</h3><p>You can start a new chat anytime.</p>';
        setTimeout(function(){ if (ov.parentNode) ov.remove(); }, 2000);
      });
    });
    var starsContainer = document.getElementById("tgxStars");
    if (starsContainer) {
      starsContainer.addEventListener("mouseleave", function(){
        stars.forEach(function(s){ s.style.cssText = "color:"+C.mutedText+"!important;transform:scale(1)!important"; });
      });
    }
    document.getElementById("tgxRatingSkip").addEventListener("click", function(){ ov.remove(); });
  }, 50);
}

/* ─── CALL LUNA AI ENDPOINT ──────────────────────────────── */
async function callLuna(userText) {
  history.push({role: "user", content: userText});

  try {
    var res = await fetch(C.endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        message: userText,
        convId: convId,
        visitorName: userName || undefined,
        clientName: C.clientName,
        history: history.slice(-16),
        page: window.location.pathname
      })
    });
    if (!res.ok) {
      var errText = await res.text();
      console.error("Luna widget: endpoint error:", res.status, errText);
      return {reply: "I'm having trouble connecting right now. You can use the \"" + C.escalateLabel + "\" button below to reach our team directly."};
    }
    var data = await res.json();
    var reply = data.reply || "Sorry, I'm having trouble connecting right now.";
    history.push({role: "assistant", content: reply});
    return data;
  } catch(e) {
    console.error("Luna widget: fetch error:", e.message);
    return {reply: "I'm having trouble connecting right now. You can use the \"" + C.escalateLabel + "\" button below to reach our team directly."};
  }
}

/* ─── SEND MESSAGE (AI mode) ─────────────────────────────── */
async function sendToAI(text) {
  if (!text.trim()) return;
  cancelAutoTrigger();
  clearPills();
  addMsg("user", text);
  $input.value = "";
  $input.disabled = true;
  $typing.style.cssText = "display:block!important";
  scrollBottom();

  ensureConversationStarted();
  publishMessage("visitor", text);

  var data = await callLuna(text);
  $typing.style.cssText = "display:none!important";

  var parsed = parseResponse(data.reply || "");
  addMsg("bot", parsed.body);
  publishMessage("ai", parsed.body);

  /* If endpoint signals escalation */
  if (data.escalate === true) {
    setTimeout(function(){ escalateToHuman(); }, 100);
  }

  if (parsed.opts.length > 0) {
    showPills(parsed.opts, function(opt){ sendToAI(opt); });
  } else if (parsed.fqs.length > 0) {
    showPills(parsed.fqs, function(fq){ sendToAI(fq); });
  }
  $input.disabled = false;
  $input.focus();
}

/* ─── SEND MESSAGE (Live mode) ───────────────────────────── */
function sendToAgent(text) {
  if (!text.trim()) return;
  clearPills();
  addMsg("user", text);
  $input.value = "";
  publishMessage("visitor", text);
}

/* ─── ESCALATE TO HUMAN ─────────────────────────────────── */
async function escalateToHuman() {
  if (liveMode) return;
  addMsg("system", "Connecting you to our team...");
  ensureConversationStarted();
  publishHandlerChange("waiting");

  /* Update Airtable if configured */
  if (C.airtableKey && C.airtableBase && C.convTable) {
    try {
      var searchUrl = "https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable+"?filterByFormula="+encodeURIComponent("{ConversationID}='"+convId+"'")+"&maxRecords=1";
      var sRes = await fetch(searchUrl, {headers:{"Authorization":"Bearer "+C.airtableKey}});
      var sData = await sRes.json();
      if (sData.records && sData.records.length > 0) {
        await fetch("https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable+"/"+sData.records[0].id, {
          method:"PATCH",
          headers:{"Authorization":"Bearer "+C.airtableKey,"Content-Type":"application/json"},
          body:JSON.stringify({fields:{"fldYdZq59FCpKQ7Hf":"Waiting"},typecast:true})
        });
      }
    } catch(e) { console.warn("Airtable escalation error:", e); }
  }

  liveMode = true;
  $escBar.style.cssText = "display:none!important";
  addMsg("system", "You're in the queue. An agent will be with you shortly.");
}

/* ─── START CHAT ─────────────────────────────────────────── */
function startChat() {
  var welcomeText = C.welcome;
  if (userName) welcomeText = "Hey " + userName + "! " + welcomeText.replace(/^Hey there! /, "");
  addMsg("bot", welcomeText);
  showPills(C.hints, function(h){ sendToAI(h); });
}

/* ─── INPUT HANDLER ──────────────────────────────────────── */
function handleSend() {
  var text = $input.value.trim();
  if (!text) return;
  cancelAutoTrigger();
  if (liveMode) sendToAgent(text);
  else sendToAI(text);
}

/* ─── BOOT ───────────────────────────────────────────────── */
async function boot() {
  /* Fetch remote config from API before rendering */
  var clientSlug = C.clientName || attr("clientName") || "default";
  try {
    var cfgRes = await fetch(C.endpoint.replace("/api/luna-chat", "/api/widget-config") + "?client=" + encodeURIComponent(clientSlug));
    if (cfgRes.ok) {
      var apiConfig = await cfgRes.json();
      rebuildConfig(apiConfig);
      console.log("Luna widget: loaded API config for", clientSlug);
    } else {
      console.warn("Luna widget: config API returned", cfgRes.status, "— using defaults");
    }
  } catch(e) {
    console.warn("Luna widget: config fetch failed, using defaults:", e.message);
  }

  /* Persistent visitor ID */
  try {
    visitorId = localStorage.getItem("luna_visitor_id");
    if (!visitorId) {
      visitorId = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2,9);
      localStorage.setItem("luna_visitor_id", visitorId);
    }
  } catch(e) {
    visitorId = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2,9);
  }

  /* Country detection by IP (non-blocking) */
  try {
    var geoRes = await fetch("https://ipapi.co/json/");
    if (geoRes.ok) {
      var geoData = await geoRes.json();
      visitorCountry = geoData.country_code || "";
    }
  } catch(e) { /* silent fallback */ }

  injectCSS();
  buildDOM();

  $fab = document.getElementById("tgxFab");
  $panel = document.getElementById("tgxPanel");
  $msgs = document.getElementById("tgxMsgs");
  $input = document.getElementById("tgxInput");
  $send = document.getElementById("tgxSend");
  $pills = document.getElementById("tgxPills");
  $typing = document.getElementById("tgxTyping");
  $badge = document.getElementById("tgxBadge");
  $escBar = document.getElementById("tgxEscBar");

  $send.addEventListener("click", handleSend);
  $input.addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (liveMode && chatChannel) {
      chatChannel.publish("typing", {from: "visitor"});
    }
  });

  document.getElementById("tgxHuman").addEventListener("click", escalateToHuman);
  document.getElementById("tgxLeave").addEventListener("click", showLeaveOverlay);

  /* ─── Open/close chat function (also used by FAB) ─────── */
  function openChat() {
    cancelAutoTrigger();
    panelOpen = true;
    $panel.classList.add("open");
    $fab.classList.add("open");
    unread = 0;
    $badge.style.cssText = "display:none!important";
    if (!nameCollected && C.collectName) {
      showNameOverlay();
    } else if (msgs.length === 0) {
      startChat();
    }
    setTimeout(function(){ $input.focus(); }, 300);
  }
  function closeChat() {
    panelOpen = false;
    $panel.classList.remove("open");
    $fab.classList.remove("open");
  }

  $fab.addEventListener("click", function(){
    if (panelOpen) closeChat();
    else openChat();
  });

  /* Expose global API for programmatic control (e.g. mobileBubble: "hidden") */
  window.openLunaChat = openChat;
  window.closeLunaChat = closeChat;

  /* Init Ably */
  loadAbly(function(){ initAbly(); });

  /* ─── AUTO-TRIGGER ─────────────────────────────────────── */
  var at = C.autoTrigger;
  if (at && at.enabled && at.delay && at.message) {
    /* Don't re-trigger within same session */
    var alreadyTriggered = false;
    try { alreadyTriggered = sessionStorage.getItem("luna_auto_triggered") === "1"; } catch(e) {}

    /* Don't trigger on mobile if bubble is hidden */
    var isMobileHidden = C.mobileBubble === "hidden" && window.innerWidth < 440;

    if (!alreadyTriggered && !isMobileHidden) {
      autoTriggerTimer = setTimeout(function() {
        /* Guard: don't trigger if visitor already interacted or chat is open */
        if (visitorInteracted || panelOpen || msgs.length > 0 || autoTriggered) return;
        autoTriggered = true;
        try { sessionStorage.setItem("luna_auto_triggered", "1"); } catch(e) {}

        /* Open the panel */
        panelOpen = true;
        $panel.classList.add("open");
        $fab.classList.add("open");

        /* Skip name collection for auto-trigger — go straight to message */
        if (!nameCollected) {
          nameCollected = true; /* mark as handled so it doesn't show later */
        }

        /* Display the trigger message */
        addMsg("bot", at.message);

        /* Show hints if configured */
        if (C.hints && C.hints.length > 0) {
          showPills(C.hints, function(h){ sendToAI(h); });
        }

        /* Play subtle notification sound if tab is active */
        if (!document.hidden) {
          playNotifSound();
        }
      }, at.delay * 1000);
    }
  }
}

/* Run on DOM ready */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();
