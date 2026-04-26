(function() {
"use strict";

/* ─── CONFIG ─────────────────────────────────────────────────
   Priority: window.__LUNA_CONFIG > data-* attributes on script tag > defaults
   ──────────────────────────────────────────────────────────── */
var scriptTag = document.currentScript || document.querySelector('script[src*="widget-core"]');
function attr(name) { return scriptTag && scriptTag.getAttribute("data-" + name); }

var D = {
  /* Identity */
  name: "Luna AI",
  tagline: "AI ASSISTANT",
  logoText: "L",
  profileImage: "",          /* URL to avatar image — overrides logoText */
  welcome: "Hey there! How can we help you today?",
  hints: ["All-inclusive under £800","Best Greek islands for families","Last-minute deals","Do you do Maldives?","Flights to Tenerife"],
  collectName: true,
  namePrompt: "Before we start, what's your name?",
  skipLabel: "Skip",
  escalateLabel: "Talk to a human",
  leaveLabel: "Leave a message",
  footer: "Powered by Luna AI",
  privacyUrl: "",

  /* Endpoints & keys */
  endpoint: "https://luna-chat-endpoint.vercel.app/api/luna-chat",
  ablyTokenEndpoint: "https://luna-chat-endpoint.vercel.app/api/ably-token",
  clientName: "Travelgenix",
  /* NOTE: ablyKey removed — tokens are now fetched server-side via ablyTokenEndpoint.
     The widget never holds a root Ably key. */
  airtableKey: "",
  airtableBase: "",
  convTable: "",

  /* Theme: "light" (default) or "dark" */
  theme: "light",

  /* Colours — just two client-configurable colours; everything derives */
  brandColor: "#1B2B5B",
  accentColor: "#00B4D8",

  /* Size preset: "small" | "medium" | "large" */
  widgetSize: "medium",
  radius: "18px",

  /* Position & mobile */
  position: "right",         /* "left" or "right" */
  fabPosition: "bottom-right", /* bottom-right | bottom-left | mid-right | mid-left */
  mobileBubble: "normal",    /* "normal" | "small" | "hidden" */
  bubbleIcon: "",            /* URL to custom FAB icon */

  /* Auto-trigger */
  autoTrigger: null,          /* { enabled: true, delay: 5, message: "..." } */

  /* Capability cards on home screen — array of {icon, title, desc} */
  capabilityCards: [
    { icon:"plane", title:"Find me a holiday", desc:"Search thousands of packages, flights and hotels — live prices, real availability" },
    { icon:"compass", title:"Help me decide", desc:"Compare destinations, get recommendations, check what's included" },
    { icon:"helpCircle", title:"Answer my questions", desc:"Pricing, what's included, luggage, transfers — ask me anything" }
  ]
};

/* Merge phase 1: window config > data-attrs > defaults */
var W = (typeof window.__LUNA_CONFIG === "object") ? window.__LUNA_CONFIG : {};
var C = {};
function rebuildConfig(apiConfig) {
  var A = apiConfig || {};
  Object.keys(D).forEach(function(k) {
    C[k] = A[k] !== undefined ? A[k] : (W[k] !== undefined ? W[k] : (attr(k) || D[k]));
  });
  /* Map API theme fields (backwards compat with old colour-by-colour config) */
  if (A.theme && typeof A.theme === "object") {
    if (A.theme.brandColor) C.brandColor = A.theme.brandColor;
    if (A.theme.accentColor) C.accentColor = A.theme.accentColor;
    if (A.theme.mode) C.theme = A.theme.mode;
  }
  /* Map API size fields */
  if (A.size) {
    if (A.size.widgetSize) C.widgetSize = A.size.widgetSize;
    if (A.size.radius) C.radius = A.size.radius;
  }
  if (A.position) C.position = A.position;
  if (A.fabPosition) C.fabPosition = A.fabPosition;
  if (A.mobileBubble) C.mobileBubble = A.mobileBubble;
  if (A.autoTrigger) C.autoTrigger = A.autoTrigger;
  if (A.privacyUrl) C.privacyUrl = A.privacyUrl;
  if (A.profileImage) C.profileImage = A.profileImage;
  if (A.bubbleIcon) C.bubbleIcon = A.bubbleIcon;
  if (A.capabilityCards && Array.isArray(A.capabilityCards)) C.capabilityCards = A.capabilityCards;
  /* hints might be a JSON string from data-attr */
  if (typeof C.hints === "string") {
    try { C.hints = JSON.parse(C.hints); } catch(e) { C.hints = D.hints; }
  }
  if (typeof C.collectName === "string") C.collectName = C.collectName === "true";
}
rebuildConfig(null);

/* ─── SIZE PRESETS ───────────────────────────────────────── */
var SIZES = {
  small:  { w: 340, h: 480, fab: 52 },
  medium: { w: 380, h: 560, fab: 56 },
  large:  { w: 420, h: 640, fab: 62 }
};
function getSize() { return SIZES[C.widgetSize] || SIZES.medium; }

/* ─── BOOKING LOOKUP INTEGRATION (tg-widgets bridge) ─────── */
/* Loads widget-mybooking.js cross-origin on demand and instantiates a compact
   booking widget inside a chat bubble when Luna outputs the marker. */
var TG_WIDGETS_BASE = "https://widgets.travelify.io";
var TG_BOOKING_SCRIPT = TG_WIDGETS_BASE + "/widget-mybooking.js";
var TG_CONFIG_API = TG_WIDGETS_BASE + "/api/widget-config";
var _tgBookingScriptPromise = null;
var _tgConfigCache = {};

function loadBookingWidgetScript() {
  if (window.TGMyBookingWidget) return Promise.resolve();
  if (_tgBookingScriptPromise) return _tgBookingScriptPromise;
  _tgBookingScriptPromise = new Promise(function(resolve, reject) {
    var s = document.createElement("script");
    s.src = TG_BOOKING_SCRIPT;
    s.async = true;
    s.onload = function() {
      if (window.TGMyBookingWidget) return resolve();
      var tries = 0;
      var interval = setInterval(function() {
        tries++;
        if (window.TGMyBookingWidget) {
          clearInterval(interval);
          resolve();
        } else if (tries > 30) {
          clearInterval(interval);
          reject(new Error("TGMyBookingWidget did not load"));
        }
      }, 100);
    };
    s.onerror = function() {
      _tgBookingScriptPromise = null;
      reject(new Error("Failed to load booking widget script"));
    };
    document.head.appendChild(s);
  });
  return _tgBookingScriptPromise;
}

/* Strict widget ID validator. Airtable record IDs are always 17 chars,
   start with "rec", and use [A-Za-z0-9] only. Anything else is rejected
   before it goes anywhere near the DOM. */
function isSafeWidgetId(id) {
  return typeof id === "string" && /^rec[A-Za-z0-9]{14}$/.test(id);
}

/* Fetches and caches the booking widget's config. Returns null on failure. */
function fetchBookingConfig(widgetId) {
  if (_tgConfigCache[widgetId]) return Promise.resolve(_tgConfigCache[widgetId]);
  return fetch(TG_CONFIG_API + "?id=" + encodeURIComponent(widgetId), {
    method: "GET",
    headers: { "Accept": "application/json" }
  })
  .then(function(res) {
    if (!res.ok) return null;
    return res.json();
  })
  .then(function(data) {
    if (!data) return null;
    var config = data.config || {};
    config.widgetId = widgetId;
    config.layout = "compact"; /* Force compact for chat embed */
    _tgConfigCache[widgetId] = config;
    return config;
  })
  .catch(function(err) {
    console.warn("Luna widget: failed to fetch booking config:", err.message);
    return null;
  });
}

/* Parses [BOOKING_LOOKUP:rec...] marker out of the bot reply.
   Returns { cleanText, widgetId? }. */
function extractBookingLookupMarker(text) {
  if (typeof text !== "string" || !text) return { cleanText: text };
  var re = /\[BOOKING_LOOKUP:(rec[A-Za-z0-9]{14})\]/;
  var m = text.match(re);
  if (!m) return { cleanText: text };
  var cleanText = text.replace(re, "").trim();
  return { cleanText: cleanText, widgetId: m[1] };
}

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
var agentsChannel = null;
var visitorCountry = "";
var visitorId = "";
var autoTriggerTimer = null;
var autoTriggered = false;
var visitorInteracted = false;
var conversationLang = "";
var currentScreen = "home"; /* "home" or "chat" */
var sessionRestored = false;

/* ─── SESSION PERSISTENCE ───────────────────────────────── */
var SESSION_KEY = "luna_session";
function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      userName: userName,
      visitorEmail: visitorEmail,
      marketingConsent: marketingConsent,
      nameCollected: nameCollected,
      msgs: msgs,
      history: history,
      convId: convId,
      convStarted: convStarted,
      conversationLang: conversationLang,
      currentScreen: currentScreen
    }));
  } catch(e) {}
}
function restoreSession() {
  try {
    var raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    var s = JSON.parse(raw);
    if (!s.convId) return false;
    userName = s.userName || "";
    visitorEmail = s.visitorEmail || "";
    marketingConsent = !!s.marketingConsent;
    nameCollected = !!s.nameCollected;
    msgs = s.msgs || [];
    history = s.history || [];
    convId = s.convId;
    convStarted = !!s.convStarted;
    conversationLang = s.conversationLang || "";
    currentScreen = s.currentScreen || "home";
    return true;
  } catch(e) { return false; }
}

/* ─── AUTO-TRIGGER HELPERS ───────────────────────────────── */
function cancelAutoTrigger() {
  if (autoTriggerTimer) { clearTimeout(autoTriggerTimer); autoTriggerTimer = null; }
  visitorInteracted = true;
}

function playNotifSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = "sine";
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
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

/* ─── SVG ICONS ──────────────────────────────────────────── */
var ICONS = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  minus: '<path d="M5 12h14"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  helpCircle: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'
};
function svgIcon(name, size, color) {
  return '<svg width="'+(size||20)+'" height="'+(size||20)+'" viewBox="0 0 24 24" fill="none" stroke="'+(color||"currentColor")+'" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">'+(ICONS[name]||'')+'</svg>';
}

/* ─── THEME TOKENS ───────────────────────────────────────── */
function getTokens() {
  var isDark = C.theme === "dark";
  return {
    bg: isDark ? "#0F172A" : "#FFFFFF",
    bgSec: isDark ? "#1E293B" : "#F8FAFC",
    bgTer: isDark ? "#334155" : "#F1F5F9",
    border: isDark ? "#334155" : "#E2E8F0",
    borderLight: isDark ? "#1E293B" : "#F1F5F9",
    text1: isDark ? "#F8FAFC" : "#0F172A",
    text2: isDark ? "#CBD5E1" : "#475569",
    text3: isDark ? "#64748B" : "#94A3B8",
    botBubble: isDark ? "#1E293B" : "#F1F5F9",
    botText: isDark ? "#F8FAFC" : "#0F172A",
    userBubble: isDark ? C.accentColor : C.brandColor,
    userText: "#FFFFFF",
    inputBg: isDark ? "#1E293B" : "#F8FAFC",
    inputText: isDark ? "#F8FAFC" : "#0F172A",
    overlayBg: isDark ? "rgba(15,23,42,0.85)" : "rgba(255,255,255,0.88)",
    overlayText: isDark ? "#FFFFFF" : "#0F172A",
    overlayMuted: isDark ? "rgba(255,255,255,0.65)" : "rgba(15,23,42,0.55)",
    pillBg: C.accentColor + (isDark ? "1A" : "0D"),
    pillBorder: C.accentColor + (isDark ? "30" : "20"),
    pillText: isDark ? C.accentColor : C.brandColor,
    shadow: isDark
      ? "0 20px 60px rgba(0,0,0,0.4),0 0 0 1px rgba(255,255,255,0.06)"
      : "0 20px 60px rgba(15,23,42,0.15),0 0 0 1px rgba(15,23,42,0.05)"
  };
}

/* ─── INJECT CSS ─────────────────────────────────────────── */
function injectCSS() {
  var old = document.getElementById("tgx-cw-styles");
  if (old) old.remove();
  var s = document.createElement("style");
  s.id = "tgx-cw-styles";
  var T = getTokens();
  var sz = getSize();
  var isLeft = C.fabPosition.indexOf("left") !== -1;
  var isMid = C.fabPosition.indexOf("mid") !== -1;
  var fabSide = isLeft ? "left:24px" : "right:24px";
  var fabVert = isMid ? "top:50%;transform:translateY(-50%)" : "bottom:24px";
  var panelSide = isLeft ? "left:24px" : "right:24px";
  var fabRadius = isMid ? "14px" : "50%";

  s.textContent = ''
  /* Reset */
  +'#tgx-cw *{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}'

  /* FAB */
  +'#tgx-cw .tgx-fab{position:fixed;'+fabVert+';'+fabSide+';width:'+sz.fab+'px;height:'+sz.fab+'px;border-radius:'+fabRadius+';background:'+C.brandColor+';border:none;cursor:pointer;z-index:999998;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 20px '+C.brandColor+'40;transition:transform .2s cubic-bezier(.4,0,.2,1),box-shadow .2s}'
  +'#tgx-cw .tgx-fab:hover{transform:'+(isMid?'translateY(-50%) scale(1.06)':'scale(1.06)')+';box-shadow:0 6px 28px '+C.brandColor+'50}'
  +'#tgx-cw .tgx-fab svg{width:24px;height:24px;fill:none;stroke:#fff;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}'
  +'#tgx-cw .tgx-fab img.tgx-fab-icon{width:28px;height:28px;object-fit:contain}'
  +'#tgx-cw .tgx-fab.open svg,.tgx-fab.open img{transform:rotate(90deg);transition:transform .3s}'
  +'#tgx-cw .tgx-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#EF4444;color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px}'

  /* Panel */
  +'#tgx-cw .tgx-panel{position:fixed;bottom:'+((isMid?'50%':'96px'))+';'+panelSide+';width:'+sz.w+'px;height:'+sz.h+'px;max-height:calc(100vh - 120px);background:'+T.bg+';border-radius:'+C.radius+';border:1px solid '+T.border+';box-shadow:'+T.shadow+';display:flex;flex-direction:column;overflow:hidden;z-index:999999;opacity:0;visibility:hidden;transform:translateY(12px) scale(0.97);transition:opacity .25s cubic-bezier(.4,0,.2,1),transform .25s cubic-bezier(.4,0,.2,1),visibility .25s}'
  +(isMid?'#tgx-cw .tgx-panel{transform:translateY(calc(-50% + 12px)) scale(0.97)}#tgx-cw .tgx-panel.open{transform:translateY(-50%) scale(1)}':'')
  +'#tgx-cw .tgx-panel.open{opacity:1;visibility:visible;transform:translateY(0) scale(1)}'

  /* Header — full (home) */
  +'#tgx-cw .tgx-hdr-full{padding:22px 18px 18px;background:'+C.brandColor+';position:relative;overflow:hidden;flex-shrink:0}'
  +'#tgx-cw .tgx-hdr-full .tgx-hdr-bg{position:absolute;border-radius:50%;background:rgba(255,255,255,0.06)}'
  +'#tgx-cw .tgx-hdr-full .tgx-hdr-row{display:flex;align-items:center;gap:12px;position:relative;z-index:1}'
  +'#tgx-cw .tgx-hdr-full .tgx-welcome{color:rgba(255,255,255,0.85);font-size:14px;line-height:1.5;margin-top:14px;position:relative;z-index:1}'

  /* Header — compact (chat) */
  +'#tgx-cw .tgx-hdr-compact{padding:10px 14px;background:'+C.brandColor+';display:flex;align-items:center;gap:10px;flex-shrink:0}'

  /* Avatar */
  +'#tgx-cw .tgx-avatar{display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden}'
  +'#tgx-cw .tgx-avatar img{width:100%;height:100%;object-fit:cover}'
  +'#tgx-cw .tgx-avatar-hdr{background:rgba(255,255,255,0.15);backdrop-filter:blur(8px);color:#fff;font-weight:700}'
  +'#tgx-cw .tgx-avatar-msg{background:'+C.brandColor+';color:#fff;font-weight:700}'

  /* Status dot */
  +'#tgx-cw .tgx-status{width:6px;height:6px;border-radius:50%;background:#34D399;box-shadow:0 0 5px rgba(52,211,153,0.5);flex-shrink:0}'
  +'#tgx-cw .tgx-hdr-name{color:#fff;font-weight:600;line-height:1.3}'
  +'#tgx-cw .tgx-hdr-sub{color:rgba(255,255,255,0.65);font-size:11px;font-weight:500;display:flex;align-items:center;gap:5px;margin-top:1px}'
  +'#tgx-cw .tgx-hdr-btn{background:rgba(255,255,255,0.1);border:none;border-radius:7px;padding:5px 7px;cursor:pointer;display:flex;align-items:center}'

  /* Screens */
  +'#tgx-cw .tgx-screen{flex:1;display:flex;flex-direction:column;overflow:hidden}'
  +'#tgx-cw .tgx-screen.hidden{display:none}'

  /* Home — capability cards */
  +'#tgx-cw .tgx-home-body{flex:1;overflow-y:auto;padding:16px 14px}'
  +'#tgx-cw .tgx-section-label{font-size:10px;font-weight:600;color:'+T.text3+';text-transform:uppercase;letter-spacing:0.8px;margin-bottom:10px;padding-left:3px}'
  +'#tgx-cw .tgx-cap-card{width:100%;display:flex;align-items:flex-start;gap:12px;padding:14px;border-radius:12px;border:1px solid '+T.border+';background:'+T.bg+';cursor:pointer;margin-bottom:8px;text-align:left;transition:all .15s}'
  +'#tgx-cw .tgx-cap-card:hover{border-color:'+C.accentColor+'40;transform:translateY(-1px);box-shadow:0 4px 12px '+C.brandColor+'10}'
  +'#tgx-cw .tgx-cap-icon{width:38px;height:38px;border-radius:10px;background:'+C.brandColor+';display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}'
  +'#tgx-cw .tgx-cap-icon svg{stroke:#fff}'
  +'#tgx-cw .tgx-cap-title{font-size:14px;font-weight:600;color:'+T.text1+';line-height:1.3}'
  +'#tgx-cw .tgx-cap-desc{font-size:11px;color:'+T.text2+';margin-top:3px;line-height:1.45}'

  /* Home — starters */
  +'#tgx-cw .tgx-starter{padding:7px 12px;border-radius:18px;background:'+T.pillBg+';border:1px solid '+T.pillBorder+';color:'+T.pillText+';font-size:12px;font-weight:500;cursor:pointer;line-height:1.3;transition:all .15s}'
  +'#tgx-cw .tgx-starter:hover{background:'+C.accentColor+'1A;border-color:'+C.accentColor+'40}'

  /* Home — demoted links */
  +'#tgx-cw .tgx-demoted{margin-top:18px;padding-top:14px;border-top:1px solid '+T.borderLight+';display:flex;align-items:center;justify-content:center;gap:4px;flex-wrap:wrap}'
  +'#tgx-cw .tgx-demoted span{font-size:11px;color:'+T.text3+'}'
  +'#tgx-cw .tgx-demoted button{background:none;border:none;cursor:pointer;font-size:11px;font-weight:600;color:'+C.accentColor+';padding:2px 0}'
  +'#tgx-cw .tgx-demoted button:hover{text-decoration:underline}'

  /* Messages area */
  +'#tgx-cw .tgx-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:4px;scrollbar-width:thin;scrollbar-color:'+T.border+' transparent}'
  +'#tgx-cw .tgx-msgs::-webkit-scrollbar{width:4px}'
  +'#tgx-cw .tgx-msgs::-webkit-scrollbar-thumb{background:'+T.border+';border-radius:2px}'

  /* Message rows */
  +'#tgx-cw .tgx-msg-row{display:flex;gap:7px;margin-bottom:3px;animation:tgxFadeIn .2s ease}'
  +'#tgx-cw .tgx-msg-row.user{flex-direction:row-reverse}'
  +'#tgx-cw .tgx-msg-row.user .tgx-msg-col{align-items:flex-end}'

  /* Message bubble */
  +'#tgx-cw .tgx-msg-col{display:flex;flex-direction:column;gap:3px;max-width:78%}'
  +'#tgx-cw .tgx-msg{padding:9px 13px;font-size:13px;line-height:1.55;word-wrap:break-word}'
  +'#tgx-cw .tgx-msg.bot{background:'+T.botBubble+';color:'+T.botText+';border-radius:14px 14px 14px 4px}'
  +'#tgx-cw .tgx-msg.user{background:'+T.userBubble+';color:'+T.userText+';border-radius:14px 14px 4px 14px}'
  +'#tgx-cw .tgx-msg.agent{background:'+(C.theme==='dark'?'#1A3A2A':'#ECFDF5')+';color:'+(C.theme==='dark'?'#A8F0C6':'#065F46')+';border-radius:14px 14px 14px 4px;border-left:2px solid #34D399}'
  +'#tgx-cw .tgx-msg.system{align-self:center;background:transparent;color:'+T.text3+';font-size:12px;font-style:italic;padding:4px 0;text-align:center;max-width:100%}'
  +'#tgx-cw .tgx-msg a{color:'+C.accentColor+';text-decoration:underline}'
  +'#tgx-cw .tgx-msg-time{font-size:10px;color:'+T.text3+';padding:0 3px}'

  /* Booking widget embed */
  +'#tgx-cw .tgx-msg-row-widget{display:block;width:100%;margin:8px 0}'
  +'#tgx-cw .tgx-bubble-widget{max-width:100%;width:100%;padding:0;background:transparent;border:none;box-shadow:none}'
  +'#tgx-cw .tgx-booking-mount{width:100%;border-radius:12px;overflow:hidden}'
  +'#tgx-cw .tgx-booking-loading{padding:20px 16px;text-align:center;color:'+T.text3+';font-size:13px;background:'+T.botBubble+';border-radius:12px;font-style:italic}'

  /* Date divider */
  +'#tgx-cw .tgx-date{text-align:center;padding:6px 0 10px;font-size:10px;color:'+T.text3+';font-weight:500}'

  /* Typing indicator */
  +'#tgx-cw .tgx-typing-row{display:none;gap:7px;align-items:flex-end;margin-top:4px;padding:0 14px}'
  +'#tgx-cw .tgx-typing-row.active{display:flex}'
  +'#tgx-cw .tgx-typing{padding:10px 16px;border-radius:14px 14px 14px 4px;background:'+T.botBubble+';display:flex;gap:4px;align-items:center}'
  +'#tgx-cw .tgx-typing span{display:inline-block;width:6px;height:6px;border-radius:50%;background:'+T.text3+';animation:tgxDot 1.4s infinite}'
  +'#tgx-cw .tgx-typing span:nth-child(2){animation-delay:.2s}'
  +'#tgx-cw .tgx-typing span:nth-child(3){animation-delay:.4s}'

  /* Pills (quick replies) */
  +'#tgx-cw .tgx-pills{display:flex;flex-wrap:wrap;gap:5px;padding:0 14px 6px}'
  +'#tgx-cw .tgx-pill{background:'+T.pillBg+';border:1px solid '+T.pillBorder+';color:'+T.pillText+';font-size:11px;font-weight:500;padding:6px 11px;border-radius:16px;cursor:pointer;transition:background .15s,border-color .15s;line-height:1.3;text-align:left}'
  +'#tgx-cw .tgx-pill:hover{background:'+C.accentColor+'1A;border-color:'+C.accentColor+'40}'

  /* Input area */
  +'#tgx-cw .tgx-input-wrap{padding:10px 14px;border-top:1px solid '+T.border+';display:flex;gap:7px;align-items:flex-end;background:'+T.bg+';flex-shrink:0}'
  +'#tgx-cw .tgx-input-inner{flex:1;display:flex;align-items:center;background:'+T.inputBg+';border-radius:20px;border:1px solid '+T.border+';padding:0 4px 0 14px;transition:border-color .15s}'
  +'#tgx-cw .tgx-input-inner:focus-within{border-color:'+C.accentColor+'}'
  +'#tgx-cw .tgx-input{flex:1;background:none;border:none;padding:10px 0;font-size:13px;color:'+T.inputText+';outline:none;line-height:1.4}'
  +'#tgx-cw .tgx-input::placeholder{color:'+T.text3+'}'
  +'#tgx-cw .tgx-send{width:38px;height:38px;border-radius:50%;background:'+C.brandColor+';border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:opacity .15s,transform .1s}'
  +'#tgx-cw .tgx-send:hover{opacity:.85}'
  +'#tgx-cw .tgx-send:active{transform:scale(.92)}'
  +'#tgx-cw .tgx-send svg{width:16px;height:16px;stroke:#fff;fill:none}'

  /* Escalation bar */
  +'#tgx-cw .tgx-esc-bar{display:none;gap:8px;padding:8px 14px;border-top:1px solid '+T.border+';flex-shrink:0}'
  +'#tgx-cw .tgx-esc-bar.active{display:flex}'
  +'#tgx-cw .tgx-esc-btn{flex:1;padding:9px 0;border-radius:10px;font-size:12px;font-weight:600;cursor:pointer;text-align:center;transition:opacity .15s;border:none}'
  +'#tgx-cw .tgx-esc-btn:hover{opacity:.8}'
  +'#tgx-cw .tgx-esc-btn.human{background:'+C.accentColor+';color:#fff}'
  +'#tgx-cw .tgx-esc-btn.leave{background:'+T.bgSec+';color:'+T.text2+';border:1px solid '+T.border+'}'

  /* Email bar */
  +'#tgx-cw .tgx-email-bar{padding:4px 14px 2px;flex-shrink:0;text-align:right;display:none}'
  +'#tgx-cw .tgx-email-link{color:'+T.text3+';font-size:11px;cursor:pointer;transition:color .15s;border:none;background:none;padding:0}'
  +'#tgx-cw .tgx-email-link:hover{color:'+C.accentColor+'}'
  +'#tgx-cw .tgx-email-inline{display:flex;gap:6px;align-items:center;padding:4px 14px 2px;flex-shrink:0}'
  +'#tgx-cw .tgx-email-inline input{flex:1;background:'+T.inputBg+';border:1px solid '+T.border+';border-radius:16px;padding:6px 12px;color:'+T.inputText+';font-size:12px;outline:none}'
  +'#tgx-cw .tgx-email-inline input::placeholder{color:'+T.text3+'}'
  +'#tgx-cw .tgx-email-inline button{background:'+C.accentColor+';color:#fff;border:none;border-radius:16px;padding:6px 12px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap}'
  +'#tgx-cw .tgx-email-inline .tgx-email-cancel{background:none;color:'+T.text3+';padding:6px 4px;font-size:11px;font-weight:400}'

  /* Overlays */
  +'#tgx-cw .tgx-overlay{position:absolute;inset:0;background:'+T.overlayBg+';backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;z-index:10;border-radius:'+C.radius+'}'
  +'#tgx-cw .tgx-overlay h3{color:'+T.overlayText+';font-size:18px;font-weight:600;margin-bottom:8px;text-align:center}'
  +'#tgx-cw .tgx-overlay p{color:'+T.overlayMuted+';font-size:13px;margin-bottom:20px;text-align:center}'
  +'#tgx-cw .tgx-overlay input[type="text"],#tgx-cw .tgx-overlay input[type="email"],#tgx-cw .tgx-overlay textarea{width:100%;background:'+T.bgSec+';border:1px solid '+T.border+';border-radius:12px;padding:14px 16px;color:'+T.text1+';font-size:15px;outline:none;margin-bottom:12px;transition:border-color .2s,box-shadow .2s;-webkit-appearance:none;appearance:none}'
  +'#tgx-cw .tgx-overlay input:focus,#tgx-cw .tgx-overlay textarea:focus{border-color:'+C.accentColor+';box-shadow:0 0 0 3px '+C.accentColor+'25}'
  +'#tgx-cw .tgx-overlay input::placeholder,#tgx-cw .tgx-overlay textarea::placeholder{color:'+T.text3+'}'
  +'#tgx-cw .tgx-overlay textarea{height:80px;resize:none;font-family:inherit}'
  +'#tgx-cw .tgx-overlay .tgx-obtn{width:100%;padding:14px;border-radius:12px;background:'+C.accentColor+';color:#fff;font-size:15px;font-weight:600;border:none;cursor:pointer;margin-bottom:8px;transition:opacity .15s,transform .1s}'
  +'#tgx-cw .tgx-overlay .tgx-obtn:hover{opacity:.9}'
  +'#tgx-cw .tgx-overlay .tgx-obtn:active{transform:scale(.98)}'
  +'#tgx-cw .tgx-overlay .tgx-olink{background:none;border:none;color:'+C.accentColor+';font-size:13px;cursor:pointer;text-decoration:underline}'

  /* Checkbox */
  +'#tgx-cw .tgx-check{display:flex;align-items:center;gap:10px;margin-bottom:16px;cursor:pointer;text-align:left;width:100%;-webkit-user-select:none;user-select:none}'
  +'#tgx-cw .tgx-check input[type="checkbox"]{position:absolute;opacity:0;width:0;height:0;pointer-events:none}'
  +'#tgx-cw .tgx-check .tgx-cb{width:22px;height:22px;border-radius:6px;border:1.5px solid '+T.border+';background:'+T.bgSec+';display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s,border-color .15s}'
  +'#tgx-cw .tgx-check .tgx-cb svg{width:14px;height:14px;opacity:0;transform:scale(.5);transition:opacity .15s,transform .15s}'
  +'#tgx-cw .tgx-check input:checked+.tgx-cb{background:'+C.accentColor+';border-color:'+C.accentColor+'}'
  +'#tgx-cw .tgx-check input:checked+.tgx-cb svg{opacity:1;transform:scale(1)}'
  +'#tgx-cw .tgx-check .tgx-cb-label{color:'+T.text2+';font-size:13px;line-height:1.4}'

  /* Honeypot, privacy, stars, footer */
  +'#tgx-cw .tgx-hp{position:absolute;left:-9999px;top:-9999px;opacity:0;height:0;width:0;z-index:-1;pointer-events:none}'
  +'#tgx-cw .tgx-privacy{display:block;margin-top:12px;color:'+T.text3+';font-size:11px;text-decoration:none;transition:color .15s}'
  +'#tgx-cw .tgx-privacy:hover{color:'+T.text1+';text-decoration:underline}'
  +'#tgx-cw .tgx-stars{display:flex;gap:8px;justify-content:center;margin-bottom:16px}'
  +'#tgx-cw .tgx-star{font-size:36px;color:'+T.text3+';cursor:pointer;transition:color .15s,transform .15s;line-height:1}'
  +'#tgx-cw .tgx-footer{text-align:center;padding:6px 14px;color:'+T.text3+';font-size:10px;flex-shrink:0}'

  /* Animations */
  +'@keyframes tgxDot{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1)}}'
  +'@keyframes tgxFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}'

  /* Mobile */
  ;var mobileCSS = '@media(max-width:440px){'
    +'#tgx-cw .tgx-panel{right:0;bottom:0;left:0;top:0;width:100vw;height:100vh;max-height:100vh;border-radius:0}'
    +'#tgx-cw .tgx-fab.open{display:none}';
  if (C.mobileBubble === "small") {
    mobileCSS += '#tgx-cw .tgx-fab{width:44px;height:44px;box-shadow:0 2px 12px rgba(0,0,0,0.3)}'
      +'#tgx-cw .tgx-fab svg{width:22px;height:22px}';
  } else if (C.mobileBubble === "hidden") {
    mobileCSS += '#tgx-cw .tgx-fab{display:none}';
  }
  mobileCSS += '}';
  s.textContent += mobileCSS;
  document.head.appendChild(s);
}

/* ─── AVATAR HELPER ──────────────────────────────────────── */
function makeAvatar(size, forHeader) {
  var el = document.createElement("div");
  el.className = "tgx-avatar " + (forHeader ? "tgx-avatar-hdr" : "tgx-avatar-msg");
  el.style.cssText = "width:"+size+"px;height:"+size+"px;border-radius:"+(size>30?"11px":"7px")+";font-size:"+Math.round(size*0.45)+"px";
  if (C.profileImage && isSafeUrl(C.profileImage)) {
    /* Build <img> via createElement — never innerHTML with Airtable-sourced URLs */
    var img = document.createElement("img");
    img.src = C.profileImage;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    el.appendChild(img);
  } else {
    el.textContent = C.logoText || "";
  }
  return el;
}

/* ─── URL SAFETY ─────────────────────────────────────────── */
/* Only allow http(s) URLs. Blocks javascript:, data:, vbscript: etc. */
function isSafeUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2000) return false;
  /* Strip control chars and whitespace that could be used for evasion */
  var cleaned = url.replace(/[\s\u0000-\u001F\u007F]/g, "");
  return /^https?:\/\//i.test(cleaned);
}

/* ─── SAFE MARKDOWN RENDERER ─────────────────────────────── */
/* Renders the small markdown subset Luna uses (**bold**, *italic*, [label](url),
   bare deep-link URLs, \n -> <br>) into a parent element using DOM nodes only.
   Never calls innerHTML with text content. XSS-safe by construction. */
function renderSafeMarkdown(parent, text) {
  if (typeof text !== "string") return;

  /* Tokeniser: walk the string and emit tokens for links, bold, italic, newlines, and plain text.
     Regex chosen to match the original rendering (so nothing visible changes for users). */
  var PATTERNS = [
    { name: "link",     re: /\[([^\]]+?)\]\((https?:\/\/[^\s)]+?)\)/g },
    { name: "deeplink", re: /(^|[^"(\w])(https?:\/\/dl\.tvllnk\.com[^\s<>")\]]+)/g },
    { name: "bold",     re: /\*\*([^*]+?)\*\*/g },
    { name: "italic",   re: /\*([^*]+?)\*/g }
  ];

  /* First pass: find all matches and their positions */
  var matches = [];
  PATTERNS.forEach(function(p) {
    p.re.lastIndex = 0;
    var m;
    while ((m = p.re.exec(text)) !== null) {
      matches.push({
        type: p.name,
        start: m.index + (p.name === "deeplink" ? m[1].length : 0),
        end: m.index + m[0].length,
        groups: m.slice(1),
        full: m[0]
      });
    }
  });

  /* Sort by start, remove overlaps (first match wins) */
  matches.sort(function(a, b) { return a.start - b.start; });
  var filtered = [];
  var lastEnd = -1;
  matches.forEach(function(m) {
    if (m.start >= lastEnd) { filtered.push(m); lastEnd = m.end; }
  });

  /* Emit tokens: plain text (with \n handling) + DOM nodes for markdown matches */
  function emitPlain(str) {
    if (!str) return;
    var parts = str.split("\n");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length > 0) parent.appendChild(document.createTextNode(parts[i]));
      if (i < parts.length - 1) parent.appendChild(document.createElement("br"));
    }
  }

  var cursor = 0;
  filtered.forEach(function(m) {
    emitPlain(text.slice(cursor, m.start));

    if (m.type === "bold") {
      var b = document.createElement("strong");
      b.textContent = m.groups[0];
      parent.appendChild(b);
    } else if (m.type === "italic") {
      var i = document.createElement("em");
      i.textContent = m.groups[0];
      parent.appendChild(i);
    } else if (m.type === "link") {
      var label = m.groups[0];
      var url = m.groups[1];
      if (isSafeUrl(url)) {
        var a = document.createElement("a");
        a.href = url;
        var isSearch = /dl\.tvllnk\.com|travellinx/i.test(url);
        a.target = isSearch ? "_self" : "_blank";
        a.rel = "noopener noreferrer";
        if (isSearch) a.className = "tgx-search-link";
        a.textContent = label;
        parent.appendChild(a);
      } else {
        /* Unsafe URL — render as plain text */
        parent.appendChild(document.createTextNode(m.full));
      }
    } else if (m.type === "deeplink") {
      var url2 = m.groups[1];
      if (isSafeUrl(url2)) {
        var a2 = document.createElement("a");
        a2.href = url2;
        a2.target = "_self";
        a2.rel = "noopener noreferrer";
        a2.className = "tgx-search-link";
        a2.textContent = "Click here to view results";
        parent.appendChild(a2);
      } else {
        parent.appendChild(document.createTextNode(m.full));
      }
    }

    cursor = m.end;
  });

  emitPlain(text.slice(cursor));
}

/* ─── BUILD DOM ──────────────────────────────────────────── */
function buildDOM() {
  var T = getTokens();
  var root = document.createElement("div");
  root.id = "tgx-cw";

  /* FAB — icon injected safely below; use a placeholder span */
  root.innerHTML = ''
  +'<button class="tgx-fab" id="tgxFab"><span id="tgxFabIcon"></span><span class="tgx-badge" id="tgxBadge">0</span></button>'
  +'<div class="tgx-panel" id="tgxPanel">'

    /* ── HOME SCREEN ── */
    +'<div class="tgx-screen" id="tgxHomeScreen">'
      +'<div class="tgx-hdr-full">'
        +'<div class="tgx-hdr-bg" style="top:-30px;right:-30px;width:110px;height:110px"></div>'
        +'<div class="tgx-hdr-bg" style="bottom:-40px;left:-20px;width:90px;height:90px"></div>'
        +'<div class="tgx-hdr-row">'
          +'<div id="tgxHomeAvatar"></div>'
          +'<div style="flex:1;min-width:0"><div class="tgx-hdr-name" id="tgxHomeName" style="font-size:16px"></div><div class="tgx-hdr-sub"><div class="tgx-status"></div>Online now</div></div>'
          +'<button class="tgx-hdr-btn" id="tgxHomeClose"></button>'
        +'</div>'
        +'<div class="tgx-welcome" id="tgxWelcome"></div>'
      +'</div>'
      +'<div class="tgx-home-body">'
        +'<div class="tgx-section-label">What I can help with</div>'
        +'<div id="tgxCapCards"></div>'
        +'<div class="tgx-section-label" style="margin-top:14px">Try asking</div>'
        +'<div id="tgxStarters" style="display:flex;flex-wrap:wrap;gap:6px"></div>'
        +'<div class="tgx-demoted">'
          +'<span>Prefer a person?</span>'
          +'<button id="tgxDemotedHuman"></button>'
          +'<span>·</span>'
          +'<button id="tgxDemotedLeave"></button>'
        +'</div>'
      +'</div>'
      +'<div class="tgx-footer" id="tgxFooterHome"></div>'
    +'</div>'

    /* ── CHAT SCREEN ── */
    +'<div class="tgx-screen hidden" id="tgxChatScreen">'
      +'<div class="tgx-hdr-compact">'
        +'<button class="tgx-hdr-btn" id="tgxBackHome"></button>'
        +'<div id="tgxChatAvatar"></div>'
        +'<div style="flex:1;min-width:0"><div class="tgx-hdr-name" id="tgxChatName" style="font-size:14px"></div><div class="tgx-hdr-sub"><div class="tgx-status"></div>Online</div></div>'
        +'<button class="tgx-hdr-btn" id="tgxChatClose"></button>'
      +'</div>'
      +'<div class="tgx-date" id="tgxDateDiv">Today</div>'
      +'<div class="tgx-msgs" id="tgxMsgs"></div>'
      +'<div class="tgx-typing-row" id="tgxTypingRow"><div id="tgxTypingAvatar"></div><div class="tgx-typing" id="tgxTyping"><span></span><span></span><span></span></div></div>'
      +'<div id="tgxPills" class="tgx-pills"></div>'
      +'<div class="tgx-email-bar" id="tgxEmailBar"><span class="tgx-email-link" id="tgxEmailLink">&#128231; Email this chat</span></div>'
      +'<div class="tgx-input-wrap"><div class="tgx-input-inner"><input class="tgx-input" id="tgxInput" placeholder="Ask me anything..." autocomplete="off"></div><button class="tgx-send" id="tgxSend"></button></div>'
      +'<div class="tgx-esc-bar" id="tgxEscBar"><button class="tgx-esc-btn human" id="tgxHuman"></button><button class="tgx-esc-btn leave" id="tgxLeave"></button></div>'
      +'<div class="tgx-footer" id="tgxFooterChat"></div>'
    +'</div>'

  +'</div>';

  document.body.appendChild(root);

  /* ── Populate tainted fields via textContent / safe DOM — never innerHTML ── */
  function setText(id, val) { var el = document.getElementById(id); if (el) el.textContent = val || ""; }

  /* FAB icon: custom image (validated URL) or built-in SVG */
  var fabIconEl = document.getElementById("tgxFabIcon");
  if (C.bubbleIcon && isSafeUrl(C.bubbleIcon)) {
    var fabImg = document.createElement("img");
    fabImg.className = "tgx-fab-icon";
    fabImg.src = C.bubbleIcon;
    fabImg.alt = "Chat";
    fabImg.referrerPolicy = "no-referrer";
    fabIconEl.appendChild(fabImg);
  } else {
    /* svgIcon returns a trusted static string — safe to innerHTML */
    fabIconEl.innerHTML = svgIcon("chat", 24, "#fff");
  }

  /* Static SVG icons in buttons — safe because svgIcon args are all internal constants */
  document.getElementById("tgxHomeClose").innerHTML = svgIcon("minus",16,"rgba(255,255,255,0.65)");
  document.getElementById("tgxBackHome").innerHTML = svgIcon("arrowLeft",17,"rgba(255,255,255,0.7)");
  document.getElementById("tgxChatClose").innerHTML = svgIcon("minus",16,"rgba(255,255,255,0.65)");
  document.getElementById("tgxSend").innerHTML = svgIcon("send",16,"#fff");

  /* Tainted Airtable fields — textContent only */
  setText("tgxHomeName", C.name);
  setText("tgxChatName", C.name);
  setText("tgxWelcome", C.welcome);
  setText("tgxFooterHome", C.footer);
  setText("tgxFooterChat", C.footer);
  setText("tgxDemotedHuman", C.escalateLabel);
  setText("tgxDemotedLeave", C.leaveLabel);
  setText("tgxHuman", C.escalateLabel);
  setText("tgxLeave", C.leaveLabel);

  /* Insert avatars */
  document.getElementById("tgxHomeAvatar").appendChild(makeAvatar(42, true));
  document.getElementById("tgxChatAvatar").appendChild(makeAvatar(32, true));
  document.getElementById("tgxTypingAvatar").appendChild(makeAvatar(26, false));

  /* Build capability cards — safely */
  var cards = C.capabilityCards || D.capabilityCards;
  var cardsEl = document.getElementById("tgxCapCards");
  cards.forEach(function(card){
    var btn = document.createElement("button");
    btn.className = "tgx-cap-card";

    var iconWrap = document.createElement("div");
    iconWrap.className = "tgx-cap-icon";
    iconWrap.innerHTML = svgIcon(card.icon, 18, "#fff"); /* svgIcon validates name against whitelist */

    var textWrap = document.createElement("div");
    textWrap.style.cssText = "flex:1;min-width:0";

    var titleEl = document.createElement("div");
    titleEl.className = "tgx-cap-title";
    titleEl.textContent = card.title || "";

    var descEl = document.createElement("div");
    descEl.className = "tgx-cap-desc";
    descEl.textContent = card.desc || "";

    textWrap.appendChild(titleEl);
    textWrap.appendChild(descEl);

    var chevron = document.createElement("span");
    chevron.innerHTML = svgIcon("chevronRight", 15, getTokens().text3);

    btn.appendChild(iconWrap);
    btn.appendChild(textWrap);
    btn.appendChild(chevron);

    btn.addEventListener("click", function(){ switchToChat(); sendToAI(card.title); });
    cardsEl.appendChild(btn);
  });

  /* Build starter pills */
  var startersEl = document.getElementById("tgxStarters");
  C.hints.forEach(function(hint){
    var btn = document.createElement("button");
    btn.className = "tgx-starter";
    btn.textContent = hint;
    btn.addEventListener("click", function(){ switchToChat(); sendToAI(hint); });
    startersEl.appendChild(btn);
  });

  return root;
}

/* ─── SCREEN SWITCHING ──────────────────────────────────── */
function switchToHome() {
  currentScreen = "home";
  document.getElementById("tgxHomeScreen").classList.remove("hidden");
  document.getElementById("tgxChatScreen").classList.add("hidden");
  saveSession();
}
function switchToChat() {
  currentScreen = "chat";
  document.getElementById("tgxChatScreen").classList.remove("hidden");
  document.getElementById("tgxHomeScreen").classList.add("hidden");
  if (msgs.length === 0) startChat();
  setTimeout(function(){ $input.focus(); }, 100);
  saveSession();
}

/* ─── HELPERS ────────────────────────────────────────────── */
var $fab, $panel, $msgs, $input, $send, $pills, $typing, $badge, $escBar, $emailBar;

function scrollBottom() { setTimeout(function(){ $msgs.scrollTop = $msgs.scrollHeight; }, 50); }

/* Renders an embedded My Booking widget as a chat message. The "descriptor"
   is the same object the message was stored with: { kind, widgetId }. */
function renderBookingWidgetMessage(descriptor) {
  if (!descriptor || descriptor.kind !== "booking_lookup" || !isSafeWidgetId(descriptor.widgetId)) {
    return;
  }

  var row = document.createElement("div");
  row.className = "tgx-msg-row tgx-msg-row-widget";

  var bubble = document.createElement("div");
  bubble.className = "tgx-bubble-widget";

  var mount = document.createElement("div");
  mount.className = "tgx-booking-mount";
  bubble.appendChild(mount);

  var placeholder = document.createElement("div");
  placeholder.className = "tgx-booking-loading";
  placeholder.textContent = "Loading booking lookup...";
  mount.appendChild(placeholder);

  row.appendChild(bubble);
  $msgs.appendChild(row);
  scrollBottom();

  Promise.all([
    loadBookingWidgetScript(),
    fetchBookingConfig(descriptor.widgetId)
  ])
  .then(function(results) {
    var config = results[1];
    if (!config) {
      placeholder.textContent = "Sorry, the booking lookup form couldn't load. You can contact us directly instead.";
      return;
    }
    if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    try {
      new window.TGMyBookingWidget(mount, config);
    } catch (err) {
      console.error("Luna widget: failed to init booking widget:", err);
      var errEl = document.createElement("div");
      errEl.className = "tgx-booking-loading";
      errEl.textContent = "Sorry, the booking lookup form couldn't load. You can contact us directly instead.";
      mount.appendChild(errEl);
    }
  })
  .catch(function(err) {
    console.error("Luna widget: booking widget script failed:", err);
    placeholder.textContent = "Sorry, the booking lookup form couldn't load. You can contact us directly instead.";
  });
}

function addMsg(role, text, noStore, originalText) {
  /* Booking widget embed — special role */
  if (role === "widget") {
    /* "text" is actually a descriptor object: { kind: "booking_lookup", widgetId: "rec..." } */
    renderBookingWidgetMessage(text);
    if (!noStore) {
      msgs.push({ role: "widget", content: text, ts: Date.now() });
      saveSession();
    }
    return;
  }

  var row = document.createElement("div");
  row.className = "tgx-msg-row" + (role === "user" ? " user" : "");

  /* Avatar for bot/agent messages */
  if (role === "bot" || role === "agent") {
    row.appendChild(makeAvatar(26, false));
  }

  var col = document.createElement("div");
  col.className = "tgx-msg-col";

  if (role === "system") {
    var sysDiv = document.createElement("div");
    sysDiv.className = "tgx-msg system";
    sysDiv.textContent = text;
    $msgs.appendChild(sysDiv);
  } else {
    var bubble = document.createElement("div");
    bubble.className = "tgx-msg " + role;
    /* SAFE RENDERING: build DOM nodes programmatically, never innerHTML with untrusted content.
       Supports: **bold**, *italic*, [label](url), bare deep-link URLs, and \n -> <br>. */
    renderSafeMarkdown(bubble, text);
    col.appendChild(bubble);

    /* Timestamp */
    var timeEl = document.createElement("span");
    timeEl.className = "tgx-msg-time";
    var now = new Date();
    timeEl.textContent = ("0"+now.getHours()).slice(-2) + ":" + ("0"+now.getMinutes()).slice(-2);
    col.appendChild(timeEl);

    row.appendChild(col);
    $msgs.appendChild(row);
  }

  if (!noStore) { msgs.push({role:role, content:text, original:originalText||null, ts:Date.now()}); saveSession(); }
  scrollBottom();

  /* Show email link after 3+ messages */
  if ($emailBar && msgs.length >= 3) {
    $emailBar.style.display = "block";
  }
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

/* ─── EMAIL THIS CHAT ────────────────────────────────────── */
function buildTranscript() {
  var lines = [];
  msgs.forEach(function(m) {
    if (m.role === "system" || m.role === "widget") return;
    var d = new Date(m.ts);
    var time = ("0"+d.getHours()).slice(-2) + ":" + ("0"+d.getMinutes()).slice(-2);
    var sender = m.role === "user" ? "You" : m.role === "agent" ? "Agent" : (C.name || "Luna AI");
    var line = sender + " (" + time + "): " + m.content;
    if (m.original) line += "\n  [Original: " + m.original + "]";
    lines.push(line);
  });
  return lines.join("\n\n");
}

function openMailto(email) {
  var today = new Date().toLocaleDateString("en-GB", {day:"numeric",month:"long",year:"numeric"});
  var subject = "Chat transcript — " + (C.clientName || C.name);
  var header = "Here's a copy of your conversation with " + (C.name || "Luna AI") + " at " + (C.clientName || "") + " on " + today + "\n\n---\n\n";
  var body = header + buildTranscript();
  window.location.href = "mailto:" + encodeURIComponent(email) + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}

function handleEmailChat() {
  if (visitorEmail) {
    openMailto(visitorEmail);
  } else {
    var bar = $emailBar;
    bar.innerHTML = '';
    var wrap = document.createElement("div");
    wrap.className = "tgx-email-inline";
    wrap.innerHTML = '<input type="email" id="tgxInlineEmail" placeholder="Enter your email"><button id="tgxInlineEmailGo">Send</button><button class="tgx-email-cancel" id="tgxInlineEmailX">Cancel</button>';
    bar.appendChild(wrap);
    bar.style.display = "block";
    setTimeout(function(){
      var inp = document.getElementById("tgxInlineEmail");
      inp.focus();
      document.getElementById("tgxInlineEmailGo").addEventListener("click", function(){
        var em = inp.value.trim();
        if (em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
          visitorEmail = em; openMailto(em);
          bar.innerHTML = '<span class="tgx-email-link" id="tgxEmailLink">&#128231; Email this chat</span>';
          document.getElementById("tgxEmailLink").addEventListener("click", handleEmailChat);
        }
      });
      document.getElementById("tgxInlineEmailX").addEventListener("click", function(){
        bar.innerHTML = '<span class="tgx-email-link" id="tgxEmailLink">&#128231; Email this chat</span>';
        document.getElementById("tgxEmailLink").addEventListener("click", handleEmailChat);
      });
      inp.addEventListener("keydown", function(e){ if (e.key === "Enter") { e.preventDefault(); document.getElementById("tgxInlineEmailGo").click(); } });
    }, 50);
  }
}

/* ─── ABLY: init (capability token auth) ───────────────────── */
function initAbly() {
  if (!window.Ably) {
    console.warn("Luna widget: Ably SDK not loaded, real-time disabled");
    return;
  }
  if (!C.ablyTokenEndpoint) {
    console.warn("Luna widget: no ablyTokenEndpoint configured, real-time disabled");
    return;
  }
  if (!convId) convId = "conv_" + Date.now() + "_" + Math.random().toString(36).substr(2,6);

  /* authCallback: Ably SDK calls this when it needs a token, and whenever the
     current token is near expiry. We never hold a root key client-side. */
  function authCallback(tokenParams, callback) {
    fetch(C.ablyTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: convId, clientName: C.clientName })
    })
    .then(function(r) {
      if (!r.ok) throw new Error("Token endpoint returned " + r.status);
      return r.json();
    })
    .then(function(tokenDetails) { callback(null, tokenDetails); })
    .catch(function(err) {
      console.error("Luna widget: Ably token fetch failed:", err.message);
      callback(err, null);
    });
  }

  ably = new Ably.Realtime({
    authCallback: authCallback,
    clientId: "visitor_" + convId
  });

  dashChannel = ably.channels.get("luna-dashboard");
  chatChannel = ably.channels.get("luna-chat:" + convId);
  agentsChannel = ably.channels.get("luna-agents");

  chatChannel.subscribe("message", function(msg){
    var d = msg.data;
    if (d && d.from === "agent") {
      if (d.translateTo) {
        translateText(d.text, d.translateTo).then(function(translated) {
          addMsg("agent", translated, false, d.text);
          if (!panelOpen) { unread++; $badge.textContent = unread; $badge.style.display = "flex"; }
        });
      } else {
        addMsg("agent", d.text);
        if (!panelOpen) { unread++; $badge.textContent = unread; $badge.style.display = "flex"; }
      }
    }
  });

  chatChannel.subscribe("handler_change", function(msg){
    var d = msg.data;
    if (!d) return;
    if (d.handler === "agent" || (d.handler && d.handler !== "waiting" && d.handler !== "ai")) {
      addMsg("system", (d.agentName || "An agent") + " has joined the chat.");
      liveMode = true;
      $escBar.classList.remove("active");
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
      $escBar.classList.add("active");
    }
  });

  chatChannel.subscribe("typing", function(msg){
    var d = msg.data;
    if (d && d.from === "agent") {
      $typing.classList.add("active");
      scrollBottom();
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(function(){ $typing.classList.remove("active"); }, 2000);
    }
  });

  ably.connection.on("connected", function(){
    console.log("Luna widget: Ably connected (token auth), convId=" + convId);
  });

  ably.connection.on("failed", function(err){
    console.error("Luna widget: Ably connection failed:", err && err.reason);
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
      visitorId: visitorId,
      lang: conversationLang || "English"
    },
    handler: "ai",
    startedAt: now,
    messages: msgs.filter(function(m){return m.role !== "widget";}).map(function(m){ return {from: m.role === "user" ? "visitor" : m.role, text: m.content, timestamp: new Date(m.ts).toISOString()}; })
  });

  if (C.airtableKey && C.airtableBase && C.convTable) {
    var botHistory = msgs.filter(function(m){return m.role!=="system" && m.role!=="widget";}).map(function(m){return m.role+": "+m.content;}).join("\n");
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

/* ─── TRANSLATION ────────────────────────────────────────── */
async function translateText(text, targetLang) {
  try {
    var res = await fetch(C.endpoint.replace("/api/luna-chat", "/api/translate"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({text: text, targetLang: targetLang})
    });
    if (res.ok) { var data = await res.json(); return data.translated || data.text || text; }
  } catch(e) { console.warn("Luna widget: translation failed:", e.message); }
  return text;
}

function publishMessage(from, text) {
  if (!chatChannel) return;
  chatChannel.publish("message", { from: from, text: text, lang: conversationLang || "English", timestamp: new Date().toISOString() });
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
    +'<input type="text" id="tgxHpIn" class="tgx-hp" tabindex="-1" autocomplete="off">'
    +'<label class="tgx-check" id="tgxMarketingLabel">'
    +'<input type="checkbox" id="tgxMarketingIn">'
    +'<span class="tgx-cb"><svg viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
    +'<span class="tgx-cb-label">I\'d like to receive offers and updates</span>'
    +'</label>'
    +'<button class="tgx-obtn" id="tgxNameGo">Continue</button>'
    +'<button class="tgx-olink" id="tgxNameSkip">'+C.skipLabel+'</button>';
  if (C.privacyUrl) {
    html += '<a class="tgx-privacy" href="'+C.privacyUrl+'" target="_blank" rel="noopener">See our privacy policy</a>';
  }
  ov.innerHTML = html;
  $panel.appendChild(ov);
  var formOpenedAt = Date.now();
  setTimeout(function(){
    var ni = document.getElementById("tgxNameIn");
    var ei = document.getElementById("tgxEmailIn");
    var mi = document.getElementById("tgxMarketingIn");
    var hp = document.getElementById("tgxHpIn");
    ni.focus();
    function doSubmit() {
      if (hp && hp.value) { ov.innerHTML = '<h3>Something went wrong</h3><p>Please refresh the page and try again.</p>'; return; }
      if (Date.now() - formOpenedAt < 2000) { ov.innerHTML = '<h3>Something went wrong</h3><p>Please refresh the page and try again.</p>'; return; }
      userName = ni.value.trim();
      visitorEmail = ei.value.trim();
      marketingConsent = mi.checked;
      nameCollected = true;
      var emailValid = visitorEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(visitorEmail);
      if (emailValid && marketingConsent) {
        fetch(C.endpoint.replace("/api/luna-chat", "/api/subscribe"), {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ clientName: C.clientName, name: userName, email: visitorEmail })
        }).catch(function(e){ console.warn("Luna widget: subscribe error:", e); });
      }
      saveSession();
      ov.remove();
      /* Home screen is already visible underneath — no need to switch */
    }
    document.getElementById("tgxNameGo").addEventListener("click", doSubmit);
    document.getElementById("tgxNameSkip").addEventListener("click", function(){
      userName = ""; visitorEmail = ""; marketingConsent = false; nameCollected = true;
      saveSession();
      ov.remove();
      /* Home screen is already visible underneath */
    });
    ni.addEventListener("keydown", function(e){ if (e.key === "Enter") { e.preventDefault(); ei.focus(); } });
    ei.addEventListener("keydown", function(e){ if (e.key === "Enter") { e.preventDefault(); doSubmit(); } });
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
  if (dashChannel) {
    dashChannel.publish("new_conversation", {
      convId: convId, visitor: {name: userName || "Anonymous", email: email, page: window.location.href},
      handler: "closed", startedAt: now,
      messages: [{from: "visitor", text: "[Left a message] " + message, timestamp: now}]
    });
  }
  if (C.airtableKey && C.airtableBase && C.convTable) {
    var botHistory = msgs.filter(function(m){return m.role!=="system" && m.role!=="widget";}).map(function(m){return m.role+": "+m.content;}).join("\n");
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

/* ─── RATING OVERLAY ─────────────────────────────────────── */
function showRatingOverlay(ratingChannel) {
  var T = getTokens();
  var ov = document.createElement("div");
  ov.className = "tgx-overlay";
  ov.id = "tgxRatingOv";
  ov.innerHTML = '<h3>How was your experience?</h3><p>Rate your conversation</p>'
    +'<div class="tgx-stars" id="tgxStars">'
    +'<span class="tgx-star" data-v="1">&#9733;</span><span class="tgx-star" data-v="2">&#9733;</span>'
    +'<span class="tgx-star" data-v="3">&#9733;</span><span class="tgx-star" data-v="4">&#9733;</span>'
    +'<span class="tgx-star" data-v="5">&#9733;</span></div>'
    +'<button class="tgx-olink" id="tgxRatingSkip">Skip</button>';
  $panel.appendChild(ov);
  setTimeout(function(){
    var stars = ov.querySelectorAll(".tgx-star");
    stars.forEach(function(star){
      star.addEventListener("mouseenter", function(){
        var val = parseInt(this.getAttribute("data-v"));
        stars.forEach(function(s){
          s.style.cssText = parseInt(s.getAttribute("data-v")) <= val ? "color:#FFD60A;transform:scale(1.15)" : "color:"+T.text3+";transform:scale(1)";
        });
      });
      star.addEventListener("click", function(){
        var val = parseInt(this.getAttribute("data-v"));
        if (ratingChannel) ratingChannel.publish("rating", {rating: val});
        ov.innerHTML = '<h3>Thanks for your feedback!</h3><p>You can start a new chat anytime.</p>';
        setTimeout(function(){ if (ov.parentNode) ov.remove(); }, 2000);
      });
    });
    var sc = document.getElementById("tgxStars");
    if (sc) sc.addEventListener("mouseleave", function(){ stars.forEach(function(s){ s.style.cssText = "color:"+T.text3+";transform:scale(1)"; }); });
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
        message: userText, convId: convId, visitorName: userName || undefined,
        clientName: C.clientName, history: history.slice(-16), page: window.location.pathname
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
    if (data.detectedLanguage) conversationLang = data.detectedLanguage;
    saveSession();
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
  /* Ensure we're on chat screen */
  if (currentScreen !== "chat") switchToChat();
  addMsg("user", text);
  $input.value = "";
  $input.disabled = true;
  $typing.classList.add("active");
  scrollBottom();

  ensureConversationStarted();
  publishMessage("visitor", text);

  var data = await callLuna(text);
  $typing.classList.remove("active");

  /* Strip [BOOKING_LOOKUP:rec...] marker BEFORE [FQ]/[OPT] parsing,
     so the form shows below the bot's text. */
  var rawReply = data.reply || "";
  var bookingExtracted = extractBookingLookupMarker(rawReply);
  var workingReply = bookingExtracted.cleanText;

  var parsed = parseResponse(workingReply);
  if (parsed.body) {
    addMsg("bot", parsed.body);
    publishMessage("ai", parsed.body);
  }

  /* If a booking widget marker was found, render the embedded widget */
  if (bookingExtracted.widgetId) {
    addMsg("widget", { kind: "booking_lookup", widgetId: bookingExtracted.widgetId });
  }

  /* Auto-redirect for search deep links (same tab) */
  var deepLinkMatch = (data.reply || "").match(/(https?:\/\/dl\.tvllnk\.com[^\s\)\]"<>]+)/i);
  if (deepLinkMatch) {
    saveSession();
    setTimeout(function(){ window.location.href = deepLinkMatch[1]; }, 1500);
    $input.disabled = false;
    return;
  }

  if (data.escalate === true) setTimeout(function(){ escalateToHuman(); }, 100);

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
  clearPills(); addMsg("user", text);
  $input.value = "";
  publishMessage("visitor", text);
}

/* ─── ESCALATE TO HUMAN ─────────────────────────────────── */
async function escalateToHuman() {
  if (liveMode) return;
  if (currentScreen !== "chat") switchToChat();
  clearPills();

  /* Check if any agents are online via Ably presence */
  var agentsOnline = false;
  if (agentsChannel) {
    try {
      var members = await agentsChannel.presence.get();
      agentsOnline = members && members.length > 0;
    } catch(e) {
      console.warn("Luna widget: presence check failed:", e.message);
    }
  }

  if (agentsOnline) {
    /* Agents are online — real escalation */
    addMsg("system", "Connecting you to our team...");
    ensureConversationStarted();
    publishHandlerChange("waiting");

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
    $escBar.classList.remove("active");
    addMsg("system", "You're in the queue. An agent will be with you shortly.");
  } else {
    /* No agents online */
    addMsg("system", "Sorry, there are no agents available right now. You can leave us a message and we'll get back to you, or you can carry on chatting with " + C.name + ".");
    showPills(["Leave a message", "Continue chatting"], function(choice) {
      if (choice === "Leave a message") {
        showLeaveOverlay();
      } else {
        clearPills();
        addMsg("system", "No problem! I'm still here to help. What can I do for you?");
        $input.focus();
      }
    });
  }
}

/* ─── START CHAT ─────────────────────────────────────────── */
function startChat() {
  var welcomeText = C.welcome;
  if (userName) welcomeText = "Hey " + userName + "! " + welcomeText.replace(/^Hey there! /, "").replace(/^Hey there\b/, "");
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
  /* Fetch remote config */
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

  /* Country detection */
  try {
    var geoRes = await fetch("https://ipapi.co/json/");
    if (geoRes.ok) { var geoData = await geoRes.json(); visitorCountry = geoData.country_code || ""; }
  } catch(e) {}

  /* Restore session (name, messages, convId) from previous page */
  sessionRestored = restoreSession();

  injectCSS();
  buildDOM();

  $fab = document.getElementById("tgxFab");
  $panel = document.getElementById("tgxPanel");
  $msgs = document.getElementById("tgxMsgs");
  $input = document.getElementById("tgxInput");
  $send = document.getElementById("tgxSend");
  $pills = document.getElementById("tgxPills");
  $typing = document.getElementById("tgxTypingRow");
  $badge = document.getElementById("tgxBadge");
  $escBar = document.getElementById("tgxEscBar");
  $emailBar = document.getElementById("tgxEmailBar");

  /* Replay stored messages if session was restored */
  if (sessionRestored && msgs.length > 0) {
    var storedMsgs = msgs.slice();
    msgs = []; /* clear so addMsg re-pushes them */
    storedMsgs.forEach(function(m) {
      if (m.role === "widget") {
        /* "content" is the descriptor object — pass through as text param */
        addMsg("widget", m.content, false);
      } else {
        addMsg(m.role, m.content, false, m.original);
      }
    });
    if (currentScreen === "chat") {
      document.getElementById("tgxChatScreen").classList.remove("hidden");
      document.getElementById("tgxHomeScreen").classList.add("hidden");
    }
  }

  $send.addEventListener("click", handleSend);
  $input.addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (liveMode && chatChannel) chatChannel.publish("typing", {from: "visitor"});
  });

  document.getElementById("tgxHuman").addEventListener("click", escalateToHuman);
  document.getElementById("tgxLeave").addEventListener("click", showLeaveOverlay);
  document.getElementById("tgxEmailLink").addEventListener("click", handleEmailChat);

  /* Home screen nav */
  document.getElementById("tgxBackHome").addEventListener("click", switchToHome);
  document.getElementById("tgxDemotedHuman").addEventListener("click", function(){ switchToChat(); escalateToHuman(); });
  document.getElementById("tgxDemotedLeave").addEventListener("click", function(){ switchToChat(); showLeaveOverlay(); });

  /* Open/close */
  function openChat() {
    cancelAutoTrigger();
    panelOpen = true;
    $panel.classList.add("open");
    $fab.classList.add("open");
    unread = 0;
    $badge.style.display = "none";
    if (!nameCollected && C.collectName) {
      showNameOverlay();
    }
  }
  function closeChat() {
    panelOpen = false;
    $panel.classList.remove("open");
    $fab.classList.remove("open");
  }

  document.getElementById("tgxHomeClose").addEventListener("click", closeChat);
  document.getElementById("tgxChatClose").addEventListener("click", closeChat);

  $fab.addEventListener("click", function(){
    if (panelOpen) closeChat(); else openChat();
  });

  window.openLunaChat = openChat;
  window.closeLunaChat = closeChat;

  loadAbly(function(){ initAbly(); });

  /* Auto-trigger */
  var at = C.autoTrigger;
  if (at && at.enabled && at.delay && at.message) {
    var alreadyTriggered = false;
    try { alreadyTriggered = sessionStorage.getItem("luna_auto_triggered") === "1"; } catch(e) {}
    var isMobileHidden = C.mobileBubble === "hidden" && window.innerWidth < 440;

    if (!alreadyTriggered && !isMobileHidden) {
      autoTriggerTimer = setTimeout(function() {
        if (visitorInteracted || panelOpen || msgs.length > 0 || autoTriggered) return;
        autoTriggered = true;
        try { sessionStorage.setItem("luna_auto_triggered", "1"); } catch(e) {}

        panelOpen = true;
        $panel.classList.add("open");
        $fab.classList.add("open");

        if (!nameCollected) nameCollected = true;
        switchToChat();
        addMsg("bot", at.message);
        if (C.hints && C.hints.length > 0) showPills(C.hints, function(h){ sendToAI(h); });
        if (!document.hidden) playNotifSound();
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
