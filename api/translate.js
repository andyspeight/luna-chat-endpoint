// Luna Translate API — translates text between languages using Claude Haiku

const Anthropic = require('@anthropic-ai/sdk');

// Simple cache to avoid re-translating identical text
const translateCache = {};
const CACHE_TTL = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  var body = req.body || {};
  var text = (body.text || '').trim();
  var targetLang = (body.targetLang || 'English').trim();
  var sourceLang = (body.sourceLang || '').trim(); // empty = auto-detect

  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (text.length > 2000) return res.status(400).json({ error: 'Text too long (max 2000 chars)' });

  // Check cache
  var cacheKey = text.slice(0, 100) + '|' + targetLang;
  var cached = translateCache[cacheKey];
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
    return res.status(200).json(cached.data);
  }

  try {
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
