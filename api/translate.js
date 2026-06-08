// Luna Translate API — translates text between languages using Claude Haiku

const Anthropic = require('@anthropic-ai/sdk');
const crypto = require('crypto');
const ratelimit = require('../lib/ratelimit');

// Simple cache to avoid re-translating identical text
const translateCache = {};
const CACHE_TTL = 24 * 60 * 60 * 1000;

// Daily cap for Anthropic calls from this endpoint (separate bucket to chat)
const DAILY_TRANSLATE_CAP = parseInt(process.env.LUNA_DAILY_TRANSLATE_CAP || '5000', 10);
const DAILY_TRANSLATE_KEY = 'luna-translate';

const MAX_TEXT = 2000;
const MAX_LANG = 40;

// Bound + sanitise a language name so it can't bloat or hijack the prompt.
// Keeps letters, spaces, hyphens and parentheses, e.g. "Portuguese (Brazil)".
function safeLang(v, fallback) {
  var s = (typeof v === 'string' ? v : '').trim().slice(0, MAX_LANG).replace(/[^A-Za-z \-()]/g, '').trim();
  return s || fallback;
}

// Full-text cache key (was: first 100 chars only, which collided for long
// messages sharing a prefix and ignored sourceLang).
function cacheKeyFor(text, targetLang, sourceLang) {
  return crypto.createHash('sha1')
    .update(sourceLang + '\u0000' + targetLang + '\u0000' + text)
    .digest('hex');
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Rate limit: 30 translations/minute/IP
  var rlResult = await ratelimit.checkIpAndKey(req, {
    ipKey: 'translate',
    ipMax: 30,
    ipWindowSecs: 60
  });
  if (!rlResult.allowed) {
    return res.status(429).json({ error: 'Too many translation requests' });
  }

  var body = req.body || {};
  var text = (body.text || '').trim();
  var targetLang = safeLang(body.targetLang, 'English');
  var sourceLang = safeLang(body.sourceLang, ''); // empty = auto-detect

  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (text.length > MAX_TEXT) return res.status(400).json({ error: 'Text too long (max ' + MAX_TEXT + ' chars)' });

  // Check cache (keyed on the full text + both languages)
  var cacheKey = cacheKeyFor(text, targetLang, sourceLang);
  var cached = translateCache[cacheKey];
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
    return res.status(200).json(cached.data);
  }

  try {
    // Global daily cap on Anthropic calls from this endpoint.
    // FAIL CLOSED: if the budget counter is unavailable we do NOT spend.
    var dailyCount;
    try {
      dailyCount = await ratelimit.incrDaily(DAILY_TRANSLATE_KEY, 1);
    } catch (capErr) {
      console.error('[translate] budget counter error — failing closed:', capErr.message);
      return res.status(429).json({ error: 'Translation service temporarily unavailable', original: text });
    }
    if (dailyCount === null) {
      console.error('[translate] budget counter unavailable — failing closed');
      return res.status(429).json({ error: 'Translation service temporarily unavailable', original: text });
    }
    if (dailyCount > DAILY_TRANSLATE_CAP) {
      console.error('[translate] Daily cap exceeded:', dailyCount, 'of', DAILY_TRANSLATE_CAP);
      return res.status(429).json({ error: 'Translation service temporarily unavailable', original: text });
    }

    var client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    var prompt = sourceLang
      ? 'Translate the following ' + sourceLang + ' text to ' + targetLang + '. Return ONLY the translation, nothing else. No quotes, no explanation, no preamble.\n\nText: ' + text
      : 'Detect the language of the following text, then translate it to ' + targetLang + '. Respond in this exact format:\nLANG: [detected language name in English]\nTRANSLATION: [translated text]\n\nIf the text is already in ' + targetLang + ', still return the format but repeat the text.\n\nText: ' + text;

    var response = await client.messages.create({
      model: process.env.LUNA_HAIKU_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }]
    });

    var reply = response.content
      .filter(function(b) { return b.type === 'text'; })
      .map(function(b) { return b.text; })
      .join('')
      .trim();

    var result = {};

    if (!sourceLang) {
      // Parse LANG: and TRANSLATION: format
      var langMatch = reply.match(/LANG:\s*(.+)/i);
      var transMatch = reply.match(/TRANSLATION:\s*([\s\S]+)/i);
      result = {
        detectedLanguage: langMatch ? langMatch[1].trim() : 'Unknown',
        translation: transMatch ? transMatch[1].trim() : reply,
        original: text
      };
    } else {
      result = {
        detectedLanguage: sourceLang,
        translation: reply,
        original: text
      };
    }

    // Cache
    translateCache[cacheKey] = { data: result, ts: Date.now() };

    // Clean old cache
    var now = Date.now();
    Object.keys(translateCache).forEach(function(k) {
      if (now - translateCache[k].ts > CACHE_TTL) delete translateCache[k];
    });

    return res.status(200).json(result);
  } catch (e) {
    console.warn('Translate error:', e.message);
    return res.status(500).json({ error: 'Translation failed', original: text });
  }
};
