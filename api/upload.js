// Luna File Upload — stores a chat attachment in Vercel Blob and returns a
// stable public URL for both the widget and the dashboard to render.
//
// WHY Vercel Blob: it gives permanent public URLs (chat images/files must keep
// displaying in transcripts), unlike Airtable attachment URLs which expire.
//
// Transport: raw binary body (bodyParser disabled) so we don't pay base64's
// ~33% inflation against the platform's ~4.5MB request cap. The file's name and
// type come from headers; the client is identified by ?clientName= and verified
// against Airtable (anti-abuse), exactly like api/conversation.js.
//
// Security: strict content-type allowlist, hard size cap, sanitised filename,
// random suffix (no overwrites / no guessable URLs), per-IP rate limit. The
// store is public-read by design (chat media is shared with the other party).
//
// POST (binary body): ?clientName=...  headers: Content-Type, X-Filename
// Returns: { url, name, contentType, size } | { error }
// Env: AIRTABLE_KEY, BLOB_READ_WRITE_TOKEN (set automatically when a Vercel
// Blob store is linked to the project).

const ratelimit = require('../lib/ratelimit');
const auth = require('../lib/luna-auth');

module.exports.config = { api: { bodyParser: false } };

const MAX_BYTES = 4 * 1024 * 1024; // 4MB (stays under the ~4.5MB platform cap)
const ALLOWED = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/csv': 'csv', 'text/plain': 'txt'
};

function isValidClientName(name) {
  return typeof name === 'string' && name.length > 0 && name.length < 100 && /^[A-Za-z0-9 .&'\-]+$/.test(name);
}
function safeName(name, ext) {
  var base = String(name || 'file').split(/[\\/]/).pop().replace(/\.[^.]*$/, '');
  base = base.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'file';
  return base + '.' + ext;
}
async function readBody(req, max) {
  var chunks = [], size = 0;
  for await (var chunk of req) {
    size += chunk.length;
    if (size > max) { var e = new Error('Payload too large'); e.code = 'TOO_LARGE'; throw e; }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

module.exports = async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Filename');
  res.setHeader('Access-Control-Allow-Origin', '*'); // embeddable widget; no credentials

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    console.error('[upload] BLOB_READ_WRITE_TOKEN not set — link a Vercel Blob store');
    return res.status(503).json({ error: 'File uploads are not configured' });
  }
  var atKey = process.env.AIRTABLE_KEY;
  if (!atKey) return res.status(500).json({ error: 'Service misconfigured' });

  var rl = await ratelimit.checkIpAndKey(req, { ipKey: 'upload', ipMax: 20, ipWindowSecs: 60 });
  if (!rl.allowed) return res.status(429).json({ error: 'Too many uploads — please wait a moment' });

  var clientName = ((req.query && req.query.clientName) || '').trim();
  if (!isValidClientName(clientName)) return res.status(400).json({ error: 'Invalid clientName' });

  var contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  var ext = ALLOWED[contentType];
  if (!ext) return res.status(415).json({ error: 'Unsupported file type' });

  var filename = safeName(req.headers['x-filename'] || 'file', ext);

  try {
    var crec = await auth.resolveClientByName(atKey, clientName);
    if (!crec) return res.status(404).json({ error: 'Unknown client' });
  } catch (e) {
    console.error('[upload] client resolve error:', e.message);
    return res.status(500).json({ error: 'Service unavailable' });
  }

  var buffer;
  try {
    buffer = await readBody(req, MAX_BYTES);
  } catch (e) {
    if (e.code === 'TOO_LARGE') return res.status(413).json({ error: 'File too large (max 4MB)' });
    return res.status(400).json({ error: 'Could not read upload' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'Empty file' });

  try {
    var put = require('@vercel/blob').put;
    // Namespace by client so files are organised; random suffix prevents
    // overwrites and makes URLs unguessable.
    var clientSlug = clientName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'client';
    var blob = await put('luna-chat/' + clientSlug + '/' + filename, buffer, {
      access: 'public',
      addRandomSuffix: true,
      contentType: contentType
    });
    return res.status(200).json({ url: blob.url, name: filename, contentType: contentType, size: buffer.length });
  } catch (e) {
    console.error('[upload] blob put failed:', e.message);
    return res.status(502).json({ error: 'Upload failed' });
  }
};
