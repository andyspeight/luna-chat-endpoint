// lib/ratelimit.js
// Shared rate-limiting + counter helper backed by Upstash Redis (REST API).
//
// Design goals:
// - Fail-open on infrastructure errors: a down Redis must not take the site down.
// - Atomic: uses INCR + EXPIRE via Upstash's pipeline so there's no race window.
// - Works from Vercel serverless (no persistent connection needed).
// - Zero dependencies — just fetch().
//
// Env vars required (both must be set or all limiter calls fail-open):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const URL_BASE = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// TEMPORARY DEBUG — log once on cold start so we can see env var state in Vercel logs
console.log('[ratelimit] Init — URL_BASE set:', !!URL_BASE, 'TOKEN set:', !!TOKEN);

function isConfigured() {
  return !!(URL_BASE && TOKEN);
}

// Execute a Redis pipeline against Upstash.
// Returns the array of results, or null if the call failed / timed out.
async function pipeline(commands) {
  if (!isConfigured()) {
    console.warn('[ratelimit] pipeline called but Upstash not configured');
    return null;
  }
  try {
    var res = await fetch(URL_BASE + '/pipeline', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(2000) // 2s — never block a user for longer
    });
    if (!res.ok) {
      console.warn('[ratelimit] Upstash returned HTTP', res.status);
      return null;
    }
    var data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (e) {
    console.warn('[ratelimit] Upstash call failed:', e.name, e.message);
    return null;
  }
}

// Execute a single Redis command.
async function single(command) {
  var results = await pipeline([command]);
  if (!results || !results[0]) return null;
  return results[0].result !== undefined ? results[0].result : null;
}

// Extract the caller's IP from standard Vercel / proxy headers.
function getClientIp(req) {
  var fwd = req.headers['x-forwarded-for'];
  if (fwd) {
    var first = fwd.split(',')[0].trim();
    if (first) return first;
  }
  return req.headers['x-real-ip']
    || (req.socket && req.socket.remoteAddress)
    || 'unknown';
}

// Atomic rate-limit check.
// key: a logical namespace + identifier, e.g. "chat:ip:203.0.113.1"
// max: max requests allowed in the window
// windowSecs: window length in seconds
// Returns: { allowed: bool, remaining: number, limit: number, resetSecs: number }
// On Redis failure: { allowed: true, remaining: -1, limit: max, resetSecs: windowSecs }
async function check(key, max, windowSecs) {
  if (!isConfigured()) {
    console.warn('[ratelimit] check called but Upstash not configured, failing open for', key);
    return { allowed: true, remaining: -1, limit: max, resetSecs: windowSecs };
  }

  // Atomic: INCR then (if count === 1) EXPIRE
  var results = await pipeline([
    ['INCR', key],
    ['EXPIRE', key, String(windowSecs), 'NX'] // NX = only set if no TTL set
  ]);

  if (!results || results.length < 1 || results[0].result === undefined) {
    // Fail-open
    console.warn('[ratelimit] No results from pipeline, failing open for', key);
    return { allowed: true, remaining: -1, limit: max, resetSecs: windowSecs };
  }

  var count = parseInt(results[0].result, 10);
  if (isNaN(count)) {
    return { allowed: true, remaining: -1, limit: max, resetSecs: windowSecs };
  }

  console.log('[ratelimit]', key, '→ count=' + count + ' max=' + max + ' allowed=' + (count <= max));

  return {
    allowed: count <= max,
    remaining: Math.max(0, max - count),
    limit: max,
    resetSecs: windowSecs
  };
}

// Combined IP + key rate limit. Takes whichever is more restrictive.
// If either one denies, the request is denied.
async function checkIpAndKey(req, opts) {
  // opts: { ipKey, ipMax, ipWindowSecs, keyKey, keyMax, keyWindowSecs }
  var ip = getClientIp(req);

  var ipCheck = await check('rl:' + opts.ipKey + ':ip:' + ip, opts.ipMax, opts.ipWindowSecs);
  if (!ipCheck.allowed) {
    return { allowed: false, reason: 'ip', ip: ip };
  }

  if (opts.keyKey) {
    var keyCheck = await check('rl:' + opts.keyKey, opts.keyMax, opts.keyWindowSecs);
    if (!keyCheck.allowed) {
      return { allowed: false, reason: 'key', ip: ip };
    }
  }

  return { allowed: true, ip: ip };
}

// Increment a daily counter (used for the Anthropic spend cap).
// Returns the new count, or null if Redis is down (caller should fail-open).
async function incrDaily(keyPrefix, amount) {
  amount = amount || 1;
  var today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  var key = 'daily:' + keyPrefix + ':' + today;

  var results = await pipeline([
    ['INCRBY', key, String(amount)],
    ['EXPIRE', key, '172800', 'NX'] // 48h TTL so yesterday's counter drops off
  ]);

  if (!results || !results[0] || results[0].result === undefined) return null;
  var val = parseInt(results[0].result, 10);
  return isNaN(val) ? null : val;
}

// Read current daily counter without incrementing.
async function readDaily(keyPrefix) {
  var today = new Date().toISOString().slice(0, 10);
  var result = await single(['GET', 'daily:' + keyPrefix + ':' + today]);
  if (result === null || result === undefined) return 0;
  var val = parseInt(result, 10);
  return isNaN(val) ? 0 : val;
}

module.exports = {
  isConfigured: isConfigured,
  getClientIp: getClientIp,
  check: check,
  checkIpAndKey: checkIpAndKey,
  incrDaily: incrDaily,
  readDaily: readDaily
};
