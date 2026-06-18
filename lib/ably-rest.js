// lib/ably-rest.js
// Server-side Ably publish over the REST API.
//
// WHY THIS EXISTS: the browser widget publishes to Ably with the Ably SDK using
// a short-lived, capability-scoped token. Server endpoints (e.g. the WhatsApp
// webhook) have no widget and no SDK — but they DO hold the central
// ABLY_ROOT_KEY, so they can publish straight to any channel via Ably's REST
// endpoint. This is the server-side equivalent of the widget's
// chatChannel.publish(...) / dashChannel.publish(...) calls, so WhatsApp
// messages land on EXACTLY the same dashboard channels the web widget uses
// (luna-dashboard:{clientId}, luna-chat:{clientId}:{convId}). The agent inbox
// therefore needs no special-casing to show a WhatsApp conversation in realtime.
//
// Channel isolation is unchanged: callers only ever pass the scoped channel
// names built from the resolved Airtable clientId, so one client can never be
// published into another's namespace.
//
// Env: ABLY_ROOT_KEY (format "keyName:keySecret"; never sent to a browser).

const REST_HOST = 'https://rest.ably.io';

function isConfigured() {
  return !!process.env.ABLY_ROOT_KEY;
}

// Publish one or more messages to a single Ably channel.
//   channel  : full scoped channel name, e.g. "luna-chat:recXXX:conv_..."
//   messages : { name, data } or an array of them
// Returns true on success, false on any failure. Never throws — realtime
// delivery is best-effort; the durable record is Airtable.
async function publish(channel, messages) {
  var rootKey = process.env.ABLY_ROOT_KEY;
  if (!rootKey) {
    console.warn('[ably-rest] ABLY_ROOT_KEY not set; skipping publish to', channel);
    return false;
  }
  var payload = Array.isArray(messages) ? messages : [messages];
  var url = REST_HOST + '/channels/' + encodeURIComponent(channel) + '/messages';
  try {
    var res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(rootKey).toString('base64'),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      var t = await res.text().catch(function () { return ''; });
      console.warn('[ably-rest] publish failed', res.status, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('[ably-rest] publish error:', e.name, e.message);
    return false;
  }
}

module.exports = { publish: publish, isConfigured: isConfigured };
