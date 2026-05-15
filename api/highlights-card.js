// api/highlights-card.js
// Travelgenix Luna Chat — highlights card composer.
//
// Returns a structured "wow" card for the expanded chat takeover, based on
// the page context. Resolution order:
//   1. Airtable override (hand-curated content for demo destinations)
//   2. Redis cache (7-day TTL)
//   3. Fresh AI generation (Claude Haiku — fast & cheap)
//
// Response shape:
//   {
//     heroEyebrow: "Africa · Where to start",
//     heroTitle: "Four ways in",
//     greeting: "Africa rewards curiosity...",
//     items: [
//       { icon: "🦁", eyebrow: "Wildlife", headline: "The classic safari",
//         description: "Kenya and Tanzania for the Great Migration..." },
//       ...
//     ],
//     pills: ["Best time to visit", "Family-friendly", "Honeymoon options"],
//     photo: { url, photographer, source, resolvedFrom }
//   }

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const photos = require('../lib/photos');

// Optional dependencies — wrap in try/catch so missing modules don't crash
let ratelimit = null;
try { ratelimit = require('../lib/ratelimit'); } catch (e) { /* optional */ }

// ─── Upstash Redis REST client (direct, no library) ───────────────────────
// Uses UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN env vars (these
// are already set in Vercel because rate limiting uses Upstash Redis).
// If env vars are missing, cache silently no-ops — feature still works,
// just regenerates every time.
async function upstashCall(commandParts) {
  var url = process.env.UPSTASH_REDIS_REST_URL;
  var token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    var fullUrl = url.replace(/\/+$/, '') + '/' +
                  commandParts.map(encodeURIComponent).join('/');
    var res = await fetch(fullUrl, {
      headers: { 'Authorization': 'Bearer ' + token },
      signal: AbortSignal.timeout(2000)
    });
    if (!res.ok) return null;
    var data = await res.json();
    return data && typeof data.result !== 'undefined' ? data.result : null;
  } catch (err) {
    console.warn('[highlights] Upstash call failed:', err.message);
    return null;
  }
}

// ─── Config ───────────────────────────────────────────────────────────────
const AT_BASE = 'app6Ot3eOb3DangkB';
const OVERRIDES_TABLE_ID = 'tblh4qgTW3yuDaTbu';
const CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const CACHE_KEY_PREFIX = 'highlights:v1:';

const ALLOWED_ORIGINS = [
  'https://traveldemo.site',
  'https://www.traveldemo.site',
  'https://travelgenix.io',
  'https://www.travelgenix.io'
];

// ─── CORS / origin allow ──────────────────────────────────────────────────
function setCors(req, res) {
  var origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1 || origin.endsWith('.site.travelify.io')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  } else {
    // For demo flexibility, allow any origin in dev mode; in production tighten this
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

// ─── Input sanitisation ───────────────────────────────────────────────────
function sanitiseText(s, maxLen) {
  if (typeof s !== 'string') return '';
  // Strip control chars except newline/tab; trim; cap length
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '').trim().slice(0, maxLen || 500);
}

function sanitisePageContext(pc) {
  if (!pc || typeof pc !== 'object') return null;
  return {
    title: sanitiseText(pc.title || '', 200),
    path: sanitiseText(pc.path || '', 300),
    url: sanitiseText(pc.url || '', 500),
    primaryContent: sanitiseText(pc.primaryContent || '', 1200)
  };
}

// ─── Cache key derivation ─────────────────────────────────────────────────
// Use path (not full URL) so query strings don't fragment the cache.
function deriveCacheKey(pageContext, clientName) {
  var path = (pageContext && pageContext.path) ? pageContext.path : '_root';
  var name = clientName || 'default';
  // Simple, deterministic, no collisions for our scale
  return CACHE_KEY_PREFIX + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + ':' +
         path.toLowerCase().replace(/[^a-z0-9/]+/g, '-').replace(/^-+|-+$/g, '');
}

// ─── Redis cache wrapper (via Upstash REST) ───────────────────────────────
async function getCached(key) {
  var raw = await upstashCall(['GET', key]);
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn('[highlights] cache JSON parse failed:', err.message);
    return null;
  }
}

async function setCached(key, value) {
  try {
    var json = JSON.stringify(value);
    // SET key value EX <ttl>
    await upstashCall(['SET', key, json, 'EX', String(CACHE_TTL_SECONDS)]);
  } catch (err) {
    console.warn('[highlights] cache write failed:', err.message);
  }
}

// ─── Airtable override lookup ─────────────────────────────────────────────
// Looks for a row in the Highlights Overrides table where Page Path matches.
// Field IDs (from table tblh4qgTW3yuDaTbu):
//   Page Path:       fldpTn2zwozlly3Vi (primary)
//   Client:          fldm8WE90uIqFOGOh
//   Hero Eyebrow:    fldDwfT8LVqxgERfn
//   Hero Title:      flddZFQWOyRtO3lhs
//   Greeting:        fldcRdYtEeSXJjVTI
//   Items JSON:      fldZ1cV6ic4Bzwqxi
//   Pills:           fldRzpnsNGEAajsuf
//   Hero Photo URL:  fld1ZVGzsfMOMTPkG
//   Active:          fldAnMedbfAl5xth7
async function lookupOverride(pageContext, clientRecordId) {
  if (!pageContext || !pageContext.path) return null;
  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return null;

  try {
    var path = pageContext.path.toLowerCase();
    // Filter: Active is true AND lowercased Page Path matches.
    // Reference by field name in formula (Airtable accepts both names and IDs).
    var formula = "AND({Active}=TRUE(), LOWER({Page Path})='" + path.replace(/'/g, "\\'") + "')";
    var url = 'https://api.airtable.com/v0/' + AT_BASE + '/' + OVERRIDES_TABLE_ID +
              '?filterByFormula=' + encodeURIComponent(formula) +
              '&maxRecords=1';

    var res = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + atKey },
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) {
      if (res.status !== 404) {
        console.warn('[highlights] override lookup non-OK:', res.status);
      }
      return null;
    }
    var data = await res.json();
    if (!data || !data.records || !data.records.length) return null;
    var rec = data.records[0];
    var f = rec.fields || {};

    // Optional client match — if clientRecordId provided and row has a Client link,
    // only match if they line up
    if (clientRecordId && f.Client && Array.isArray(f.Client)) {
      if (f.Client.indexOf(clientRecordId) === -1) return null;
    }

    // Parse Items JSON
    var items = [];
    if (f['Items JSON']) {
      try {
        var parsed = JSON.parse(f['Items JSON']);
        if (Array.isArray(parsed)) items = parsed;
      } catch (e) {
        console.warn('[highlights] override Items JSON parse failed:', e.message);
      }
    }
    if (!items.length) return null;

    var pills = [];
    if (f.Pills && typeof f.Pills === 'string') {
      pills = f.Pills.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    }

    return {
      heroEyebrow: f['Hero Eyebrow'] || '',
      heroTitle: f['Hero Title'] || '',
      greeting: f['Greeting'] || '',
      items: items.slice(0, 4),
      pills: pills.slice(0, 4),
      heroPhotoOverride: f['Hero Photo URL'] || null,
      _source: 'override'
    };
  } catch (err) {
    console.warn('[highlights] override lookup error:', err.message);
    return null;
  }
}

// ─── AI generation ────────────────────────────────────────────────────────
async function generateCard(pageContext) {
  var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  var pcText = '';
  if (pageContext && pageContext.title) pcText += 'Page title: ' + pageContext.title + '\n';
  if (pageContext && pageContext.path) pcText += 'Page path: ' + pageContext.path + '\n';
  if (pageContext && pageContext.primaryContent) {
    pcText += 'Page content excerpt:\n' + pageContext.primaryContent.slice(0, 800) + '\n';
  }

  var systemPrompt = [
    'You are Luna, an AI travel guide composing a HIGHLIGHTS CARD for a website visitor.',
    'The visitor is in DISCOVER / RESEARCH mode — they are NOT ready to book yet.',
    'They are on a page about a destination or travel topic.',
    '',
    'Your task: compose a structured "highlights card" with FOUR distinct angles on this destination/topic.',
    '',
    'Output ONLY a single JSON object — no preamble, no markdown fences, no commentary. Shape:',
    '{',
    '  "heroEyebrow": "<destination> · Where to start",',
    '  "heroTitle": "<3-4 word evocative title>",',
    '  "greeting": "<1-2 sentence warm intro for the chat bubble above the card>",',
    '  "items": [',
    '    { "icon": "<single emoji>", "eyebrow": "<1-2 word category>", "headline": "<3-6 word headline>", "description": "<1 sentence, 12-22 words>" },',
    '    ... 4 items total ...',
    '  ],',
    '  "pills": ["<2-5 word discover-mode prompt>", "<another>", "<another>"]',
    '}',
    '',
    'RULES:',
    '- Exactly 4 items, exactly 3 pills.',
    '- Each item is a DIFFERENT angle (e.g. wildlife, beaches, culture, landscape). Never four variations of the same thing.',
    '- Icons must be travel-relevant emojis (🦁🏖️🏛️⛰️🍷🚶✈️🌅 etc). Pick distinct icons per item.',
    '- Descriptions are SPECIFIC and CONFIDENT — mention real places, real seasons, real reasons. No generic phrases like "amazing experiences" or "something for everyone".',
    '- Pills are discover-mode only: NO "Book now", "Get a quote", "Check prices", "Speak to agent". Use research-mode prompts like "Best time to visit", "Hidden gems", "Family-friendly options".',
    '- Greeting is warm and informed, not salesy. Conversational.',
    '- For a continent or region page (Africa, Caribbean, etc), the items should be 4 different DESTINATION-TYPE angles within that region.',
    '- For a single destination page (Greece, Cape Town, etc), the items should be 4 different EXPERIENCE angles in that destination.',
    '- All text in UK English. No em-dashes (—). No Oxford comma.',
    '',
    'CONTEXT:',
    pcText
  ].join('\n');

  var response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    system: systemPrompt,
    messages: [{ role: 'user', content: 'Compose the highlights card now. Output only the JSON object.' }]
  });

  var text = '';
  if (response && response.content) {
    for (var i = 0; i < response.content.length; i++) {
      if (response.content[i].type === 'text') text += response.content[i].text;
    }
  }
  text = text.trim();

  // Strip code fences if any
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Find outermost {...}
  var firstBrace = text.indexOf('{');
  var lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  var parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    console.error('[highlights] AI returned non-JSON:', err.message, 'raw:', text.slice(0, 200));
    throw new Error('AI did not return valid JSON');
  }

  // Validate shape
  if (!parsed.items || !Array.isArray(parsed.items) || parsed.items.length === 0) {
    throw new Error('AI response missing items array');
  }

  // Sanitise — clamp lengths, ensure required fields
  var items = parsed.items.slice(0, 4).map(function(it) {
    return {
      icon: sanitiseText(it.icon || '✨', 4),
      eyebrow: sanitiseText(it.eyebrow || '', 30),
      headline: sanitiseText(it.headline || '', 60),
      description: sanitiseText(it.description || '', 200)
    };
  });

  var pills = Array.isArray(parsed.pills)
    ? parsed.pills.slice(0, 3).map(function(p) { return sanitiseText(p, 40); }).filter(Boolean)
    : [];

  return {
    heroEyebrow: sanitiseText(parsed.heroEyebrow || '', 60),
    heroTitle: sanitiseText(parsed.heroTitle || '', 40),
    greeting: sanitiseText(parsed.greeting || '', 300),
    items: items,
    pills: pills,
    _source: 'ai'
  };
}

// ─── Main handler ─────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Per-IP rate limit (light — 30/hour). Direct Upstash INCR with TTL.
  try {
    var ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
    var rlKey = 'highlights:rl:' + ip;
    var count = await upstashCall(['INCR', rlKey]);
    if (count === 1) {
      // First hit — set 1-hour TTL
      await upstashCall(['EXPIRE', rlKey, '3600']);
    }
    if (typeof count === 'number' && count > 30) {
      return res.status(429).json({ error: 'Too many requests' });
    }
  } catch (e) { /* rate limit failures must not block */ }

  var body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }

  var pageContext = sanitisePageContext(body.pageContext);
  var clientName = sanitiseText(body.clientName || '', 100);
  var clientRecordId = sanitiseText(body.clientRecordId || '', 30);

  if (!pageContext || (!pageContext.title && !pageContext.path)) {
    return res.status(400).json({ error: 'Missing or empty pageContext' });
  }

  var cacheKey = deriveCacheKey(pageContext, clientName);
  var card;
  var fromCache = false;

  try {
    // 1. Airtable override (always fresh — overrides bypass cache so edits go live immediately)
    var override = await lookupOverride(pageContext, clientRecordId);
    if (override) {
      card = override;
    } else {
      // 2. Redis cache
      var cached = await getCached(cacheKey);
      if (cached && cached.items && cached.items.length) {
        card = cached;
        fromCache = true;
      } else {
        // 3. Fresh AI generation
        card = await generateCard(pageContext);
        // Fire-and-forget cache write (but await it so Vercel doesn't kill it)
        await setCached(cacheKey, card);
      }
    }

    // Resolve hero photo (independent of card source — overrides may include
    // their own Hero Photo URL which takes precedence)
    var photo;
    if (card.heroPhotoOverride) {
      photo = {
        url: card.heroPhotoOverride,
        photographer: null,
        source: 'Override',
        resolvedFrom: 'override'
      };
    } else {
      photo = await photos.resolveHeroPhoto(pageContext);
    }

    return res.status(200).json({
      heroEyebrow: card.heroEyebrow,
      heroTitle: card.heroTitle,
      greeting: card.greeting,
      items: card.items,
      pills: card.pills,
      photo: photo,
      _meta: {
        source: card._source || 'unknown',
        fromCache: fromCache,
        cacheKey: cacheKey
      }
    });

  } catch (err) {
    console.error('[highlights] generation failed:', err.message);
    return res.status(500).json({
      error: 'Could not compose highlights card',
      detail: err.message
    });
  }
};
