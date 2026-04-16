// Luna Client Profile API
// Read and write business profile data

const AT_BASE = 'app6Ot3eOb3DangkB';
const AT_TABLE = 'tbl6CZ7aVzq1wHF2v';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Slug, X-Client-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();

  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Server not configured' });

  var slug = req.headers['x-client-slug'] || req.query.slug || '';
  var clientName = req.headers['x-client-name'] || req.query.name || '';
  var pass = req.headers['x-client-pass'] || req.query.pass || '';

  if ((!slug && !clientName) || !pass) return res.status(400).json({ error: 'Missing client credentials' });

  var atHeaders = { 'Authorization': 'Bearer ' + atKey, 'Content-Type': 'application/json' };

  // Find client by slug or name and verify password
  try {
    var filterField = slug ? 'ClientSlug' : 'ClientName';
    var filterValue = slug || clientName;
    var searchUrl = 'https://api.airtable.com/v0/' + AT_BASE + '/' + AT_TABLE
      + '?filterByFormula=' + encodeURIComponent("{" + filterField + "}='" + filterValue.replace(/'/g, "\\'") + "'")
      + '&maxRecords=1';
    var sRes = await fetch(searchUrl, { headers: atHeaders });
    var sData = await sRes.json();

    if (!sData.records || sData.records.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    var record = sData.records[0];
    var fields = record.fields || {};

    // Verify password
    if (fields.DashboardPassword !== pass) {
      return res.status(401).json({ error: 'Invalid password' });
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
          searchTypes: Array.isArray(fields.SearchTypes) ? fields.SearchTypes.map(function(t) { return typeof t === 'object' ? t.name : t; }) : [],
          autoTriggerEnabled: !!fields.AutoTriggerEnabled,
          autoTriggerDelay: fields.AutoTriggerDelay || 30,
          autoTriggerMessage: fields.AutoTriggerMessage || '',
          privacyPolicyUrl: fields.PrivacyPolicyUrl || '',
          emailPlatform: fields.EmailPlatform ? (typeof fields.EmailPlatform === 'object' ? fields.EmailPlatform.name : fields.EmailPlatform) : 'none',
          emailPlatformApiKey: fields.EmailPlatformApiKey || '',
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
      if (body.searchTypes !== undefined) updateFields.SearchTypes = body.searchTypes;
      if (body.autoTriggerEnabled !== undefined) updateFields.AutoTriggerEnabled = body.autoTriggerEnabled;
      if (body.autoTriggerDelay !== undefined) updateFields.AutoTriggerDelay = parseInt(body.autoTriggerDelay) || 30;
      if (body.autoTriggerMessage !== undefined) updateFields.AutoTriggerMessage = body.autoTriggerMessage;
      if (body.privacyPolicyUrl !== undefined) updateFields.PrivacyPolicyUrl = body.privacyPolicyUrl;
      if (body.emailPlatform !== undefined) updateFields.EmailPlatform = body.emailPlatform;
      if (body.emailPlatformApiKey !== undefined) updateFields.EmailPlatformApiKey = body.emailPlatformApiKey;
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
