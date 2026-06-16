// lib/safe-scrape.js
// Shared, SSRF-hardened web page fetcher and readable-text extractor.
//
// This is the single source of truth for "fetch an external URL safely and
// pull clean text out of it". Both the manual Train-Luna feature (api/scan-page)
// and the proactive discovery crawler (api/discover-scan) use it, so the SSRF
// protections can never drift apart between the two paths.
//
// SSRF posture (ported verbatim from the audited api/scan-page logic):
//   - HTTPS only, port 443 only, no credentials in URL.
//   - Block private, loopback, link-local, CGNAT and cloud-metadata addresses,
//     checked against BOTH the literal hostname AND every DNS-resolved IP.
//   - Follow redirects manually, re-validating each hop (defeats DNS rebinding
//     and public-URL-that-302s-to-169.254.169.254 tricks).

'use strict';

const dns = require('dns').promises;
const net = require('net');

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
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;            // 192.168.0.0/16
    if (a === 127) return true;                         // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true;            // 169.254.0.0/16 link-local + metadata
    if (a === 0) return true;                           // 0.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127) return true;  // 100.64.0.0/10 CGNAT
    return false;
  }

  if (family === 6) {
    var lower = ip.toLowerCase();
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true;   // loopback
    if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return true;               // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/i.test(lower)) return true;               // fe80::/10 link-local
    var mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);        // IPv4-mapped
    if (mapped) return isBlockedIp(mapped[1]);
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return true;   // unspecified
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

  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'URL must use https://' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'URL must not contain credentials' };
  }
  if (parsed.port && parsed.port !== '443') {
    return { ok: false, error: 'Only standard HTTPS port (443) is allowed' };
  }

  var hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.indexOf(hostname) !== -1) {
    return { ok: false, error: 'Hostname not allowed' };
  }
  if (net.isIP(hostname) > 0) {
    if (isBlockedIp(hostname)) {
      return { ok: false, error: 'IP address not allowed' };
    }
  }

  return { ok: true, parsed: parsed };
}

// Resolve hostname and ensure NO resolved IP is in a blocked range.
async function validateResolvedIps(hostname) {
  if (net.isIP(hostname) > 0) return { ok: true }; // already a checked literal IP
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
// each hop against SSRF checks.
async function safeFetchWithRedirects(startUrl, fetchOptions, maxHops) {
  var currentUrl = startUrl;
  var hops = 0;

  while (hops <= maxHops) {
    var validated = parseScanUrl(currentUrl);
    if (!validated.ok) {
      return { ok: false, status: 400, error: validated.error };
    }
    var dnsCheck = await validateResolvedIps(validated.parsed.hostname);
    if (!dnsCheck.ok) {
      return { ok: false, status: 400, error: dnsCheck.error };
    }

    var response = await fetch(validated.parsed.href, Object.assign({}, fetchOptions, { redirect: 'manual' }));

    if (response.status >= 300 && response.status < 400) {
      var location = response.headers.get('location');
      if (!location) {
        return { ok: false, status: 200, error: 'Redirect without Location header' };
      }
      try {
        currentUrl = new URL(location, validated.parsed.href).href;
      } catch (e) {
        return { ok: false, status: 200, error: 'Invalid redirect target' };
      }
      hops++;
      continue;
    }

    return { ok: true, response: response, finalUrl: validated.parsed.href };
  }

  return { ok: false, status: 200, error: 'Too many redirects (max ' + maxHops + ')' };
}

// Strip a raw HTML document down to readable text. Pure and deterministic.
function extractReadableText(html) {
  var content = html;
  content = content.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  content = content.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  content = content.replace(/<nav[\s\S]*?<\/nav>/gi, ' ');
  content = content.replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  content = content.replace(/<header[\s\S]*?<\/header>/gi, ' ');
  content = content.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ');
  content = content.replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ');
  content = content.replace(/<svg[\s\S]*?<\/svg>/gi, ' ');
  content = content.replace(/<[^>]+>/g, ' ');
  content = content.replace(/&amp;/g, '&');
  content = content.replace(/&lt;/g, '<');
  content = content.replace(/&gt;/g, '>');
  content = content.replace(/&quot;/g, '"');
  content = content.replace(/&#39;/g, "'");
  content = content.replace(/&nbsp;/g, ' ');
  content = content.replace(/&#\d+;/g, ' ');
  content = content.replace(/&\w+;/g, ' ');
  content = content.replace(/\s+/g, ' ').trim();
  return content;
}

function extractTitle(html) {
  var titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';
}

// High-level: safely fetch a URL and return clean text. Returns
//   { ok: true, url, title, content, charCount, wordCount }
//   { ok: false, status, error }
// Never throws; all failures come back as { ok: false }.
async function scrapeUrl(rawUrl, opts) {
  opts = opts || {};
  var maxBytes = opts.maxBytes || 2 * 1024 * 1024;     // 2 MB
  var maxChars = opts.maxChars || 15000;               // ~3,500 tokens
  var timeoutMs = opts.timeoutMs || 15000;
  var maxHops = opts.maxHops != null ? opts.maxHops : 3;

  try {
    var fetchResult = await safeFetchWithRedirects(rawUrl, {
      headers: {
        // A realistic browser User-Agent. Many official sites (tourism boards
        // especially) return 403 to obvious bot UAs. This is a best effort: a
        // sophisticated WAF or datacentre-IP block will still refuse us, in
        // which case a structured API is the reliable route, not scraping.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-GB,en;q=0.9',
        'Upgrade-Insecure-Requests': '1'
      },
      signal: AbortSignal.timeout(timeoutMs)
    }, maxHops);

    if (!fetchResult.ok) {
      return { ok: false, status: fetchResult.status || 400, error: fetchResult.error };
    }

    var response = fetchResult.response;
    var finalUrl = fetchResult.finalUrl;

    if (!response.ok) {
      return { ok: false, status: 200, error: 'Page returned ' + response.status + ' ' + response.statusText };
    }

    var contentType = response.headers.get('content-type') || '';
    if (contentType.indexOf('text/html') === -1 && contentType.indexOf('text/plain') === -1) {
      return { ok: false, status: 200, error: 'Not an HTML page (got ' + contentType.split(';')[0] + ')' };
    }

    var contentLength = parseInt(response.headers.get('content-length') || '0', 10);
    if (contentLength > maxBytes) {
      return { ok: false, status: 200, error: 'Page is too large to scan (>2MB)' };
    }

    var html = await response.text();
    if (html.length > maxBytes * 2) {
      return { ok: false, status: 200, error: 'Page is too large to scan' };
    }

    var title = extractTitle(html);
    var content = extractReadableText(html);

    if (content.length < 50) {
      return { ok: false, status: 200, error: 'Page has very little readable content (' + content.length + ' chars)' };
    }

    var truncated = false;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '... [truncated]';
      truncated = true;
    }

    return {
      ok: true,
      url: finalUrl,
      title: title || finalUrl,
      content: content,
      charCount: content.length,
      wordCount: content.split(/\s+/).length,
      truncated: truncated
    };
  } catch (e) {
    var msg = (e.name === 'TimeoutError' || e.name === 'AbortError')
      ? 'Page took too long to respond (timeout)'
      : 'Unable to fetch the page. Please check the URL and try again.';
    return { ok: false, status: 200, error: msg, errorName: e.name };
  }
}

module.exports = {
  BLOCKED_HOSTNAMES: BLOCKED_HOSTNAMES,
  isBlockedIp: isBlockedIp,
  parseScanUrl: parseScanUrl,
  validateResolvedIps: validateResolvedIps,
  safeFetchWithRedirects: safeFetchWithRedirects,
  extractReadableText: extractReadableText,
  extractTitle: extractTitle,
  scrapeUrl: scrapeUrl
};
