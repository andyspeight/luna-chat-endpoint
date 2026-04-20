// api/scan-page.js
// Fetches a webpage URL and extracts clean text content for Luna's knowledge base
// Called by the dashboard Settings > Train Luna feature

const dns = require('dns').promises;
const net = require('net');
const ratelimit = require('../lib/ratelimit');

// ── SSRF PROTECTION ─────────────────────────────────────────
// Block private, loopback, link-local, and cloud metadata addresses.
// Applied to BOTH the URL's hostname (catches literal IPs and known bad names)
// AND the DNS-resolved IPs (catches hostnames that resolve to internal ranges).

const BLOCKED_HOSTNAMES = [
  'localhost',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data.ec2.internal'
];

// Accepts an IP string, returns true if it is private/loopback/link-local/metadata.
function isBlockedIp(ip) {
  if (typeof ip !== 'string') return true;
  var family = net.isIP(ip);
  if (family === 0) return true; // not a valid IP — treat as blocked

  if (family === 4) {
    var parts = ip.split('.').map(Number);
    var a = parts[0], b = parts[1];
    // 10.0.0.0/8
    if (a === 10) return true;
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true;
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (link-local + AWS/Azure/GCP metadata)
    if (a === 169 && b === 254) return true;
    // 0.0.0.0/8
    if (a === 0) return true;
    // 100.64.0.0/10 (carrier-grade NAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  if (family === 6) {
    var lower = ip.toLowerCase();
    // ::1 (loopback)
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;
    // fc00::/7 (unique local)
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;
    // fe80::/10 (link-local)
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;
    // ::ffff: IPv4-mapped addresses — unwrap and recheck
    var mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedIp(mapped[1]);
    // :: (unspecified)
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;
    return false;
  }

  return true;
}

// Parse + validate a URL. Returns { ok: true, parsed } or { ok: false, error }.
function parseScanUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2000) {
    return { ok: false, error: 'Invalid URL' };
  }

  var parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    return { ok: false, error: 'Malformed URL' };
  }

  // HTTPS only — no plain HTTP
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use https://' };
  }

  // No credentials in URL
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not contain credentials' };
  }

  // No non-standard ports
  if (parsed.port && parsed.port !== '443') {
    return { ok: false, error: 'Only standard HTTPS port (443) is allowed' };
  }

  var hostname = parsed.hostname.toLowerCase();

  // Block known-bad hostnames
  if (BLOCKED_HOSTNAMES.indexOf(hostname) !== -1) {
    return { ok: false, error: 'Hostname not allowed' };
  }

  // If the hostname is a literal IP, validate it directly
  if (net.isIP(hostname) > 0) {
    if (isBlockedIp(hostname)) {
      return { ok: false, error: 'IP address not allowed' };
    }
  }

  return { ok: true, parsed: parsed };
}

// Resolve hostname and ensure NO resolved IP is in a blocked range.
// Belt and braces against DNS rebinding and hostnames like evil.com → 10.0.0.1.
async function validateResolvedIps(hostname) {
  // Skip if hostname is already a literal IP (parseScanUrl already checked it)
  if (net.isIP(hostname) > 0) return { ok: true };

  try {
    var records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!records || records.length === 0) {
      return { ok: false, error: 'Hostname could not be resolved' };
    }
    for (var i = 0; i < records.length; i++) {
      if (isBlockedIp(records[i].address)) {
        return { ok: false, error: 'Hostname resolves to a blocked address' };
      }
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: 'DNS lookup failed' };
  }
}

// Fetch with redirect validation — follows redirects up to a limit, re-validating
// each hop against SSRF checks. This prevents an attacker from submitting a public
// URL that 302s to http://169.254.169.254/ or similar.
async function safeFetchWithRedirects(startUrl, fetchOptions, maxHops) {
  var currentUrl = startUrl;
  var hops = 0;

  while (hops <= maxHops) {
    // Validate the current URL
    var validated = parseScanUrl(currentUrl);
    if (!validated.ok) {
      return { ok: false, status: 400, error: validated.error };
    }
    var dnsCheck = await validateResolvedIps(validated.parsed.hostname);
    if (!dnsCheck.ok) {
      return { ok: false, status: 400, error: dnsCheck.error };
    }

    // Fetch, do not follow redirects automatically — we handle them ourselves
    var response = await fetch(validated.parsed.href, Object.assign({}, fetchOptions, { redirect: 'manual' }));

    // If it's a redirect, grab Location and loop
    if (response.status >= 300 && response.status < 400) {
      var location = response.headers.get('location');
      if (!location) {
        return { ok: false, status: 200, error: 'Redirect without Location header' };
      }
      // Resolve relative Location headers against the current URL
      try {
        currentUrl = new URL(location, validated.parsed.href).href;
      } catch (e) {
        return { ok: false, status: 200, error: 'Invalid redirect target' };
      }
      hops++;
      continue;
    }

    // Not a redirect — return the response and the final URL
    return { ok: true, response: response, finalUrl: validated.parsed.href };
  }

  return { ok: false, status: 200, error: 'Too many redirects (max ' + maxHops + ')' };
}

// ── RATE LIMITING ──────────────────────────────────────────
// Scanning is expensive (external fetch + processing).
// Upstash-backed: per-IP + per-client, survives cold starts.

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Name, X-Client-Pass');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  var clientName = req.headers['x-client-name'];
  var clientPass = req.headers['x-client-pass'];
  var body = req.body || {};
  var url = body.url;

  if (!clientName || !clientPass) {
    return res.status(401).json({ error: 'Missing authentication headers' });
  }

  // Rate limit: per-IP + per-client (fails open on Redis error)
  var rlResult = await ratelimit.checkIpAndKey(req, {
    ipKey: 'scan-page',
    ipMax: 20,            // 20 scans/min/IP
    ipWindowSecs: 60,
    keyKey: 'scan-page:client:' + clientName,
    keyMax: 10,           // 10 scans/min/client
    keyWindowSecs: 60
  });
  if (!rlResult.allowed) {
    return res.status(429).json({
      success: false,
      error: 'Too many scan requests. Please wait a minute and try again.'
    });
  }

  try {
    // Fetch with redirect validation (max 3 hops, each re-checked against SSRF rules)
    var fetchResult = await safeFetchWithRedirects(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LunaBot/1.0; +https://travelgenix.io)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9'
      },
      signal: AbortSignal.timeout(15000)
    }, 3);

    if (!fetchResult.ok) {
      return res.status(fetchResult.status || 400).json({
        success: false,
        error: fetchResult.error
      });
    }

    var response = fetchResult.response;
    var finalUrl = fetchResult.finalUrl;

    if (!response.ok) {
      return res.status(200).json({
        success: false,
        error: 'Page returned ' + response.status + ' ' + response.statusText
      });
    }

    var contentType = response.headers.get('content-type') || '';
    if (contentType.indexOf('text/html') === -1 && contentType.indexOf('text/plain') === -1) {
      return res.status(200).json({
        success: false,
        error: 'Not an HTML page (got ' + contentType.split(';')[0] + ')'
      });
    }

    // Reject oversize responses up front (2 MB cap)
    var MAX_BYTES = 2 * 1024 * 1024;
    var contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > MAX_BYTES) {
      return res.status(200).json({
        success: false,
        error: 'Page is too large to scan (>2MB)'
      });
    }

    var html = await response.text();
    // Belt-and-braces check in case Content-Length was missing or wrong
    if (html.length > MAX_BYTES * 2) {
      return res.status(200).json({
        success: false,
        error: 'Page is too large to scan'
      });
    }

    // Extract title
    var titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    var title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';

    // Extract clean text content
    var content = html;

    // Remove script, style, nav, footer, header tags and their content
    content = content.replace(/<script[\s\S]*?<\/script>/gi, ' ');
    content = content.replace(/<style[\s\S]*?<\/style>/gi, ' ');
    content = content.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
    content = content.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
    content = content.replace(/<header[\s\S]*?<\/header>/gi, ' ');
    content = content.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
    content = content.replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');
    content = content.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');

    // Remove all remaining HTML tags
    content = content.replace(/<[^>]+>/g, ' ');

    // Decode HTML entities
    content = content.replace(/&amp;/g, '&');
    content = content.replace(/&lt;/g, '<');
    content = content.replace(/&gt;/g, '>');
    content = content.replace(/&quot;/g, '"');
    content = content.replace(/&#39;/g, "'");
    content = content.replace(/&nbsp;/g, ' ');
    content = content.replace(/&#\d+;/g, ' ');
    content = content.replace(/&\w+;/g, ' ');

    // Clean up whitespace
    content = content.replace(/\s+/g, ' ').trim();

    // Remove very short content (likely just boilerplate)
    if (content.length < 50) {
      return res.status(200).json({
        success: false,
        error: 'Page has very little readable content (' + content.length + ' chars)'
      });
    }

    // Truncate very long pages to keep token budget reasonable
    // ~15,000 chars ≈ ~3,500 tokens — enough to capture the page's key content
    var maxChars = 15000;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '... [truncated]';
    }

    return res.status(200).json({
      success: true,
      url: finalUrl,
      title: title || finalUrl,
      content: content,
      charCount: content.length,
      wordCount: content.split(/\s+/).length
    });

  } catch (e) {
    // Log full error server-side for debugging; return generic message to client
    console.error('[scan-page] Fetch error:', e.name, e.message);
    var msg = (e.name === 'TimeoutError' || e.name === 'AbortError')
      ? 'Page took too long to respond (15s timeout)'
      : 'Unable to fetch the page. Please check the URL and try again.';

    return res.status(200).json({
      success: false,
      error: msg
    });
  }
};
