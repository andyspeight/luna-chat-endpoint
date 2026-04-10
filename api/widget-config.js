// Luna Widget Config API — returns resolved theme colors + size

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

const THEMES = {
  dark: {bg:"#1C1C1E",headerBg:"#2C2C2E",bubbleBg:"#2C2C2E",userBubble:"#0A84FF",userText:"#FFFFFF",botText:"#E5E5EA",mutedText:"#8E8E93",accent:"#0A84FF",accentGlow:"#64D2FF",border:"rgba(255,255,255,0.08)",inputBg:"#2C2C2E",inputText:"#FFFFFF",buttonBg:"#0A84FF",buttonText:"#FFFFFF",pillBg:"rgba(10,132,255,0.12)",pillBorder:"rgba(10,132,255,0.3)",pillText:"#64D2FF",overlayBg:"rgba(0,0,0,0.7)",fabBg:"linear-gradient(135deg,#0A84FF,#5E5CE6)"},
  light: {bg:"#FFFFFF",headerBg:"#F8F9FA",bubbleBg:"#F1F3F5",userBubble:"#0A84FF",userText:"#FFFFFF",botText:"#1F2937",mutedText:"#9CA3AF",accent:"#0A84FF",accentGlow:"#0A84FF",border:"rgba(0,0,0,0.08)",inputBg:"#F1F3F5",inputText:"#1F2937",buttonBg:"#0A84FF",buttonText:"#FFFFFF",pillBg:"rgba(10,132,255,0.08)",pillBorder:"rgba(10,132,255,0.25)",pillText:"#0A84FF",overlayBg:"rgba(255,255,255,0.85)",fabBg:"linear-gradient(135deg,#0A84FF,#5E5CE6)"},
  ocean: {bg:"#0B1D3A",headerBg:"#0F2340",bubbleBg:"#15304D",userBubble:"#00B4D8",userText:"#FFFFFF",botText:"#E8EDF5",mutedText:"#5A6B85",accent:"#00B4D8",accentGlow:"#48CAE4",border:"rgba(136,153,179,0.12)",inputBg:"#0F2340",inputText:"#E8EDF5",buttonBg:"#00B4D8",buttonText:"#0B1D3A",pillBg:"rgba(0,180,216,0.12)",pillBorder:"rgba(0,180,216,0.3)",pillText:"#48CAE4",overlayBg:"rgba(11,29,58,0.85)",fabBg:"linear-gradient(135deg,#00B4D8,#0077B6)"},
  emerald: {bg:"#0F1A14",headerBg:"#162A1E",bubbleBg:"#1A3426",userBubble:"#10B981",userText:"#FFFFFF",botText:"#D1FAE5",mutedText:"#6B8A7A",accent:"#10B981",accentGlow:"#34D399",border:"rgba(16,185,129,0.12)",inputBg:"#162A1E",inputText:"#D1FAE5",buttonBg:"#10B981",buttonText:"#0F1A14",pillBg:"rgba(16,185,129,0.12)",pillBorder:"rgba(16,185,129,0.3)",pillText:"#34D399",overlayBg:"rgba(15,26,20,0.85)",fabBg:"linear-gradient(135deg,#10B981,#059669)"},
  sunset: {bg:"#1A1020",headerBg:"#251530",bubbleBg:"#2D1A3A",userBubble:"#F97316",userText:"#FFFFFF",botText:"#F5E6FF",mutedText:"#8B6B9E",accent:"#F97316",accentGlow:"#FB923C",border:"rgba(249,115,22,0.12)",inputBg:"#251530",inputText:"#F5E6FF",buttonBg:"#F97316",buttonText:"#1A1020",pillBg:"rgba(249,115,22,0.12)",pillBorder:"rgba(249,115,22,0.3)",pillText:"#FB923C",overlayBg:"rgba(26,16,32,0.85)",fabBg:"linear-gradient(135deg,#F97316,#EF4444)"},
  rose: {bg:"#FFF5F7",headerBg:"#FFF0F3",bubbleBg:"#FFE4E9",userBubble:"#E11D48",userText:"#FFFFFF",botText:"#1F2937",mutedText:"#9CA3AF",accent:"#E11D48",accentGlow:"#FB7185",border:"rgba(225,29,72,0.1)",inputBg:"#FFF0F3",inputText:"#1F2937",buttonBg:"#E11D48",buttonText:"#FFFFFF",pillBg:"rgba(225,29,72,0.08)",pillBorder:"rgba(225,29,72,0.2)",pillText:"#E11D48",overlayBg:"rgba(255,245,247,0.9)",fabBg:"linear-gradient(135deg,#E11D48,#BE123C)"}
};

const SIZES = {
  compact: {panelW:"340px",panelH:"520px",fabSize:"52px",radius:"16px"},
  standard: {panelW:"380px",panelH:"600px",fabSize:"60px",radius:"20px"},
  large: {panelW:"420px",panelH:"680px",fabSize:"64px",radius:"22px"}
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'public, max-age=60');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  var clientName = (req.query.client || '').trim();
  if (!clientName) return res.status(400).json({ error: 'Missing client parameter' });

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(200).json({});

  try {
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("LOWER({ClientName})='" + clientName.toLowerCase().replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: { 'Authorization': 'Bearer ' + atKey } });
    var sData = await sRes.json();

    if (!sData.records || sData.records.length === 0) {
      return res.status(200).json({});
    }

    var f = sData.records[0].fields || {};
    var config = {};

    // Resolve theme name to actual colors
    var themeName = (f.WidgetTheme || 'dark').toLowerCase();
    if (THEMES[themeName]) {
      config.theme = THEMES[themeName];
    }

    // Resolve size name to actual dimensions
    var sizeName = (f.WidgetSize || 'standard').toLowerCase();
    if (SIZES[sizeName]) {
      config.size = SIZES[sizeName];
    }

    // Pass through other config
    if (f.WidgetWelcome) config.welcome = f.WidgetWelcome;
    if (f.WidgetBotName) config.name = f.WidgetBotName;
    if (f.WidgetHints) {
      config.hints = f.WidgetHints.split('\n').filter(function(l) { return l.trim(); });
    }
    if (f.ClientName) config.clientName = f.ClientName;

    // Position
    var pos = f.WidgetPosition;
    if (pos) config.position = (typeof pos === 'object' ? pos.name : pos) || 'right';

    // Mobile bubble
    var mob = f.MobileBubble;
    if (mob) config.mobileBubble = (typeof mob === 'object' ? mob.name : mob) || 'normal';

    // Auto-trigger
    if (f.AutoTriggerEnabled) {
      config.autoTrigger = {
        enabled: true,
        delay: f.AutoTriggerDelay || 30,
        message: f.AutoTriggerMessage || 'Hi there! Can I help you find anything?'
      };
    }

    // Privacy policy
    if (f.PrivacyPolicyUrl) config.privacyUrl = f.PrivacyPolicyUrl;

    return res.status(200).json(config);
  } catch (e) {
    console.warn('Widget config fetch error:', e.message);
    return res.status(200).json({});
  }
};
