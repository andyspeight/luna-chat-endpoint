// Luna Widget Config API v2 — returns brandColor + accentColor + theme mode
// Backwards compatible: maps old theme names to new brand/accent system

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

/* ── Map old theme names → new brand/accent/mode ─────────── */
const THEME_MAP = {
  dark:    { mode: "dark",  brandColor: "#0A84FF", accentColor: "#64D2FF" },
  light:   { mode: "light", brandColor: "#0A84FF", accentColor: "#0A84FF" },
  ocean:   { mode: "dark",  brandColor: "#0077B6", accentColor: "#00B4D8" },
  emerald: { mode: "dark",  brandColor: "#059669", accentColor: "#10B981" },
  sunset:  { mode: "dark",  brandColor: "#F97316", accentColor: "#FB923C" },
  rose:    { mode: "light", brandColor: "#E11D48", accentColor: "#FB7185" }
};

/* ── Map old size names → new preset names ───────────────── */
const SIZE_MAP = {
  compact:  "small",
  standard: "medium",
  large:    "large",
  // Also accept new names directly
  small:    "small",
  medium:   "medium"
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

    /* ── Colours: new fields take priority, fall back to old theme name ── */
    if (f.BrandColor) {
      // New system: explicit brand + accent colours
      config.brandColor = f.BrandColor;
      config.accentColor = f.AccentColor || f.BrandColor;
      config.theme = (f.ThemeMode || f.WidgetTheme || 'light').toLowerCase();
      // Normalise: if theme is a named theme, extract just the mode
      if (config.theme !== 'light' && config.theme !== 'dark') {
        var mapped = THEME_MAP[config.theme];
        config.theme = mapped ? mapped.mode : 'light';
      }
    } else {
      // Old system: map theme name to brand/accent/mode
      var themeName = (f.WidgetTheme || 'dark').toLowerCase();
      var mapped = THEME_MAP[themeName] || THEME_MAP.dark;
      config.brandColor = mapped.brandColor;
      config.accentColor = mapped.accentColor;
      config.theme = mapped.mode;
    }

    /* ── Size: new field takes priority, fall back to old size name ── */
    if (f.WidgetSizeV2) {
      config.widgetSize = f.WidgetSizeV2.toLowerCase();
    } else {
      var sizeName = (f.WidgetSize || 'standard').toLowerCase();
      config.widgetSize = SIZE_MAP[sizeName] || 'medium';
    }

    /* ── Identity ── */
    if (f.WidgetBotName) config.name = f.WidgetBotName;
    if (f.WidgetTagline) config.tagline = f.WidgetTagline;
    if (f.LogoText) config.logoText = f.LogoText;
    if (f.ClientName) config.clientName = f.ClientName;

    /* ── Business types (multi-select) ── */
    if (f.BusinessTypes && Array.isArray(f.BusinessTypes)) {
      config.businessTypes = f.BusinessTypes.map(function(t) { return typeof t === 'object' ? t.name : t; });
    } else if (f.BusinessType) {
      /* Backwards compat with old single select */
      config.businessTypes = [typeof f.BusinessType === 'object' ? f.BusinessType.name : f.BusinessType];
    }

    /* ── Profile image (attachment or URL) ── */
    if (f.ProfileImage) {
      if (Array.isArray(f.ProfileImage) && f.ProfileImage.length > 0) {
        // Airtable attachment field
        config.profileImage = f.ProfileImage[0].url;
      } else if (typeof f.ProfileImage === 'string') {
        config.profileImage = f.ProfileImage;
      }
    }

    /* ── Bubble icon (attachment or URL) ── */
    if (f.BubbleIcon) {
      if (Array.isArray(f.BubbleIcon) && f.BubbleIcon.length > 0) {
        config.bubbleIcon = f.BubbleIcon[0].url;
      } else if (typeof f.BubbleIcon === 'string') {
        config.bubbleIcon = f.BubbleIcon;
      }
    }

    /* ── Content ── */
    if (f.WidgetWelcome) config.welcome = f.WidgetWelcome;
    if (f.WidgetHints) {
      config.hints = f.WidgetHints.split('\n').filter(function(l) { return l.trim(); });
    }

    /* ── Footer ── */
    if (f.FooterText) config.footer = f.FooterText;

    /* ── Labels ── */
    if (f.EscalateLabel) config.escalateLabel = f.EscalateLabel;
    if (f.LeaveLabel) config.leaveLabel = f.LeaveLabel;
    if (f.NamePrompt) config.namePrompt = f.NamePrompt;
    if (f.SkipLabel) config.skipLabel = f.SkipLabel;

    /* ── Name collection ── */
    if (f.CollectName !== undefined) {
      config.collectName = !!f.CollectName;
    }

    /* ── Position ── */
    var fabPos = f.FabPosition || f.WidgetPosition;
    if (fabPos) {
      var posVal = (typeof fabPos === 'object' ? fabPos.name : fabPos) || 'bottom-right';
      config.fabPosition = posVal.toLowerCase();
      // Also set legacy position field for backwards compat
      config.position = posVal.toLowerCase().indexOf('left') !== -1 ? 'left' : 'right';
    }

    /* ── Mobile bubble ── */
    var mob = f.MobileBubble;
    if (mob) config.mobileBubble = (typeof mob === 'object' ? mob.name : mob) || 'normal';

    /* ── Border radius ── */
    if (f.BorderRadius) config.radius = f.BorderRadius + 'px';

    /* ── Auto-trigger ── */
    if (f.AutoTriggerEnabled) {
      config.autoTrigger = {
        enabled: true,
        delay: f.AutoTriggerDelay || 30,
        message: f.AutoTriggerMessage || 'Hi there! Can I help you find anything?'
      };
    }

    /* ── Privacy policy ── */
    if (f.PrivacyPolicyUrl) config.privacyUrl = f.PrivacyPolicyUrl;

    /* ── Capability cards (JSON array) ── */
    if (f.CapabilityCards) {
      try {
        var parsed = JSON.parse(f.CapabilityCards);
        if (Array.isArray(parsed)) config.capabilityCards = parsed;
      } catch(e) { /* ignore bad JSON */ }
    }

    return res.status(200).json(config);
  } catch (e) {
    console.warn('Widget config fetch error:', e.message);
    return res.status(200).json({});
  }
};
