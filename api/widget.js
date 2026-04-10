// --- LUNA WIDGET LOADER ---
// Serves the widget JavaScript dynamically based on client configuration.
// Embed with: <script src="https://luna-chat-endpoint.vercel.app/api/widget.js" data-client="travelgenix"></script>

module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/javascript');
  res.setHeader('Cache-Control', 'public, max-age=300'); // Cache 5 minutes
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end('// Method not allowed');

  // Client config from query params
  const client = (req.query.client || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  const theme = (req.query.theme || 'dark').replace(/[^a-zA-Z]/g, '');
  const position = (req.query.position || 'right').replace(/[^a-zA-Z]/g, '');
  const ably = (req.query.ably || '').replace(/[^a-zA-Z0-9._:-]/g, '');

  // Validate required config
  if (!ably) {
    return res.status(200).send('console.error("Luna Widget: Missing ably key parameter. Add data-ably or ?ably= to your script tag.");');
  }

  // Widget configuration object (injected into the widget JS)
  const config = JSON.stringify({
    client: client,
    theme: theme,
    position: position,
    ablyKey: ably,
    endpoint: 'https://' + (req.headers.host || 'luna-chat-endpoint.vercel.app') + '/api/luna-chat',
    version: '1.0.0'
  });

  // Return the loader script
  const loaderJS = `
(function() {
  'use strict';
  if (window.__lunaWidgetLoaded) return;
  window.__lunaWidgetLoaded = true;
  
  // Widget config
  window.__LUNA_CONFIG = ${config};
  
  // Load Ably
  var ablyScript = document.createElement('script');
  ablyScript.src = 'https://cdn.ably.com/lib/ably.min-2.js';
  ablyScript.onload = function() {
    // Load the main widget
    var widgetScript = document.createElement('script');
    widgetScript.src = 'https://' + window.location.hostname.replace(/[^a-zA-Z0-9.-]/g,'') + '/__luna-widget.js';
    
    // If the widget JS isn't hosted locally, fall back to the endpoint host
    widgetScript.onerror = function() {
      var fallback = document.createElement('script');
      fallback.src = window.__LUNA_CONFIG.endpoint.replace('/api/luna-chat', '/api/widget-core.js');
      document.head.appendChild(fallback);
    };
    document.head.appendChild(widgetScript);
  };
  document.head.appendChild(ablyScript);
  
  // Create root element
  if (!document.getElementById('luna-widget-root')) {
    var root = document.createElement('div');
    root.id = 'luna-widget-root';
    document.body.appendChild(root);
  }
})();
`;

  return res.status(200).send(loaderJS);
};
