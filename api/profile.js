// Luna Client Profile API
// Read and write business profile data

const crypto = require('crypto');
const auth = require('../lib/luna-auth');

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

// Timing-safe compare — avoids leaking the password via response timing.
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (e) { return false; }
}

// Secrets are never sent to the browser in the clear. A configured key is shown
// as a fixed mask; an empty one stays empty so the dashboard can tell them apart.
const SECRET_MASK = '••••••••••••';
function maskSecret(v) { return v ? SECRET_MASK : ''; }
// A value made only of bullet characters is the mask coming back unchanged on
// save — do NOT overwrite the stored secret with it.
function isMaskedSecret(v) { return typeof v === 'string' && v.length > 0 && /^[•]+$/.test(v); }

// CORS allowlist — origins that can call this endpoint.
const ALLOWED_ORIGINS = [
  'https://luna-chat-endpoint.vercel.app',
  'https://chat.travelify.io',
  'https://luna-chat.travelify.io',
  'http://localhost:3000',
  'http://localhost:5173'
];

function applyCors(req, res) {
  var origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    // Credentialed so the dashboard's tg_session cookie is sent (fetch must use
    // credentials:'include'). The spec forbids the '*' wildcard with credentials,
    // hence the exact-origin echo above.
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Slug, X-Client-Pass, X-Client-Name');
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  var slug = req.headers['x-client-slug'] || req.query.slug || '';
  var clientName = req.headers['x-client-name'] || req.query.name || '';
  var pass = req.headers['x-client-pass'] || req.query.pass || '';

  // Require at least a client identifier. Password is now optional because
  // the dashboard has migrated to central auth (tg-auth-gate) — the user is
  // authenticated at the gate, and the X-Client-Name is set from that session.
  if (!slug && !clientName) return res.status(400).json({ error: 'Missing client identifier' });

  // ── AUTH (fail fast, before any Airtable work) ──
  // Require a valid central session. Entitlement to the specific client is
  // checked below once the record is resolved. No cookie => rejected here with
  // no network call.
  var session = await auth.validateSession(req.headers.cookie || '');
  if (!session.ok) return res.status(session.status || 401).json({ error: session.error || 'Not signed in' });

  var atHeaders = { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' };

  // Find client by slug or name and (optionally) verify password
  try {
    var filterField = slug ? 'ClientSlug' : 'ClientName';
    var filterValue = slug || clientName;
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("{" + filterField + "}='" + filterValue.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: atHeaders });
    var sData = await sRes.json();

    if (!sData.records || sData.records.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    var record = sData.records[0];
    var fields = record.fields || {};

    // ── ENTITLEMENT ── The session (validated above) must be entitled to THIS
    // specific client. This endpoint reads AND writes tenant config: business
    // description and CustomQA feed Luna's system prompt, and the email-platform
    // key drives lead routing. Same posture as ably-token.js / whatsapp-send.js.
    var entitled = await auth.resolveEntitledClient(atKey, session, record.id);
    if (!entitled) return res.status(403).json({ error: 'Not entitled to this client' });

    // If this client has a DashboardPassword configured, it is REQUIRED and must
    // match (timing-safe). Previously the check was skipped whenever no password
    // header was sent, so anyone who knew a client's public name could read the
    // profile (including the stored email-platform key) and overwrite its config.
    // The dashboard always sends X-Client-Pass, so requiring it here is safe.
    if (fields.DashboardPassword) {
      if (!safeCompare(pass, fields.DashboardPassword)) {
        return res.status(401).json({ error: 'Invalid password' });
      }
    }

    // GET = read profile
    if (req.method === 'GET') {
      return res.status(200).json({
        profile: {
          clientName: fields.ClientName || '',
          email: fields.ContactEmail || '',
          address: fields.BusinessAddress || '',
          phone: fields.BusinessPhone || '',
          website: fields.BusinessWebsite || '',
          hours: fields.OpeningHours || '',
          specialisms: fields.Specialisms || '',
          destinations: fields.Destinations || '',
          bonding: fields.BondingInfo || '',
          description: fields.BusinessDescription || '',
          customQA: fields.CustomQA || '',
          widgetTheme: fields.WidgetTheme || 'dark',
          widgetWelcome: fields.WidgetWelcome || '',
          widgetHints: fields.WidgetHints || '',
          widgetBotName: fields.WidgetBotName || 'Luna AI',
          widgetSize: fields.WidgetSize || 'standard',
          widgetSizeV2: fields.WidgetSize || '',
          widgetPosition: fields.WidgetPosition ? (typeof fields.WidgetPosition === 'object' ? fields.WidgetPosition.name : fields.WidgetPosition) : 'right',
          mobileBubble: fields.MobileBubble ? (typeof fields.MobileBubble === 'object' ? fields.MobileBubble.name : fields.MobileBubble) : 'normal',
          /* v2 widget fields */
          brandColor: fields.BrandColor || '',
          accentColor: fields.AccentColor || '',
          themeMode: fields.ThemeMode || '',
          widgetTagline: fields.WidgetTagline || '',
          logoText: fields.LogoText || 'L',
          profileImage: fields.ProfileImage || '',
          bubbleIcon: fields.BubbleIcon || '',
          fabPosition: fields.FabPosition || '',
          collectName: fields.CollectName !== undefined ? !!fields.CollectName : true,
          capabilityCards: fields.CapabilityCards || '',
          businessType: fields.BusinessType ? (typeof fields.BusinessType === 'object' ? fields.BusinessType.name : fields.BusinessType) : '',
          businessTypes: Array.isArray(fields.BusinessTypes) ? fields.BusinessTypes.map(function(t) { return typeof t === 'object' ? t.name : t; }) : [],
          searchTypes: Array.isArray(fields.SearchTypes) ? fields.SearchTypes.map(function(t) { return typeof t === 'object' ? t.name : t; }) : [],
          autoTriggerEnabled: !!fields.AutoTriggerEnabled,
          autoTriggerDelay: fields.AutoTriggerDelay || 30,
          autoTriggerMessage: fields.AutoTriggerMessage || '',
          autoTriggerScrollDepth: fields.AutoTriggerScrollDepth || 0,
          autoTriggerExitIntent: !!fields.AutoTriggerExitIntent,
          autoTriggerUrlPatterns: fields.AutoTriggerUrlPatterns || '',
          privacyPolicyUrl: fields.PrivacyPolicyUrl || '',
          emailPlatform: fields.EmailPlatform ? (typeof fields.EmailPlatform === 'object' ? fields.EmailPlatform.name : fields.EmailPlatform) : 'none',
          // Never return the raw key. Masked for display; the boolean tells the
          // dashboard whether one is set without exposing it.
          emailPlatformApiKey: maskSecret(fields.EmailPlatformApiKey),
          emailPlatformApiKeySet: !!fields.EmailPlatformApiKey,
          emailPlatformListId: fields.EmailPlatformListId || '',
          multilingualEnabled: !!fields.MultilingualEnabled,
          supportedLanguages: fields.SupportedLanguages || '',
          cannedResponses: fields.CannedResponses || '',
          scannedUrls: fields.scannedUrls || '',
          scannedKnowledge: fields.scannedKnowledge || '',
          scannedAt: fields.scannedAt || '',
          scannedPageCount: fields.scannedPageCount || 0,
          autoRescan: !!fields.autoRescan
        }
      });
    }

    // POST = update profile
    if (req.method === 'POST') {
      var body = req.body || {};
      var updateFields = {};

      // Business profile fields
      if (body.address !== undefined) updateFields.BusinessAddress = body.address;
      if (body.phone !== undefined) updateFields.BusinessPhone = body.phone;
      if (body.website !== undefined) updateFields.BusinessWebsite = body.website;
      if (body.hours !== undefined) updateFields.OpeningHours = body.hours;
      if (body.specialisms !== undefined) updateFields.Specialisms = body.specialisms;
      if (body.destinations !== undefined) updateFields.Destinations = body.destinations;
      if (body.bonding !== undefined) updateFields.BondingInfo = body.bonding;
      if (body.description !== undefined) updateFields.BusinessDescription = body.description;
      if (body.customQA !== undefined) updateFields.CustomQA = body.customQA;

      // Widget appearance fields
      if (body.widgetTheme !== undefined) updateFields.WidgetTheme = body.widgetTheme;
      if (body.widgetWelcome !== undefined) updateFields.WidgetWelcome = body.widgetWelcome;
      if (body.widgetHints !== undefined) updateFields.WidgetHints = body.widgetHints;
      if (body.widgetBotName !== undefined) updateFields.WidgetBotName = body.widgetBotName;
      if (body.widgetSize !== undefined) updateFields.WidgetSize = body.widgetSize;
      // Dashboard sends widgetSizeV2 (new field name) — map it to the existing
      // Airtable WidgetSize column. Takes priority over the legacy widgetSize key.
      if (body.widgetSizeV2 !== undefined) updateFields.WidgetSize = body.widgetSizeV2;
      if (body.widgetPosition !== undefined) updateFields.WidgetPosition = body.widgetPosition;
      if (body.mobileBubble !== undefined) updateFields.MobileBubble = body.mobileBubble;
      /* v2 widget fields */
      if (body.brandColor !== undefined) updateFields.BrandColor = body.brandColor;
      if (body.accentColor !== undefined) updateFields.AccentColor = body.accentColor;
      if (body.themeMode !== undefined) updateFields.ThemeMode = body.themeMode;
      if (body.widgetTagline !== undefined) updateFields.WidgetTagline = body.widgetTagline;
      if (body.logoText !== undefined) updateFields.LogoText = body.logoText;
      if (body.profileImage !== undefined) updateFields.ProfileImage = body.profileImage;
      if (body.bubbleIcon !== undefined) updateFields.BubbleIcon = body.bubbleIcon;
      if (body.fabPosition !== undefined) updateFields.FabPosition = body.fabPosition;
      if (body.collectName !== undefined) updateFields.CollectName = !!body.collectName;
      if (body.capabilityCards !== undefined) updateFields.CapabilityCards = body.capabilityCards;
      if (body.businessType !== undefined) updateFields.BusinessType = body.businessType;
      if (body.businessTypes !== undefined) updateFields.BusinessTypes = body.businessTypes;
      if (body.searchTypes !== undefined) updateFields.SearchTypes = body.searchTypes;
      if (body.autoTriggerEnabled !== undefined) updateFields.AutoTriggerEnabled = body.autoTriggerEnabled;
      if (body.autoTriggerDelay !== undefined) updateFields.AutoTriggerDelay = parseInt(body.autoTriggerDelay) || 30;
      if (body.autoTriggerMessage !== undefined) updateFields.AutoTriggerMessage = body.autoTriggerMessage;
      if (body.autoTriggerScrollDepth !== undefined) updateFields.AutoTriggerScrollDepth = Math.max(0, Math.min(100, parseInt(body.autoTriggerScrollDepth) || 0));
      if (body.autoTriggerExitIntent !== undefined) updateFields.AutoTriggerExitIntent = !!body.autoTriggerExitIntent;
      if (body.autoTriggerUrlPatterns !== undefined) updateFields.AutoTriggerUrlPatterns = String(body.autoTriggerUrlPatterns || '').slice(0, 500);
      if (body.privacyPolicyUrl !== undefined) updateFields.PrivacyPolicyUrl = body.privacyPolicyUrl;
      if (body.emailPlatform !== undefined) updateFields.EmailPlatform = body.emailPlatform;
      // Preserve-on-save: if the dashboard sends back the mask unchanged, keep the
      // stored key. Only write a genuinely new value (or an explicit empty clear).
      if (body.emailPlatformApiKey !== undefined && !isMaskedSecret(body.emailPlatformApiKey)) updateFields.EmailPlatformApiKey = body.emailPlatformApiKey;
      if (body.emailPlatformListId !== undefined) updateFields.EmailPlatformListId = body.emailPlatformListId;
      if (body.multilingualEnabled !== undefined) updateFields.MultilingualEnabled = body.multilingualEnabled;
      if (body.supportedLanguages !== undefined) updateFields.SupportedLanguages = body.supportedLanguages;

      // Canned responses
      if (body.cannedResponses !== undefined) updateFields.CannedResponses = body.cannedResponses;

      // Website scanning fields
      if (body.scannedUrls !== undefined) updateFields.scannedUrls = body.scannedUrls;
      if (body.scannedKnowledge !== undefined) updateFields.scannedKnowledge = body.scannedKnowledge;
      if (body.scannedAt !== undefined) updateFields.scannedAt = body.scannedAt;
      if (body.scannedPageCount !== undefined) updateFields.scannedPageCount = parseInt(body.scannedPageCount) || 0;
      if (body.autoRescan !== undefined) updateFields.autoRescan = !!body.autoRescan;

      if (Object.keys(updateFields).length === 0) {
        return res.status(400).json({ error: 'No fields to update' });
      }

      var updateUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE + '/' + record.id;
      var uRes = await fetch(updateUrl, {
        method: 'PATCH',
        headers: atHeaders,
        body: JSON.stringify({ fields: updateFields, typecast: true })
      });

      if (!uRes.ok) {
        var errData = await uRes.json();
        throw new Error(errData.error?.message || 'Update failed');
      }

      return res.status(200).json({ success: true });
    }

    return res.status(405).json({ error: 'Method not allowed' });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};

// Exposed for unit testing only (does not change the handler contract).
module.exports._test = { maskSecret: maskSecret, isMaskedSecret: isMaskedSecret, safeCompare: safeCompare };
