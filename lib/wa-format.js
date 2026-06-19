// lib/wa-format.js
// Provider-AGNOSTIC formatting helpers: turn Luna's rich reply into clean
// WhatsApp text, and chunk long messages. Kept separate from
// lib/whatsapp-provider.js on purpose — formatting does not change when we swap
// 360dialog for direct Meta, so it must not live behind the provider seam.

const blockParser = require('./block-parser');

const WA_MAX_BODY = 4096; // WhatsApp hard limit for a text body

// Luna can emit [BLOCK]{...}[/BLOCK] cards (destination/offer/handoff etc.) that
// only the web widget can render. On WhatsApp we keep the conversational prose
// and drop the card markup, then map Luna's small markdown subset onto
// WhatsApp's own formatting (*bold*, _italic_).
function toPlainText(reply) {
  if (typeof reply !== 'string' || !reply) return '';
  var prose = '';
  try {
    var items = blockParser.parseLunaResponse(reply);
    if (items && items.length) {
      prose = items
        .filter(function (i) { return i.type === 'prose'; })
        .map(function (i) { return i.text; })
        .join('\n\n');
    }
  } catch (e) { /* fall through to raw strip */ }
  if (!prose.trim()) {
    prose = reply.replace(/\[BLOCK\][\s\S]*?\[\/BLOCK\]/g, ' ');
  }
  return mdToWhatsApp(prose);
}

function mdToWhatsApp(s) {
  return String(s)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)') // [text](url) -> text (url)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')                        // **bold** -> *bold*
    .replace(/__([^_\n]+)__/g, '*$1*')
    .replace(/^\s{0,3}#{1,6}\s*(.+?)\s*#*\s*$/gm, '*$1*')         // # heading -> *heading*
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Long replies are split on paragraph boundaries so each chunk fits the limit.
function splitForWhatsApp(text, max) {
  max = max || 3900; // headroom under the 4096 cap
  var s = String(text || '');
  if (s.length <= max) return [s || ''];
  var chunks = [];
  var paras = s.split('\n\n');
  var cur = '';
  for (var i = 0; i < paras.length; i++) {
    var p = paras[i];
    if (p.length > max) {
      if (cur) { chunks.push(cur); cur = ''; }
      for (var j = 0; j < p.length; j += max) { chunks.push(p.slice(j, j + max)); }
      continue;
    }
    var candidate = cur ? (cur + '\n\n' + p) : p;
    if (candidate.length > max) { if (cur) chunks.push(cur); cur = p; }
    else { cur = candidate; }
  }
  if (cur) chunks.push(cur);
  return chunks.length ? chunks : [s.slice(0, max)];
}

module.exports = {
  WA_MAX_BODY: WA_MAX_BODY,
  toPlainText: toPlainText,
  mdToWhatsApp: mdToWhatsApp,
  splitForWhatsApp: splitForWhatsApp
};
