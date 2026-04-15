// api/scan-page.js
// Fetches a webpage URL and extracts clean text content for Luna's knowledge base
// Called by the dashboard Settings > Train Luna feature

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Client-Name, X-Client-Pass');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const clientName = req.headers['x-client-name'];
  const clientPass = req.headers['x-client-pass'];
  const { url } = req.body || {};

  if (!clientName || !clientPass) {
    return res.status(401).json({ error: 'Missing authentication headers' });
  }

  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({ error: 'Invalid URL. Must start with http:// or https://' });
  }

  try {
    // Fetch the page
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LunaBot/1.0; +https://travelgenix.io)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000), // 15 second timeout
    });

    if (!response.ok) {
      return res.status(200).json({
        success: false,
        error: `Page returned ${response.status} ${response.statusText}`
      });
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return res.status(200).json({
        success: false,
        error: 'Not an HTML page (got ' + contentType.split(';')[0] + ')'
      });
    }

    const html = await response.text();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim().replace(/\s+/g, ' ') : '';

    // Extract clean text content
    let content = html;

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
    const maxChars = 15000;
    if (content.length > maxChars) {
      content = content.slice(0, maxChars) + '... [truncated]';
    }

    return res.status(200).json({
      success: true,
      url: url,
      title: title || url,
      content: content,
      charCount: content.length,
      wordCount: content.split(/\s+/).length,
    });

  } catch (e) {
    const msg = e.name === 'TimeoutError' || e.name === 'AbortError'
      ? 'Page took too long to respond (15s timeout)'
      : e.message || 'Unknown error';

    return res.status(200).json({
      success: false,
      error: msg
    });
  }
}
