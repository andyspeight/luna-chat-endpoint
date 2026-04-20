// Luna Widget Legacy Loader
// ═══════════════════════════════════════════════════════════════════
// This file used to serve an older, insecure copy of the Luna widget.
// It has been replaced with a loader that redirects to the current
// secure widget (/widget-core.js) so any legacy embed code still works.
//
// The old widget contained a hardcoded Ably root key and XSS
// vulnerabilities. Any embed code still pointing at this path will
// now load the secure version transparently.
//
// DO NOT add widget logic back to this file.
// All widget development happens in /public/widget-core.js.
// ═══════════════════════════════════════════════════════════════════

module.exports = async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

  // CORS — widget can be loaded from any client site
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Preserve any data-* attributes from the original embed by passing
  // through the full query string. The browser's <script> tag won't forward
  // query params, but if anyone is calling this via fetch() they'll still get
  // the right response.
  var qs = req.url.indexOf('?');
  var queryString = qs >= 0 ? req.url.slice(qs) : '';

  // Build the target URL. Use the same host the request came to, so it works
  // whether we're on luna-chat-endpoint.vercel.app, a preview deploy, or a
  // custom domain.
  var host = req.headers.host || 'luna-chat-endpoint.vercel.app';
  var protocol = req.headers['x-forwarded-proto'] || 'https';
  var targetUrl = protocol + '://' + host + '/widget-core.js' + queryString;

  // Shim approach: serve a tiny JS stub that injects the real widget script.
  // We do this instead of a 301 redirect because a <script src="..."> tag
  // does follow redirects, but we want to be extra safe — some older browsers
  // and some proxies handle script-tag redirects inconsistently. A stub
  // guarantees the real widget loads cleanly.
  var stub = '(function(){'
    + 'var s=document.createElement("script");'
    + 's.src=' + JSON.stringify(targetUrl) + ';'
    + 's.async=true;'
    // Forward any data-* attributes from the original <script> tag
    + 'var old=document.currentScript||document.querySelector(\'script[src*="widget.js"]\');'
    + 'if(old&&old.attributes){'
    + 'for(var i=0;i<old.attributes.length;i++){'
    + 'var a=old.attributes[i];'
    + 'if(a.name.indexOf("data-")===0)s.setAttribute(a.name,a.value);'
    + '}'
    + '}'
    + 'document.head.appendChild(s);'
    + '})();';

  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600'); // 1 hour — short so we can update the stub if needed
  return res.status(200).send(stub);
};
