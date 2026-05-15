/* ═══════════════════════════════════════════════════════════
   Luna Widget Core v2
   Includes inlined block parser + renderers (see /lib).
   Single bundle, single network request.
   ═══════════════════════════════════════════════════════════ */

/* ─── LUNA BLOCK PARSER (inlined from lib/block-parser.js) ─── */
/**
 * Luna Block Parser
 * ─────────────────
 * Parses Luna's raw response into a sequence of renderable items.
 *
 * Luna emits a mix of prose and structured blocks. Blocks look like:
 *
 *   [BLOCK]{"type":"destination_card","props":{...}}[/BLOCK]
 *
 * This parser splits the raw string into items:
 *   { type: 'prose', text: '...' }
 *   { type: 'block', blockType: 'destination_card', props: {...} }
 *   { type: 'malformed', raw: '...' }   ← graceful degrade for bad JSON
 *
 * Defensive principles:
 *   - Never throw. Bad input becomes a 'malformed' item, not an exception.
 *   - Unknown block types are passed through; the renderer decides what to do.
 *   - Whitespace-only prose is filtered out (prevents empty bubbles between blocks).
 *   - The marker syntax is locked: [BLOCK]{ ... }[/BLOCK] with no nested markers.
 *
 * Spec ref: luna-chat-v2-spec.md §6
 */

const BLOCK_MARKER = /\[BLOCK\](.*?)\[\/BLOCK\]/gs;

// Known block types — used to flag unknowns for the renderer
const KNOWN_BLOCK_TYPES = new Set([
  'destination_card',
  'offer_card',
  'faq_policy_card',
  'booking_lookup_card',
  'human_handoff_card',
  'emergency_card',
  'location_card',
  'weather_card',
  'quick_replies'
]);

/**
 * Parse a raw Luna response into an array of renderable items.
 *
 * @param {string} raw  The full response text from Luna (or a streaming chunk concatenation)
 * @returns {Array<Object>} Ordered list of items
 */
function parseLunaResponse(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return [];

  const items = [];
  let lastIndex = 0;
  let match;

  // Reset the regex (it's stateful when global)
  BLOCK_MARKER.lastIndex = 0;

  while ((match = BLOCK_MARKER.exec(raw)) !== null) {
    // Capture any prose that came BEFORE this block
    if (match.index > lastIndex) {
      const prose = raw.slice(lastIndex, match.index).trim();
      if (prose.length > 0) {
        items.push({ type: 'prose', text: prose });
      }
    }

    // Parse the block's JSON
    const jsonStr = match[1].trim();
    let parsed;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (err) {
      items.push({
        type: 'malformed',
        raw: match[0],
        reason: 'invalid JSON',
        error: err.message
      });
      lastIndex = match.index + match[0].length;
      continue;
    }

    // Validate structure
    if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string') {
      items.push({
        type: 'malformed',
        raw: match[0],
        reason: 'missing type field'
      });
      lastIndex = match.index + match[0].length;
      continue;
    }

    items.push({
      type: 'block',
      blockType: parsed.type,
      props: parsed.props || {},
      known: KNOWN_BLOCK_TYPES.has(parsed.type)
    });

    lastIndex = match.index + match[0].length;
  }

  // Capture any trailing prose AFTER the last block
  if (lastIndex < raw.length) {
    let prose = raw.slice(lastIndex).trim();
    // Defensive: if Luna's response was cut off mid-block (max_tokens hit),
    // we may have a stray "[BLOCK]" with no closing "[/BLOCK]". Drop everything
    // from the unmatched opener to the end — never leak raw JSON to the user.
    const strayOpener = prose.indexOf('[BLOCK]');
    if (strayOpener !== -1) {
      prose = prose.slice(0, strayOpener).trim();
    }
    if (prose.length > 0) {
      items.push({ type: 'prose', text: prose });
    }
  }

  return items;
}

/**
 * Streaming variant — parses progressively as chunks arrive.
 * Buffers partial blocks until they're complete.
 *
 * Usage:
 *   const stream = createStreamingParser();
 *   for (const chunk of chunks) {
 *     const newItems = stream.feed(chunk);
 *     newItems.forEach(item => renderItem(item));
 *   }
 *   stream.finish().forEach(renderItem); // flush any trailing prose
 */
function createStreamingParser() {
  let buffer = '';
  let emittedUpTo = 0;

  function feed(chunk) {
    buffer += chunk;
    const items = [];

    // Find complete blocks (start AND end markers present)
    BLOCK_MARKER.lastIndex = emittedUpTo;
    let match;

    while ((match = BLOCK_MARKER.exec(buffer)) !== null) {
      // Prose before this block
      if (match.index > emittedUpTo) {
        const prose = buffer.slice(emittedUpTo, match.index);
        // Only emit prose if we're sure no [BLOCK] is starting mid-string
        if (!prose.includes('[BLOCK')) {
          const trimmed = prose.trim();
          if (trimmed) items.push({ type: 'prose', text: trimmed });
        } else {
          // Hold back — there may be a partial block forming
          break;
        }
      }

      // Parse the complete block
      const jsonStr = match[1].trim();
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed && typeof parsed.type === 'string') {
          items.push({
            type: 'block',
            blockType: parsed.type,
            props: parsed.props || {},
            known: KNOWN_BLOCK_TYPES.has(parsed.type)
          });
        } else {
          items.push({ type: 'malformed', raw: match[0], reason: 'missing type field' });
        }
      } catch (err) {
        items.push({ type: 'malformed', raw: match[0], reason: 'invalid JSON', error: err.message });
      }

      emittedUpTo = match.index + match[0].length;
    }

    return items;
  }

  function finish() {
    const items = [];
    if (emittedUpTo < buffer.length) {
      const trailingProse = buffer.slice(emittedUpTo).trim();
      // Filter out any orphaned partial markers
      if (trailingProse && !trailingProse.includes('[BLOCK')) {
        items.push({ type: 'prose', text: trailingProse });
      }
    }
    return items;
  }

  return { feed, finish };
}

/**
 * Quick utility: extract just the block items, ignoring prose.
 * Useful for analytics or block-level inspection.
 */
function extractBlocks(raw) {
  return parseLunaResponse(raw).filter(i => i.type === 'block');
}
/* Inlined for browser: register on window.LunaBlockParser */
window.LunaBlockParser = {
  parseLunaResponse,
  createStreamingParser,
  extractBlocks,
  KNOWN_BLOCK_TYPES
};


/* ─── LUNA BLOCK RENDERERS (inlined from lib/block-renderers.js) ─── */
/**
 * Luna Block Renderers
 * ────────────────────
 * Renders the 7 launch block types as DOM elements that can be appended
 * to the widget's message thread.
 *
 * Security principles (travelgenix-security skill):
 *   - NEVER use innerHTML with untrusted content. Every text field from Luna's
 *     response is set via textContent or safe markdown rendering.
 *   - All URLs (href, src, tel:, mailto:) pass through safeUrl().
 *   - No inline event handlers — all listeners attached via addEventListener.
 *   - CSP-compatible. SVG icons inlined as static templates, not innerHTML'd.
 *
 * Theming:
 *   - Renderers create raw DOM with CSS classes. Styling lives in the widget's
 *     Shadow DOM stylesheet. Light/dark switching happens at the host level
 *     via [data-theme] attribute — renderers don't care.
 *   - Use CSS custom properties (--brand, --accent, --bg-card, etc.) that
 *     map onto the widget's theme system.
 *
 * Dispatch:
 *   - renderBlock(blockType, props, context) is the single entry point.
 *   - Unknown block types render a 'malformed' fallback. Never throws.
 *
 * Context object passed to every renderer:
 *   { dispatch }  — callback for user actions (e.g. send a follow-up message)
 *
 * Spec ref: luna-chat-v2-spec.md §6
 */

// ─────────── SECURITY HELPERS ───────────

/**
 * Block dangerous URL schemes. Returns the URL if safe, '#' if not.
 * Allowed: http(s), tel, mailto, relative paths.
 */
function safeUrl(url) {
  if (typeof url !== 'string' || url.length === 0) return '#';
  const trimmed = url.trim();
  // Allow relative paths and fragment-only links
  if (trimmed.startsWith('/') || trimmed.startsWith('#') || trimmed.startsWith('?')) {
    return trimmed;
  }
  // Allow specific schemes
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('https://') ||
      lower.startsWith('http://') ||
      lower.startsWith('tel:') ||
      lower.startsWith('mailto:') ||
      lower.startsWith('whatsapp:')) {
    return trimmed;
  }
  return '#';
}

/**
 * Render limited inline markdown safely.
 * Supports **bold** only. Everything else stays as plain text.
 * Returns an array of DOM nodes (text + <strong>).
 */
function renderInlineMarkdown(text) {
  if (typeof text !== 'string') return [];
  const nodes = [];
  const re = /\*\*([^*]+)\*\*/g;
  let lastIndex = 0;
  let match;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(document.createTextNode(text.slice(lastIndex, match.index)));
    }
    const strong = document.createElement('strong');
    strong.textContent = match[1]; // textContent — safe
    nodes.push(strong);
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(document.createTextNode(text.slice(lastIndex)));
  }
  return nodes;
}

/**
 * Create an element with safe text content + optional class.
 * Use this everywhere instead of innerHTML.
 */
function el(tag, className, textContent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (textContent !== undefined && textContent !== null) {
    node.textContent = String(textContent);
  }
  return node;
}

/** Append children helper. */
function append(parent, ...children) {
  children.forEach(c => { if (c) parent.appendChild(c); });
  return parent;
}

// ─────────── ICONS ───────────
// Inline SVG templates. Static strings — never interpolated with untrusted data.
// Returned as DOM nodes via DOMParser.

const ICONS = {
  'map-pin':       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  'calendar':      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  'info':          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  'message-square':'<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  'phone':         '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>',
  'arrow-right':   '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>',
  'external-link':'<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17L17 7M7 7h10v10"/></svg>',
  'star':          '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 17.27 18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg>'
};

function iconNode(name) {
  const svgString = ICONS[name] || ICONS['info'];
  // SVG strings here are 100% static template, never include user data — safe.
  const wrapper = document.createElement('span');
  wrapper.className = 'luna-icon';
  // Using DOMParser instead of innerHTML to be explicit about intent
  const parsed = new DOMParser().parseFromString(svgString, 'image/svg+xml');
  const svg = parsed.documentElement;
  if (svg && svg.nodeName.toLowerCase() === 'svg') {
    wrapper.appendChild(svg);
  }
  return wrapper;
}

// ─────────── BLOCK: destination_card ───────────

function renderDestinationCard(props, ctx) {
  const card = el('div', 'luna-dest-card');

  // Image fallback chain:
  //   1. props.image — curated URL (server-side enriched from Airtable for ~364 destinations)
  //   2. Unsplash Source API — keyword-targeted fallback for the long tail
  //   3. Gradient placeholder via CSS (handled in img.onerror)
  const imgWrap = el('div', 'luna-dest-img');
  const img = document.createElement('img');
  let imgSrc;
  let imgSource = 'curated';
  if (props.image) {
    imgSrc = safeUrl(props.image);
  } else if (props.name) {
    // Build a query: destination name + tags + "travel" for relevance
    const tagPart = Array.isArray(props.tags) && props.tags.length
      ? ',' + props.tags.slice(0, 2).map(t => encodeURIComponent(t.toLowerCase())).join(',')
      : '';
    const safeName = encodeURIComponent(props.name.toLowerCase().trim());
    imgSrc = 'https://source.unsplash.com/800x400/?' + safeName + tagPart + ',travel';
    imgSource = 'unsplash-fallback';
    console.warn('[Luna] image fallback for destination:', props.name);
  }
  if (imgSrc) {
    let onerrorFired = false;
    img.src = imgSrc;
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = function() {
      if (onerrorFired) return;
      onerrorFired = true;
      // Final fallback: remove img, leave gradient placeholder visible via CSS
      if (imgWrap.parentNode) imgWrap.parentNode.removeChild(imgWrap);
      console.warn('[Luna] image load failed (' + imgSource + '):', props.name || '(no name)');
    };
    imgWrap.appendChild(img);
    // Apply a coloured gradient as a backdrop so if image is slow/blank,
    // the visitor sees a styled placeholder, not a blank box
    imgWrap.style.background = 'linear-gradient(135deg, var(--tgx-brand, #0F1A3D), var(--tgx-accent, #F26A4F))';
    card.appendChild(imgWrap);
  }

  const body = el('div', 'luna-dest-body');

  const row1 = el('div', 'luna-dest-row1');
  append(row1,
    el('div', 'luna-dest-name', props.name),
    el('div', 'luna-dest-temp', [props.temperature, props.flightTime].filter(Boolean).join(' · '))
  );
  body.appendChild(row1);

  if (props.vibe) {
    body.appendChild(el('div', 'luna-dest-vibe', props.vibe));
  }

  // Tags
  if (Array.isArray(props.tags) && props.tags.length > 0) {
    const tagWrap = el('div', 'luna-dest-tags');
    props.tags.slice(0, 5).forEach(t => {
      tagWrap.appendChild(el('span', 'luna-tag', t));
    });
    body.appendChild(tagWrap);
  }

  // Actions
  const actions = el('div', 'luna-dest-actions');

  const tellMe = el('button', 'luna-btn', 'Tell me more');
  tellMe.type = 'button';
  tellMe.addEventListener('click', () => {
    if (ctx && ctx.dispatch) ctx.dispatch({ type: 'send_message', text: `Tell me more about ${props.name}` });
  });
  actions.appendChild(tellMe);

  if (props.deepLink) {
    /* v2: render as button with JS click handler, NOT as <a href>.
       This prevents host-site travel-tech scripts from auto-fetching
       the deep link when they scan the DOM for tvllnk URLs. */
    const safeDeepLink = safeUrl(props.deepLink);
    const link = document.createElement('button');
    link.className = 'luna-btn luna-btn-primary';
    link.type = 'button';
    link.textContent = 'See deals';
    link.appendChild(iconNode('arrow-right'));
    link.addEventListener('click', () => {
      if (safeDeepLink && safeDeepLink !== '#') {
        window.open(safeDeepLink, '_blank', 'noopener,noreferrer');
      }
    });
    actions.appendChild(link);
  }

  body.appendChild(actions);
  card.appendChild(body);

  return card;
}

// ─────────── BLOCK: offer_card ───────────

function renderOfferCard(props, ctx) {
  const card = el('div', 'luna-offer-card');

  if (props.image) {
    const imgWrap = el('div', 'luna-offer-img');
    const img = document.createElement('img');
    img.src = safeUrl(props.image);
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.onerror = function() {
      if (imgWrap.parentNode) imgWrap.parentNode.removeChild(imgWrap);
    };
    imgWrap.appendChild(img);
    card.appendChild(imgWrap);
  }

  const body = el('div', 'luna-offer-body');

  // Hotel name + stars
  const hotelRow = el('div', 'luna-offer-hotel-row');
  hotelRow.appendChild(el('div', 'luna-offer-hotel', props.hotelName));
  if (typeof props.stars === 'number' && props.stars > 0) {
    const starWrap = el('span', 'luna-offer-stars');
    for (let i = 0; i < Math.min(5, props.stars); i++) {
      starWrap.appendChild(iconNode('star'));
    }
    hotelRow.appendChild(starWrap);
  }
  body.appendChild(hotelRow);

  if (props.destination) {
    body.appendChild(el('div', 'luna-offer-dest', props.destination));
  }

  // Meta row: dates · duration · departure · board
  const meta = [props.dates, props.duration, props.departure, props.board].filter(Boolean).join(' · ');
  if (meta) {
    body.appendChild(el('div', 'luna-offer-meta', meta));
  }

  // Price + book button
  const priceRow = el('div', 'luna-offer-price-row');
  if (typeof props.pricePerPerson === 'number') {
    const currency = (props.currency === 'EUR') ? '€' : (props.currency === 'USD') ? '$' : '£';
    const priceWrap = el('div', 'luna-offer-price');
    priceWrap.appendChild(el('span', 'luna-offer-price-label', 'From'));
    priceWrap.appendChild(el('span', 'luna-offer-price-value', `${currency}${props.pricePerPerson.toLocaleString()}`));
    priceWrap.appendChild(el('span', 'luna-offer-price-pp', 'pp'));
    priceRow.appendChild(priceWrap);
  }

  if (props.bookUrl) {
    /* v2: button + JS click handler, not <a href>. See destination_card for rationale. */
    const safeBookUrl = safeUrl(props.bookUrl);
    const book = document.createElement('button');
    book.className = 'luna-btn luna-btn-primary';
    book.type = 'button';
    book.textContent = 'Book';
    book.appendChild(iconNode('arrow-right'));
    book.addEventListener('click', () => {
      if (safeBookUrl && safeBookUrl !== '#') {
        window.open(safeBookUrl, '_blank', 'noopener,noreferrer');
      }
    });
    priceRow.appendChild(book);
  }
  body.appendChild(priceRow);

  // Operator footer
  if (props.operator) {
    const op = el('div', 'luna-offer-operator');
    if (props.operatorLogo) {
      const logo = document.createElement('img');
      logo.src = safeUrl(props.operatorLogo);
      logo.alt = '';
      logo.referrerPolicy = 'no-referrer';
      logo.loading = 'lazy';
      logo.className = 'luna-offer-operator-logo';
      op.appendChild(logo);
    }
    op.appendChild(el('span', 'luna-offer-operator-name', `Operated by ${props.operator}`));
    body.appendChild(op);
  }

  card.appendChild(body);
  return card;
}

// ─────────── BLOCK: faq_policy_card ───────────

function renderFaqPolicyCard(props, ctx) {
  const card = el('div', 'luna-faq-card');

  // Header: pill + title
  const head = el('div', 'luna-faq-head');
  if (props.category) {
    const pill = el('span', 'luna-faq-pill', props.category);
    // Category drives the pill colour via data attribute
    pill.dataset.category = String(props.category).toLowerCase();
    head.appendChild(pill);
  }
  if (props.title) {
    head.appendChild(el('div', 'luna-faq-title', props.title));
  }
  card.appendChild(head);

  // Body — supports **bold** markdown
  if (props.body) {
    const body = el('div', 'luna-faq-body');
    renderInlineMarkdown(props.body).forEach(n => body.appendChild(n));
    card.appendChild(body);
  }

  // Footer — source + optional link
  if (props.source || props.sourceUrl) {
    const foot = el('div', 'luna-faq-foot');
    if (props.source) {
      foot.appendChild(el('span', 'luna-faq-source', props.source));
    }
    if (props.sourceUrl) {
      const link = document.createElement('a');
      link.className = 'luna-faq-link';
      link.href = safeUrl(props.sourceUrl);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = 'Read full';
      link.appendChild(iconNode('external-link'));
      foot.appendChild(link);
    }
    card.appendChild(foot);
  }

  return card;
}

// ─────────── BLOCK: booking_lookup_card ───────────

function renderBookingLookupCard(props, ctx) {
  const card = el('div', 'luna-booking-card');

  // Strip header — reference + status
  const strip = el('div', 'luna-booking-strip');
  if (props.reference) {
    strip.appendChild(el('span', 'luna-booking-ref', `REF · ${props.reference}`));
  }
  if (props.status) {
    const status = el('span', 'luna-booking-status', props.status);
    status.dataset.status = String(props.status).toLowerCase();
    strip.appendChild(status);
  }
  card.appendChild(strip);

  const body = el('div', 'luna-booking-body');

  if (props.destination) {
    body.appendChild(el('div', 'luna-booking-dest', props.destination));
  }

  // Dates · duration · pax
  const summary = [props.dates, props.duration, props.pax].filter(Boolean).join(' · ');
  if (summary) {
    body.appendChild(el('div', 'luna-booking-summary', summary));
  }

  // Rows: hotel, board, total, balance due
  const rows = el('div', 'luna-booking-rows');
  const addRow = (label, value, accent) => {
    if (!value && value !== 0) return;
    const row = el('div', 'luna-booking-row');
    row.appendChild(el('span', 'luna-booking-label', label));
    const val = el('span', 'luna-booking-value', value);
    if (accent) val.classList.add('luna-booking-value-accent');
    row.appendChild(val);
    rows.appendChild(row);
  };

  if (props.hotel) {
    const hotelLine = props.hotelStars
      ? `${props.hotel} ${'★'.repeat(Math.min(5, props.hotelStars))}`
      : props.hotel;
    addRow('Hotel', hotelLine);
  }
  if (props.board) addRow('Board', props.board);
  if (props.total) addRow('Total', props.total);
  if (props.balanceDue) {
    const balLine = props.balanceDate ? `${props.balanceDue} by ${props.balanceDate}` : props.balanceDue;
    addRow('Balance due', balLine, true);
  }
  body.appendChild(rows);
  card.appendChild(body);

  // Actions
  if (Array.isArray(props.actions) && props.actions.length > 0) {
    const actions = el('div', 'luna-booking-actions');
    props.actions.slice(0, 3).forEach(a => {
      if (!a || !a.label) return;
      const btn = el('button', 'luna-btn' + (a.primary ? ' luna-btn-primary' : ''), a.label);
      btn.type = 'button';
      btn.addEventListener('click', () => {
        if (ctx && ctx.dispatch) ctx.dispatch({ type: 'booking_action', action: a.action, reference: props.reference });
      });
      actions.appendChild(btn);
    });
    card.appendChild(actions);
  }

  return card;
}

// ─────────── BLOCK: human_handoff_card ───────────

function renderHumanHandoffCard(props, ctx) {
  const card = el('div', 'luna-handoff-card');

  if (props.memberPhoto) {
    const avatar = el('div', 'luna-handoff-avatar');
    const img = document.createElement('img');
    img.src = safeUrl(props.memberPhoto);
    img.alt = '';
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    avatar.appendChild(img);
    card.appendChild(avatar);
  }

  const text = el('div', 'luna-handoff-text');
  if (props.memberName) {
    text.appendChild(el('div', 'luna-handoff-name', props.memberName));
  }
  if (props.responseTime) {
    text.appendChild(el('div', 'luna-handoff-time', props.responseTime));
  }
  card.appendChild(text);

  const action = props.actionType || 'connect';
  const labelMap = { connect: 'Connect', callback: 'Book a call', whatsapp: 'WhatsApp us' };
  const btn = el('button', 'luna-handoff-btn', labelMap[action] || 'Connect');
  btn.type = 'button';
  btn.addEventListener('click', () => {
    if (ctx && ctx.dispatch) ctx.dispatch({ type: 'handoff', actionType: action });
  });
  card.appendChild(btn);

  return card;
}

// ─────────── BLOCK: emergency_card ───────────

function renderEmergencyCard(props, ctx) {
  const card = el('div', 'luna-emergency-card');

  const head = el('div', 'luna-emergency-head');
  head.appendChild(iconNode('phone'));
  head.appendChild(el('span', 'luna-emergency-label', 'Need urgent help?'));
  card.appendChild(head);

  if (props.reassurance) {
    card.appendChild(el('div', 'luna-emergency-reassurance', props.reassurance));
  }

  // The phone number — large and tappable
  if (props.phone) {
    const phoneLink = document.createElement('a');
    phoneLink.className = 'luna-emergency-phone';
    phoneLink.href = safeUrl(`tel:${props.phone.replace(/\s+/g, '')}`);
    phoneLink.textContent = props.phoneDisplay || props.phone;
    card.appendChild(phoneLink);

    const callBtn = el('button', 'luna-emergency-btn', 'Call now');
    callBtn.type = 'button';
    callBtn.addEventListener('click', () => {
      // Trigger the tel: link
      phoneLink.click();
    });
    card.appendChild(callBtn);
  } else {
    // No phone configured — show fallback
    card.appendChild(el('div', 'luna-emergency-fallback',
      'Please contact us directly — emergency phone not yet configured.'));
  }

  return card;
}

// ─────────── BLOCK: quick_replies ───────────

function renderQuickReplies(props, ctx) {
  const wrap = el('div', 'luna-chips');

  if (!Array.isArray(props.replies)) return wrap;

  props.replies.slice(0, 4).forEach(reply => {
    if (typeof reply !== 'string') return;
    const chip = el('button', 'luna-chip', reply);
    chip.type = 'button';
    chip.addEventListener('click', () => {
      if (ctx && ctx.dispatch) ctx.dispatch({ type: 'send_message', text: reply });
    });
    wrap.appendChild(chip);
  });

  return wrap;
}

// ─────────── FALLBACK: unknown / malformed ───────────

function renderFallback(blockType, props) {
  const card = el('div', 'luna-fallback-card');
  card.appendChild(el('div', 'luna-fallback-label', `Unsupported content (${blockType || 'unknown'})`));
  // Don't render props — they could contain anything. Silent fallback is safer.
  return card;
}

// ─────────── BLOCK: location_card ───────────
// Renders a map preview + Open in Google/Apple Maps buttons for a geo location.
// Uses Leaflet (lazy-loaded from CDN on first use) with free OpenStreetMap tiles.
// No API keys, no tokens — works offline-ish (degrades to static link buttons if
// Leaflet fails to load, e.g. CSP blocks CDN).

var _leafletLoadPromise = null;
function ensureLeaflet() {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (_leafletLoadPromise) return _leafletLoadPromise;
  _leafletLoadPromise = new Promise(function(resolve, reject) {
    // Load CSS first (must be in head before Leaflet JS runs to compute marker positions)
    var existingCss = document.querySelector('link[data-luna-leaflet]');
    if (!existingCss) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      css.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
      css.crossOrigin = '';
      css.setAttribute('data-luna-leaflet', '1');
      document.head.appendChild(css);
    }
    var script = document.createElement('script');
    script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
    script.crossOrigin = '';
    script.onload = function() {
      if (window.L && window.L.map) resolve(window.L);
      else reject(new Error('Leaflet loaded but window.L missing'));
    };
    script.onerror = function() { reject(new Error('Leaflet CDN failed to load')); };
    document.head.appendChild(script);
  });
  return _leafletLoadPromise;
}

function renderLocationCard(props, ctx) {
  var card = el('div', 'luna-location-card');

  var name = typeof props.name === 'string' ? props.name : '';
  var subtitle = typeof props.subtitle === 'string' ? props.subtitle : '';
  var description = typeof props.description === 'string' ? props.description : '';
  var lat = (typeof props.lat === 'number') ? props.lat : parseFloat(props.lat);
  var lng = (typeof props.lng === 'number') ? props.lng : parseFloat(props.lng);
  var zoom = (typeof props.zoom === 'number' && props.zoom > 0 && props.zoom <= 19) ? props.zoom : 13;

  // Header band
  var head = el('div', 'luna-location-head');
  // Pin icon
  var pin = document.createElement('span');
  pin.className = 'luna-location-pin';
  pin.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>';
  head.appendChild(pin);
  var headText = el('div', 'luna-location-head-text');
  if (name) headText.appendChild(el('div', 'luna-location-name', name));
  if (subtitle) headText.appendChild(el('div', 'luna-location-subtitle', subtitle));
  head.appendChild(headText);
  card.appendChild(head);

  // Map container (or static fallback)
  var mapWrap = el('div', 'luna-location-map');
  card.appendChild(mapWrap);

  if (isFinite(lat) && isFinite(lng)) {
    var mapId = 'luna-map-' + Math.random().toString(36).slice(2, 9);
    mapWrap.id = mapId;
    // Fallback static text (replaced once Leaflet loads)
    var loadingMsg = el('div', 'luna-location-map-loading', 'Loading map…');
    mapWrap.appendChild(loadingMsg);

    ensureLeaflet().then(function(L) {
      // Defensive: container may have been removed from DOM by now (rare)
      if (!mapWrap.isConnected) return;
      mapWrap.innerHTML = '';
      try {
        var map = L.map(mapId, {
          center: [lat, lng],
          zoom: zoom,
          zoomControl: true,
          scrollWheelZoom: false,
          attributionControl: true
        });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 18,
          attribution: '© OpenStreetMap contributors'
        }).addTo(map);
        var marker = L.marker([lat, lng]).addTo(map);
        if (name) marker.bindPopup(name);
        // Fix sizing issue when card animates in
        setTimeout(function() { try { map.invalidateSize(); } catch(e){} }, 120);
      } catch (err) {
        console.warn('[Luna] Leaflet init failed:', err.message);
        mapWrap.innerHTML = '';
        mapWrap.appendChild(el('div', 'luna-location-map-error', 'Map preview unavailable'));
      }
    }).catch(function(err) {
      console.warn('[Luna] Leaflet load failed:', err.message);
      if (!mapWrap.isConnected) return;
      mapWrap.innerHTML = '';
      mapWrap.appendChild(el('div', 'luna-location-map-error', 'Map preview unavailable'));
    });
  } else {
    mapWrap.appendChild(el('div', 'luna-location-map-error', 'Coordinates not available'));
  }

  // Description below the map
  if (description) {
    card.appendChild(el('div', 'luna-location-desc', description));
  }

  // CTAs — universal deep links
  if (isFinite(lat) && isFinite(lng)) {
    var ctas = el('div', 'luna-location-ctas');

    var qLabel = encodeURIComponent(name || (lat + ', ' + lng));
    var googleUrl = 'https://www.google.com/maps/search/?api=1&query=' + qLabel + '&query_place_id=&center=' + lat + ',' + lng;
    var appleUrl = 'https://maps.apple.com/?ll=' + lat + ',' + lng + (name ? '&q=' + qLabel : '');

    var googleBtn = document.createElement('a');
    googleBtn.className = 'luna-location-cta luna-location-cta-primary';
    googleBtn.href = safeUrl(googleUrl);
    googleBtn.target = '_blank';
    googleBtn.rel = 'noopener noreferrer';
    googleBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg><span>Open in Google Maps</span>';
    ctas.appendChild(googleBtn);

    var appleBtn = document.createElement('a');
    appleBtn.className = 'luna-location-cta luna-location-cta-secondary';
    appleBtn.href = safeUrl(appleUrl);
    appleBtn.target = '_blank';
    appleBtn.rel = 'noopener noreferrer';
    appleBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg><span>Open in Apple Maps</span>';
    ctas.appendChild(appleBtn);

    card.appendChild(ctas);
  }

  return card;
}

// ─────────── BLOCK: weather_card ───────────
// Live weather + 12-month climate. Live data from Open-Meteo when the
// destination has coordinates; falls back to climate-only when not.

var MONTH_LABELS = ['J','F','M','A','M','J','J','A','S','O','N','D'];
var MONTH_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
var DAY_SHORT = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Map Open-Meteo WMO weather codes to icon name + short label.
// Reference: https://open-meteo.com/en/docs (Weather Variables section)
function wmoCodeToIcon(code) {
  if (typeof code !== 'number') return { icon: 'sun', label: 'Mild' };
  if (code === 0) return { icon: 'sun', label: 'Clear sky' };
  if (code === 1 || code === 2) return { icon: 'sunCloud', label: code === 1 ? 'Mainly clear' : 'Partly cloudy' };
  if (code === 3) return { icon: 'cloud', label: 'Overcast' };
  if (code >= 45 && code <= 48) return { icon: 'cloud', label: 'Foggy' };
  if (code >= 51 && code <= 57) return { icon: 'rain', label: 'Drizzle' };
  if (code >= 61 && code <= 67) return { icon: 'rain', label: 'Rain' };
  if (code >= 71 && code <= 77) return { icon: 'snow', label: 'Snow' };
  if (code >= 80 && code <= 82) return { icon: 'rain', label: 'Showers' };
  if (code >= 85 && code <= 86) return { icon: 'snow', label: 'Snow showers' };
  if (code >= 95) return { icon: 'storm', label: 'Thunderstorm' };
  return { icon: 'sun', label: 'Mild' };
}

function weatherIconSvg(iconName, size) {
  var s = size || 28;
  var stroke = 'currentColor';
  if (iconName === 'sun') {
    return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" stroke="'+stroke+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4.5" fill="'+stroke+'" stroke="none" opacity="0.85"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.9" y1="4.9" x2="6.3" y2="6.3"/><line x1="17.7" y1="17.7" x2="19.1" y2="19.1"/><line x1="4.9" y1="19.1" x2="6.3" y2="17.7"/><line x1="17.7" y1="6.3" x2="19.1" y2="4.9"/></svg>';
  }
  if (iconName === 'sunCloud') {
    return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" stroke="'+stroke+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="9" r="3" fill="'+stroke+'" stroke="none" opacity="0.85"/><path d="M14 18a4 4 0 0 0 0-8 5 5 0 0 0-9.7 1A3 3 0 0 0 5 18z" fill="'+stroke+'" fill-opacity="0.18"/></svg>';
  }
  if (iconName === 'cloud') {
    return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" stroke="'+stroke+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 18a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A4 4 0 0 0 6 18z" fill="'+stroke+'" fill-opacity="0.25"/></svg>';
  }
  if (iconName === 'rain') {
    return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" stroke="'+stroke+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 14a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A4 4 0 0 0 6 14z" fill="'+stroke+'" fill-opacity="0.25"/><line x1="8" y1="17" x2="7" y2="20"/><line x1="12" y1="17" x2="11" y2="20"/><line x1="16" y1="17" x2="15" y2="20"/></svg>';
  }
  if (iconName === 'snow') {
    return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" stroke="'+stroke+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 14a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A4 4 0 0 0 6 14z" fill="'+stroke+'" fill-opacity="0.2"/><line x1="8" y1="18" x2="8" y2="20"/><line x1="12" y1="18" x2="12" y2="20"/><line x1="16" y1="18" x2="16" y2="20"/><circle cx="8" cy="19" r="0.6" fill="'+stroke+'" stroke="none"/><circle cx="12" cy="19" r="0.6" fill="'+stroke+'" stroke="none"/><circle cx="16" cy="19" r="0.6" fill="'+stroke+'" stroke="none"/></svg>';
  }
  if (iconName === 'storm') {
    return '<svg width="'+s+'" height="'+s+'" viewBox="0 0 24 24" fill="none" stroke="'+stroke+'" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 14a4 4 0 0 0 0-8 6 6 0 0 0-11.5 1.5A4 4 0 0 0 6 14z" fill="'+stroke+'" fill-opacity="0.25"/><polyline points="11,15 9,19 12,19 10,22"/></svg>';
  }
  return '';
}

// Pick a hero gradient based on the current condition icon.
function heroGradientFor(iconName) {
  switch (iconName) {
    case 'sun':       return 'linear-gradient(135deg, #FFB347 0%, #FF8C42 100%)';
    case 'sunCloud':  return 'linear-gradient(135deg, #94B8E0 0%, #4A8BD4 100%)';
    case 'cloud':     return 'linear-gradient(135deg, #94A3B8 0%, #64748B 100%)';
    case 'rain':      return 'linear-gradient(135deg, #6B8FB5 0%, #3B5C7E 100%)';
    case 'snow':      return 'linear-gradient(135deg, #BFDBFE 0%, #7DA5C7 100%)';
    case 'storm':     return 'linear-gradient(135deg, #4B5563 0%, #1F2937 100%)';
    default:          return 'linear-gradient(135deg, #94B8E0 0%, #4A8BD4 100%)';
  }
}

// Find the longest contiguous "best" run in the seasons array and format
// as a month-name range (e.g. "May to September"). Handles wrap-around for
// destinations whose best season spans the new year. Returns null if none.
function computeBestMonthsRange(seasons) {
  if (!Array.isArray(seasons) || seasons.length !== 12) return null;
  var runs = [];
  var currentStart = -1;
  for (var i = 0; i < 12; i++) {
    if (seasons[i] === 'best') {
      if (currentStart === -1) currentStart = i;
    } else {
      if (currentStart !== -1) {
        runs.push({ start: currentStart, end: i - 1 });
        currentStart = -1;
      }
    }
  }
  if (currentStart !== -1) runs.push({ start: currentStart, end: 11 });
  // Wrap-around: if best starts at Jan AND ends at Dec, merge first+last
  if (runs.length >= 2 && seasons[0] === 'best' && seasons[11] === 'best') {
    var first = runs[0];
    var last = runs[runs.length - 1];
    if (first.start === 0 && last.end === 11) {
      runs[0] = { start: last.start, end: first.end, wraps: true };
      runs.pop();
    }
  }
  if (runs.length === 0) return null;
  // Pick the longest run
  var longest = runs.reduce(function(a, b) {
    var lenA = a.wraps ? (12 - a.start) + (a.end + 1) : (a.end - a.start + 1);
    var lenB = b.wraps ? (12 - b.start) + (b.end + 1) : (b.end - b.start + 1);
    return lenB > lenA ? b : a;
  });
  var startName = MONTH_FULL[longest.start];
  var endName = MONTH_FULL[longest.end];
  if (longest.start === longest.end) return startName;
  return startName + ' to ' + endName;
}

function renderWeatherCard(props, ctx) {
  var card = el('div', 'luna-weather-card');

  var name = typeof props.name === 'string' ? props.name : '';
  var subtitle = typeof props.subtitle === 'string' ? props.subtitle : '';
  var summary = typeof props.summary === 'string' ? props.summary : '';
  var temps = Array.isArray(props.tempsC) ? props.tempsC : [];
  var rainfall = Array.isArray(props.rainfallMm) ? props.rainfallMm : [];
  var seasons = Array.isArray(props.seasons) ? props.seasons : [];
  var highlight = (typeof props.highlightMonth === 'number' && props.highlightMonth >= 0 && props.highlightMonth <= 11) ? props.highlightMonth : -1;
  var hasLive = (typeof props.currentTempC === 'number' && typeof props.currentCode === 'number');

  // ─── HERO: today's weather ───
  if (hasLive) {
    var ico = wmoCodeToIcon(props.currentCode);
    var hero = el('div', 'luna-weather-hero');
    hero.style.background = heroGradientFor(ico.icon);
    var heroLeft = el('div', 'luna-weather-hero-left');
    var heroLoc = el('div', 'luna-weather-hero-loc', name || 'Today');
    heroLeft.appendChild(heroLoc);
    var heroLabel = el('div', 'luna-weather-hero-label', 'Right now · ' + ico.label);
    heroLeft.appendChild(heroLabel);
    var heroTemp = el('div', 'luna-weather-hero-temp');
    heroTemp.innerHTML = Math.round(props.currentTempC) + '<span class="luna-weather-deg">°C</span>';
    heroLeft.appendChild(heroTemp);
    // Mini stats: feels like, wind, humidity
    var stats = el('div', 'luna-weather-stats');
    if (typeof props.feelsLikeC === 'number') {
      var s1 = el('div', 'luna-weather-stat');
      s1.innerHTML = '<span class="luna-weather-stat-label">Feels like</span><span class="luna-weather-stat-value">' + Math.round(props.feelsLikeC) + '°</span>';
      stats.appendChild(s1);
    }
    if (typeof props.windKmh === 'number') {
      var s2 = el('div', 'luna-weather-stat');
      s2.innerHTML = '<span class="luna-weather-stat-label">Wind</span><span class="luna-weather-stat-value">' + Math.round(props.windKmh) + ' km/h</span>';
      stats.appendChild(s2);
    }
    if (typeof props.humidity === 'number') {
      var s3 = el('div', 'luna-weather-stat');
      s3.innerHTML = '<span class="luna-weather-stat-label">Humidity</span><span class="luna-weather-stat-value">' + props.humidity + '%</span>';
      stats.appendChild(s3);
    }
    heroLeft.appendChild(stats);
    hero.appendChild(heroLeft);
    // Right side: big icon
    var heroRight = el('div', 'luna-weather-hero-right');
    heroRight.innerHTML = weatherIconSvg(ico.icon, 72);
    hero.appendChild(heroRight);
    card.appendChild(hero);

    // ─── 7-day forecast strip ───
    if (Array.isArray(props.forecast) && props.forecast.length > 0) {
      var forecast = el('div', 'luna-weather-forecast');
      props.forecast.slice(0, 7).forEach(function(d, idx) {
        var day = el('div', 'luna-weather-day');
        var dayName;
        if (idx === 0) {
          dayName = 'Today';
        } else {
          try {
            var dt = new Date(d.date);
            dayName = DAY_SHORT[dt.getDay()];
          } catch (e) { dayName = ''; }
        }
        var nameEl = el('div', 'luna-weather-day-name', dayName);
        day.appendChild(nameEl);
        var dayIco = wmoCodeToIcon(d.code);
        var iconEl = el('div', 'luna-weather-day-icon');
        iconEl.innerHTML = weatherIconSvg(dayIco.icon, 24);
        day.appendChild(iconEl);
        var hi = el('div', 'luna-weather-day-hi', Math.round(d.highC) + '°');
        day.appendChild(hi);
        var lo = el('div', 'luna-weather-day-lo', Math.round(d.lowC) + '°');
        day.appendChild(lo);
        forecast.appendChild(day);
      });
      card.appendChild(forecast);
    }
  } else {
    // No live data — show a tighter header band like the original card
    var head = el('div', 'luna-weather-head');
    var icon = document.createElement('span');
    icon.className = 'luna-weather-icon';
    icon.innerHTML = weatherIconSvg('sun', 14);
    head.appendChild(icon);
    var headText = el('div', 'luna-weather-head-text');
    if (name) headText.appendChild(el('div', 'luna-weather-name', 'Climate · ' + name));
    if (subtitle) headText.appendChild(el('div', 'luna-weather-subtitle', subtitle));
    head.appendChild(headText);
    card.appendChild(head);
  }

  // ─── Climate body (chart + summary + callout) ───
  var body = el('div', 'luna-weather-body');

  // Section label (only if hero present, to distinguish historical from live)
  if (hasLive && temps.length === 12) {
    var sectionLbl = el('div', 'luna-weather-section-label', 'CLIMATE THROUGH THE YEAR');
    body.appendChild(sectionLbl);
  }

  // 12-month temperature chart — restructured: temp value sits in a reserved
  // slot at the TOP of each column (no absolute positioning), then bar
  // wrapper takes remaining flex space, then month label at the bottom.
  // This eliminates the overlap between temp labels and adjacent columns.
  if (temps.length === 12) {
    var maxTemp = Math.max.apply(null, temps.map(function(t) { return (typeof t === 'number' && isFinite(t)) ? t : 0; }));
    if (maxTemp < 30) maxTemp = 30;
    var chart = el('div', 'luna-weather-chart');
    for (var i = 0; i < 12; i++) {
      var col = el('div', 'luna-weather-col');
      if (i === highlight) col.classList.add('luna-weather-col-highlight');
      var ss = seasons[i] || '';
      if (ss === 'best') col.classList.add('luna-weather-col-best');
      else if (ss === 'shoulder') col.classList.add('luna-weather-col-shoulder');
      var t = (typeof temps[i] === 'number') ? temps[i] : 0;
      var pct = Math.max(8, Math.min(100, (t / maxTemp) * 100));
      // Temp value FIRST — sits in reserved top slot
      var value = el('div', 'luna-weather-temp', Math.round(t) + '°');
      col.appendChild(value);
      // Bar wrapper takes remaining flex space
      var barWrap = el('div', 'luna-weather-bar-wrap');
      var bar = el('div', 'luna-weather-bar');
      bar.style.height = pct + '%';
      barWrap.appendChild(bar);
      col.appendChild(barWrap);
      // Month label at the bottom
      var label = el('div', 'luna-weather-month-label', MONTH_LABELS[i]);
      col.appendChild(label);
      chart.appendChild(col);
    }
    body.appendChild(chart);

    // "Best months" pill derived from seasons array
    var bestRange = computeBestMonthsRange(seasons);
    if (bestRange) {
      var bestPill = el('div', 'luna-weather-best-pill');
      bestPill.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15 8.5 22 9.3 17 14 18.2 21 12 17.8 5.8 21 7 14 2 9.3 9 8.5 12 2" fill="currentColor" fill-opacity="0.15"/></svg><span>Best months: ' + bestRange + '</span>';
      body.appendChild(bestPill);
    }

    // Legend
    var legend = el('div', 'luna-weather-legend');
    var leg1 = el('span', 'luna-weather-legend-item');
    leg1.innerHTML = '<span class="luna-weather-legend-swatch luna-weather-swatch-best"></span>Best months';
    var leg2 = el('span', 'luna-weather-legend-item');
    leg2.innerHTML = '<span class="luna-weather-legend-swatch luna-weather-swatch-shoulder"></span>Shoulder';
    var leg3 = el('span', 'luna-weather-legend-item');
    leg3.innerHTML = '<span class="luna-weather-legend-swatch luna-weather-swatch-off"></span>Off-peak';
    legend.appendChild(leg1); legend.appendChild(leg2); legend.appendChild(leg3);
    body.appendChild(legend);
  }

  if (summary) body.appendChild(el('div', 'luna-weather-summary', summary));

  if (highlight >= 0 && temps[highlight] != null) {
    var callout = el('div', 'luna-weather-callout');
    var monthName = MONTH_FULL[highlight];
    var temp = Math.round(temps[highlight]);
    var rain = rainfall[highlight];
    var season = seasons[highlight] || '';
    var seasonLabel = season === 'best' ? 'a peak month' :
                      season === 'shoulder' ? 'a shoulder month' :
                      season === 'off' ? 'off-peak' : '';
    var msg = 'In ' + monthName + ', expect around ' + temp + '°C';
    if (typeof rain === 'number') msg += ', ' + Math.round(rain) + 'mm rainfall';
    if (seasonLabel) msg += ' — ' + seasonLabel;
    msg += '.';
    callout.textContent = msg;
    body.appendChild(callout);
  }

  card.appendChild(body);
  return card;
}

// ─────────── DISPATCH ───────────

const RENDERERS = {
  destination_card:    renderDestinationCard,
  offer_card:          renderOfferCard,
  faq_policy_card:     renderFaqPolicyCard,
  booking_lookup_card: renderBookingLookupCard,
  human_handoff_card:  renderHumanHandoffCard,
  emergency_card:      renderEmergencyCard,
  location_card:       renderLocationCard,
  weather_card:        renderWeatherCard,
  quick_replies:       renderQuickReplies
};

/**
 * Single entry point for rendering a block.
 *
 * @param {string} blockType  e.g. 'destination_card'
 * @param {object} props      The block's props (from Luna's response)
 * @param {object} ctx        { dispatch: (event) => void }
 * @returns {HTMLElement}     A DOM node ready to be appended
 */
function renderBlock(blockType, props, ctx = {}) {
  const renderer = RENDERERS[blockType];
  if (!renderer) {
    return renderFallback(blockType, props);
  }
  try {
    return renderer(props || {}, ctx);
  } catch (err) {
    console.error('[Luna] Block render error:', blockType, err);
    return renderFallback(blockType, props);
  }
}

/**
 * Renders a full sequence of parsed items (prose + blocks) into a fragment
 * ready to append to the message thread.
 *
 * @param {Array}  items     Output of parseLunaResponse()
 * @param {object} ctx       Same as renderBlock
 * @returns {DocumentFragment}
 */
function renderItems(items, ctx = {}) {
  const frag = document.createDocumentFragment();
  if (!Array.isArray(items)) return frag;

  items.forEach(item => {
    if (item.type === 'prose') {
      const bubble = el('div', 'luna-bubble luna-bubble-assistant', item.text);
      frag.appendChild(bubble);
    } else if (item.type === 'block') {
      frag.appendChild(renderBlock(item.blockType, item.props, ctx));
    }
    // 'malformed' items are silently dropped — never render unparseable content
  });

  return frag;
}

// ─────────── EXPORTS ───────────
/* Inlined for browser: register on window.LunaBlockRenderers */
window.LunaBlockRenderers = {
  renderBlock,
  renderItems,
  safeUrl,
  // Exposed for tests / debugging
  _RENDERERS: RENDERERS,
  _ICONS: ICONS
};


/* ─── LUNA WIDGET CORE ─── */
(function() {
"use strict";

/* ─── CONFIG ─────────────────────────────────────────────────
   Priority: window.__LUNA_CONFIG > data-* attributes on script tag > defaults
   ──────────────────────────────────────────────────────────── */
var scriptTag = document.currentScript || document.querySelector('script[src*="widget-core"]');
function attr(name) { return scriptTag && scriptTag.getAttribute("data-" + name); }

var D = {
  /* Identity */
  name: "Luna AI",
  tagline: "AI ASSISTANT",
  logoText: "L",
  profileImage: "",          /* URL to avatar image — overrides logoText */
  welcome: "Hey there! How can we help you today?",
  hints: ["All-inclusive under £800","Best Greek islands for families","Last-minute deals","Do you do Maldives?","Flights to Tenerife"],
  collectName: true,
  namePrompt: "Before we start, what's your name?",
  skipLabel: "Skip",
  escalateLabel: "Talk to a human",
  leaveLabel: "Leave a message",
  footer: "Powered by Luna AI",
  privacyUrl: "",

  /* Endpoints & keys */
  endpoint: "https://luna-chat-endpoint.vercel.app/api/luna-chat",
  ablyTokenEndpoint: "https://luna-chat-endpoint.vercel.app/api/ably-token",
  clientName: "Travelgenix",
  /* NOTE: ablyKey removed — tokens are now fetched server-side via ablyTokenEndpoint.
     The widget never holds a root Ably key. */
  airtableKey: "",
  airtableBase: "",
  convTable: "",

  /* Theme: "light" (default) or "dark" */
  theme: "light",

  /* Colours — just two client-configurable colours; everything derives */
  brandColor: "#1B2B5B",
  accentColor: "#00B4D8",

  /* Size preset: "small" | "medium" | "large" */
  widgetSize: "medium",
  radius: "18px",

  /* Position & mobile */
  position: "right",         /* "left" or "right" */
  fabPosition: "bottom-right", /* bottom-right | bottom-left | mid-right | mid-left */
  mobileBubble: "normal",    /* "normal" | "small" | "hidden" */
  bubbleIcon: "",            /* URL to custom FAB icon */

  /* Auto-trigger */
  autoTrigger: null,          /* { enabled: true, delay: 5, message: "..." } */

  /* Capability cards on home screen — array of {icon, title, desc} */
  capabilityCards: [
    { icon:"plane", title:"Find me a holiday", desc:"Search thousands of packages, flights and hotels — live prices, real availability" },
    { icon:"compass", title:"Help me decide", desc:"Compare destinations, get recommendations, check what's included" },
    { icon:"helpCircle", title:"Answer my questions", desc:"Pricing, what's included, luggage, transfers — ask me anything" }
  ]
};

/* Merge phase 1: window config > data-attrs > defaults */
var W = (typeof window.__LUNA_CONFIG === "object") ? window.__LUNA_CONFIG : {};
var C = {};
function rebuildConfig(apiConfig) {
  var A = apiConfig || {};
  Object.keys(D).forEach(function(k) {
    C[k] = A[k] !== undefined ? A[k] : (W[k] !== undefined ? W[k] : (attr(k) || D[k]));
  });
  /* Map API theme fields (backwards compat with old colour-by-colour config) */
  if (A.theme && typeof A.theme === "object") {
    if (A.theme.brandColor) C.brandColor = A.theme.brandColor;
    if (A.theme.accentColor) C.accentColor = A.theme.accentColor;
    if (A.theme.mode) C.theme = A.theme.mode;
  }
  /* Map API size fields */
  if (A.size) {
    if (A.size.widgetSize) C.widgetSize = A.size.widgetSize;
    if (A.size.radius) C.radius = A.size.radius;
  }
  /* ─── Map dashboard config keys to widget-core internal names ───
     The dashboard (and its /api/profile endpoint) saves these keys, but
     widget-core reads slightly different names internally. Bind them here
     so dashboard changes actually take effect on the widget. */
  if (A.widgetSizeV2) C.widgetSize = A.widgetSizeV2;
  else if (A.widgetSize) C.widgetSize = A.widgetSize;
  if (A.widgetWelcome !== undefined) C.welcome = A.widgetWelcome;
  if (A.widgetTagline !== undefined) C.tagline = A.widgetTagline;
  if (A.widgetBotName !== undefined) C.name = A.widgetBotName;
  if (A.widgetHints !== undefined) {
    // hints may be a newline-separated string from Airtable
    if (typeof A.widgetHints === "string") {
      C.hints = A.widgetHints.split(/\r?\n/).map(function(h){ return h.trim(); }).filter(Boolean);
    } else if (Array.isArray(A.widgetHints)) {
      C.hints = A.widgetHints;
    }
  }
  /* Theme mode — dashboard saves themeMode at top level */
  if (A.themeMode !== undefined) C.theme = A.themeMode;
  /* Logo text — dashboard saves logoText, widget-core reads logoText (same key but
     defensively map). Profile image / bubble icon already correctly bound above. */
  if (A.logoText !== undefined) C.logoText = A.logoText;
  /* Auto-trigger — dashboard saves three flat fields, widget-core wants nested */
  if (A.autoTriggerEnabled !== undefined || A.autoTriggerDelay !== undefined || A.autoTriggerMessage !== undefined) {
    var triggerEnabled = !!A.autoTriggerEnabled;
    if (triggerEnabled) {
      C.autoTrigger = {
        enabled: true,
        delay: parseInt(A.autoTriggerDelay, 10) || 30,
        message: A.autoTriggerMessage || ""
      };
    } else {
      C.autoTrigger = null;
    }
  }
  if (A.position) C.position = A.position;
  if (A.fabPosition) C.fabPosition = A.fabPosition;
  if (A.mobileBubble) C.mobileBubble = A.mobileBubble;
  if (A.autoTrigger) C.autoTrigger = A.autoTrigger;
  if (A.privacyUrl) C.privacyUrl = A.privacyUrl;
  if (A.profileImage) C.profileImage = A.profileImage;
  if (A.bubbleIcon) C.bubbleIcon = A.bubbleIcon;
  if (A.capabilityCards && Array.isArray(A.capabilityCards)) C.capabilityCards = A.capabilityCards;
  /* hints might be a JSON string from data-attr */
  if (typeof C.hints === "string") {
    try { C.hints = JSON.parse(C.hints); } catch(e) { C.hints = D.hints; }
  }
  if (typeof C.collectName === "string") C.collectName = C.collectName === "true";
}
rebuildConfig(null);

/* ─── SIZE PRESETS ───────────────────────────────────────── */
var SIZES = {
  small:  { w: 340, h: 480, fab: 52 },
  medium: { w: 380, h: 560, fab: 56 },
  large:  { w: 420, h: 640, fab: 62 },
  xlarge: { w: 546, h: 832, fab: 80 }
};
function getSize() { return SIZES[C.widgetSize] || SIZES.medium; }

/* ─── PAGE CONTEXT GATHERING (Phase 3) ────────────────────
   Returns rich context about the page the visitor is on, sent to the backend
   on each /api/luna-chat call so Luna can craft contextual opening messages
   and stay aware of where the visitor is. Trimmed to ~1.5KB to keep tokens
   under control. */
function gatherPageContext() {
  try {
    var title = (document.title || '').slice(0, 200);
    var path = window.location.pathname || '/';
    // Prefer page author hint if provided
    var metaTag = document.querySelector('meta[name="luna-context"]');
    var primary = metaTag ? (metaTag.getAttribute('content') || '').trim() : '';
    if (!primary) {
      // Extract from likely content containers
      var roots = ['main', 'article', '[role=main]', '#main', '#content', '.content', 'body'];
      for (var i = 0; i < roots.length; i++) {
        var el = document.querySelector(roots[i]);
        if (!el) continue;
        // Clone, strip nav/footer/aside/script/style/luna's own UI
        var clone = el.cloneNode(true);
        var killSel = 'nav,header,footer,aside,script,style,noscript,#tgx-cw,.tgx-cw,form,iframe';
        var kills = clone.querySelectorAll(killSel);
        for (var k = 0; k < kills.length; k++) kills[k].parentNode && kills[k].parentNode.removeChild(kills[k]);
        var text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 80) {
          primary = text.slice(0, 1200);
          break;
        }
      }
    }
    return { title: title, path: path, url: window.location.href, primaryContent: primary };
  } catch(e) {
    return { title: document.title || '', path: window.location.pathname || '/', url: window.location.href, primaryContent: '' };
  }
}

/* Cache the gathered context per session — we recompute on each open in case
   the visitor has navigated, but within a single open use the cached snapshot. */
var _currentPageContext = null;


/* ─── BOOKING LOOKUP INTEGRATION (tg-widgets bridge) ─────── */
/* Loads widget-mybooking.js cross-origin on demand and instantiates a compact
   booking widget inside a chat bubble when Luna outputs the marker. */
var TG_WIDGETS_BASE = "https://widgets.travelify.io";
var TG_BOOKING_SCRIPT = TG_WIDGETS_BASE + "/widget-mybooking.js";
var TG_CONFIG_API = TG_WIDGETS_BASE + "/api/widget-config";
var _tgBookingScriptPromise = null;
var _tgConfigCache = {};

/* Active pill-release observers waiting on booking-widget loads.
   When the visitor sends a new message, we cancel any pending pill releases
   so stale follow-up pills don't suddenly appear long after the conversation
   has moved on. Each entry is a { cancel: fn } record. */
var _pendingPillReleases = [];

/* Currently visible booking summary, captured from the embedded My Booking
   widget when state.stage === 'found'. Sent as `bookingContext` on every
   subsequent /api/luna-chat request so Luna can answer follow-up questions
   ("what documents do I need?") with reference to the actual trip rather
   than asking the visitor for facts already on screen.

   Privacy: the summary is fetched via widgetInstance.getSafeContextSummary()
   which deliberately strips names, emails, prices, references and special
   requests. See widget-mybooking.js v1.4.0+ for the redaction rules. */
var _currentBookingContext = null;

function cancelPendingPillReleases() {
  while (_pendingPillReleases.length) {
    var entry = _pendingPillReleases.shift();
    try { entry.cancel(); } catch (_) {}
  }
}

function loadBookingWidgetScript() {
  if (window.TGMyBookingWidget) return Promise.resolve();
  if (_tgBookingScriptPromise) return _tgBookingScriptPromise;
  _tgBookingScriptPromise = new Promise(function(resolve, reject) {
    var s = document.createElement("script");
    s.src = TG_BOOKING_SCRIPT;
    s.async = true;
    s.onload = function() {
      if (window.TGMyBookingWidget) return resolve();
      var tries = 0;
      var interval = setInterval(function() {
        tries++;
        if (window.TGMyBookingWidget) {
          clearInterval(interval);
          resolve();
        } else if (tries > 30) {
          clearInterval(interval);
          reject(new Error("TGMyBookingWidget did not load"));
        }
      }, 100);
    };
    s.onerror = function() {
      _tgBookingScriptPromise = null;
      reject(new Error("Failed to load booking widget script"));
    };
    document.head.appendChild(s);
  });
  return _tgBookingScriptPromise;
}

/* Strict widget ID validator. The tg-widgets dashboard mints IDs in the
   form "tgw_<timestamp>_<6chars>" (sometimes with extra underscored
   suffixes from earlier formats, e.g. "tgw_1776433139217_ksgj_l9q4w").
   We accept that pattern conservatively: must start with "tgw_", then
   only [a-z0-9_], up to 80 chars total. Older "rec..." IDs (Airtable
   record IDs) are also accepted as a fallback for any legacy data. */
function isSafeWidgetId(id) {
  if (typeof id !== "string") return false;
  if (id.length < 4 || id.length > 80) return false;
  return /^tgw_[a-z0-9_]+$/i.test(id) || /^rec[A-Za-z0-9]{14}$/.test(id);
}

/* Fetches and caches the booking widget's config. Returns null on failure.
   /api/widget-config returns the config object directly (not wrapped under
   a `config` key), so we use the response body as-is and tag on the widget
   ID and forced compact layout for the chat embed context. */
function fetchBookingConfig(widgetId) {
  if (_tgConfigCache[widgetId]) return Promise.resolve(_tgConfigCache[widgetId]);
  return fetch(TG_CONFIG_API + "?id=" + encodeURIComponent(widgetId), {
    method: "GET",
    headers: { "Accept": "application/json" }
  })
  .then(function(res) {
    if (!res.ok) return null;
    return res.json();
  })
  .then(function(data) {
    if (!data || typeof data !== "object") return null;
    /* Defensive copy so we don't mutate any cached fetch internals */
    var config = Object.assign({}, data);
    config.widgetId = widgetId;
    config.layout = "compact"; /* Force compact for chat embed */
    /* v2.1: override the booking widget's stored brand colours with the chat's
       so the embed blends visually with the surrounding conversation. The
       booking widget's design.colors map covers primary/accent — we override
       both here. Original config.design is preserved if present. */
    if (C.brandColor || C.accentColor) {
      config.design = Object.assign({}, config.design || {});
      config.design.colors = Object.assign({}, (config.design && config.design.colors) || {});
      if (C.brandColor) {
        config.design.colors.primary = C.brandColor;
        config.design.colors.brand = C.brandColor;
      }
      if (C.accentColor) {
        config.design.colors.accent = C.accentColor;
        config.design.colors.secondary = C.accentColor;
      }
    }
    _tgConfigCache[widgetId] = config;
    return config;
  })
  .catch(function(err) {
    console.warn("Luna widget: failed to fetch booking config:", err.message);
    return null;
  });
}

/* Parses [BOOKING_LOOKUP:rec...] marker out of the bot reply.
   Returns { cleanText, widgetId? }. */
function extractBookingLookupMarker(text) {
  if (typeof text !== "string" || !text) return { cleanText: text };
  /* Accept both the new "tgw_..." widget IDs and legacy "rec..." Airtable
     record IDs. The captured ID is then re-validated by isSafeWidgetId
     before it goes anywhere near the DOM. */
  var re = /\[BOOKING_LOOKUP:(tgw_[a-z0-9_]+|rec[A-Za-z0-9]{14})\]/i;
  var m = text.match(re);
  if (!m) return { cleanText: text };
  var cleanText = text.replace(re, "").trim();
  return { cleanText: cleanText, widgetId: m[1] };
}

/* ─── STATE ──────────────────────────────────────────────── */
var msgs = [];
var history = [];
var userName = "";
var visitorEmail = "";
var marketingConsent = false;
var panelOpen = false;
var nameCollected = false;
var convId = null;
var convStarted = false;
var liveMode = false;
var unread = 0;
var typingTimeout = null;
var ably = null;
var dashChannel = null;
var chatChannel = null;
var agentsChannel = null;
var visitorCountry = "";
var visitorId = "";
var autoTriggerTimer = null;
var autoTriggered = false;
var visitorInteracted = false;
var conversationLang = "";
var currentScreen = "home"; /* "home" or "chat" */
var sessionRestored = false;

/* ─── SESSION PERSISTENCE ───────────────────────────────── */
var SESSION_KEY = "luna_session";
/* Clear conversation flow.
   Shows an inline confirmation in the email bar slot, then on confirm
   wipes session + DOM and returns to the home screen. */
function showClearConfirm() {
  var bar = document.getElementById("tgxEmailBar");
  if (!bar) {
    // Fallback: native confirm if email bar not present
    if (confirm("Start a new conversation? Your current chat will be cleared.")) {
      clearConversation();
    }
    return;
  }
  bar.innerHTML =
    '<div class="tgx-clear-confirm">' +
      '<span class="tgx-clear-confirm-text">Clear this conversation and start fresh?</span>' +
      '<div class="tgx-clear-confirm-actions">' +
        '<button class="tgx-clear-confirm-btn tgx-clear-confirm-yes" id="tgxClearYes">Yes, clear it</button>' +
        '<button class="tgx-clear-confirm-btn tgx-clear-confirm-no" id="tgxClearNo">Cancel</button>' +
      '</div>' +
    '</div>';
  bar.style.display = "block";
  document.getElementById("tgxClearYes").addEventListener("click", function() {
    clearConversation();
  });
  document.getElementById("tgxClearNo").addEventListener("click", function() {
    // Restore email link
    bar.innerHTML = '<span class="tgx-email-link" id="tgxEmailLink">&#128231; Email this chat</span>';
    var link = document.getElementById("tgxEmailLink");
    if (link) link.addEventListener("click", handleEmailChat);
  });
}

function clearConversation() {
  // Log the conversation we're about to clear so the server captures it.
  try { logConversationToServer({ force: true }); } catch(e) {}

  // Reset in-memory state
  msgs = [];
  history = [];
  convId = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2,9);
  convStarted = false;
  // Keep userName, visitorEmail, marketingConsent, nameCollected — visitor identity persists
  // Wipe the message rendering area
  if ($msgs) $msgs.innerHTML = "";
  // Clear pills
  var pillsEl = document.getElementById("tgxPills");
  if (pillsEl) pillsEl.innerHTML = "";
  // Reset typing indicator
  var typingRow = document.getElementById("tgxTypingRow");
  if (typingRow) typingRow.classList.remove("active");
  // Reset email bar to default
  var bar = document.getElementById("tgxEmailBar");
  if (bar) {
    bar.innerHTML = '<span class="tgx-email-link" id="tgxEmailLink">&#128231; Email this chat</span>';
    var link = document.getElementById("tgxEmailLink");
    if (link) link.addEventListener("click", handleEmailChat);
  }
  // Hide more-below indicator
  hideMoreBelow();
  // Save the cleared state
  saveSession();
  // Go back to home view
  if (typeof switchToHome === "function") switchToHome();
  console.log("[Luna] conversation cleared");
}

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      userName: userName,
      visitorEmail: visitorEmail,
      marketingConsent: marketingConsent,
      nameCollected: nameCollected,
      msgs: msgs,
      history: history,
      convId: convId,
      convStarted: convStarted,
      conversationLang: conversationLang,
      currentScreen: currentScreen
    }));
  } catch(e) {}
}
function restoreSession() {
  try {
    var raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return false;
    var s = JSON.parse(raw);
    if (!s.convId) return false;
    userName = s.userName || "";
    visitorEmail = s.visitorEmail || "";
    marketingConsent = !!s.marketingConsent;
    nameCollected = !!s.nameCollected;
    msgs = s.msgs || [];
    history = s.history || [];
    convId = s.convId;
    convStarted = !!s.convStarted;
    conversationLang = s.conversationLang || "";
    currentScreen = s.currentScreen || "home";
    return true;
  } catch(e) { return false; }
}

/* ─── AUTO-TRIGGER HELPERS ───────────────────────────────── */
function cancelAutoTrigger() {
  if (autoTriggerTimer) { clearTimeout(autoTriggerTimer); autoTriggerTimer = null; }
  visitorInteracted = true;
}

function playNotifSound() {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880; osc.type = "sine";
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime + 0.3);
  } catch(e) {}
}

/* ─── LOAD ABLY SDK ──────────────────────────────────────── */
function loadAbly(cb) {
  if (window.Ably) return cb();
  var s = document.createElement("script");
  s.src = "https://cdn.ably.com/lib/ably.min-2.js";
  s.onload = cb;
  s.onerror = function() { console.error("Luna widget: failed to load Ably SDK"); cb(); };
  document.head.appendChild(s);
}

/* ─── SVG ICONS ──────────────────────────────────────────── */
var ICONS = {
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  minus: '<path d="M5 12h14"/>',
  arrowLeft: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  plane: '<path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2Z"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  helpCircle: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'
};
function svgIcon(name, size, color) {
  return '<svg width="'+(size||20)+'" height="'+(size||20)+'" viewBox="0 0 24 24" fill="none" stroke="'+(color||"currentColor")+'" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">'+(ICONS[name]||'')+'</svg>';
}

/* ─── THEME TOKENS (v2) ──────────────────────────────────── */
function getTokens() {
  var isDark = C.theme === "dark";

  if (isDark) {
    return {
      /* v2 tokens */
      bg:           "#0F1318",
      bgCard:       "#14181F",
      bgCardHi:     "#1A1F28",
      panelBg:      "rgba(20,24,32,0.62)",
      textHi:       "#F4F5F7",
      textMid:      "#A8B0BD",
      textLow:      "#6B7280",
      line:         "rgba(255,255,255,0.08)",
      lineHi:       "rgba(255,255,255,0.14)",
      glassTint:    "rgba(255,255,255,0.06)",
      glassTintHi:  "rgba(255,255,255,0.10)",
      insetHi:      "rgba(255,255,255,0.12)",
      shadowStrong: "0 24px 64px rgba(0,0,0,0.45),0 8px 24px rgba(0,0,0,0.25)",
      shadowCard:   "rgba(0,0,0,0.30)",
      overlayBg:    "rgba(15,19,24,0.85)",
      /* legacy tokens — kept so any reference still resolves */
      bgSec:        "#1A1F28",
      bgTer:        "#22272F",
      border:       "rgba(255,255,255,0.08)",
      borderLight:  "rgba(255,255,255,0.05)",
      text1:        "#F4F5F7",
      text2:        "#A8B0BD",
      text3:        "#6B7280",
      botBubble:    "#14181F",
      botText:      "#F4F5F7",
      userBubble:   C.brandColor,
      userText:     "#FFFFFF",
      inputBg:      "rgba(255,255,255,0.06)",
      inputText:    "#F4F5F7",
      overlayText:  "#F4F5F7",
      overlayMuted: "rgba(244,245,247,0.65)",
      pillBg:       "rgba(255,255,255,0.06)",
      pillBorder:   "rgba(255,255,255,0.14)",
      pillText:     "#F4F5F7",
      shadow:       "0 24px 64px rgba(0,0,0,0.45),0 8px 24px rgba(0,0,0,0.25),inset 0 1px 0 rgba(255,255,255,0.12)"
    };
  }

  /* light */
  return {
    bg:           "#FFFFFF",
    bgCard:       "#FFFFFF",
    bgCardHi:     "#FAFAF8",
    panelBg:      "rgba(255,255,255,0.78)",
    textHi:       "#15171C",
    textMid:      "#5C6470",
    textLow:      "#8A92A0",
    line:         "rgba(15,17,22,0.08)",
    lineHi:       "rgba(15,17,22,0.14)",
    glassTint:    "rgba(0,0,0,0.04)",
    glassTintHi:  "rgba(0,0,0,0.07)",
    insetHi:      "rgba(255,255,255,0.65)",
    shadowStrong: "0 24px 56px rgba(15,17,22,0.18),0 8px 20px rgba(15,17,22,0.08)",
    shadowCard:   "rgba(15,17,22,0.10)",
    overlayBg:    "rgba(255,255,255,0.85)",
    /* legacy */
    bgSec:        "#F8FAFC",
    bgTer:        "#F1F5F9",
    border:       "rgba(15,17,22,0.08)",
    borderLight:  "rgba(15,17,22,0.04)",
    text1:        "#15171C",
    text2:        "#5C6470",
    text3:        "#8A92A0",
    botBubble:    "#FFFFFF",
    botText:      "#15171C",
    userBubble:   C.brandColor,
    userText:     "#FFFFFF",
    inputBg:      "rgba(0,0,0,0.04)",
    inputText:    "#15171C",
    overlayText:  "#15171C",
    overlayMuted: "rgba(15,17,22,0.55)",
    pillBg:       "rgba(0,0,0,0.04)",
    pillBorder:   "rgba(15,17,22,0.14)",
    pillText:     "#15171C",
    shadow:       "0 24px 56px rgba(15,17,22,0.18),0 8px 20px rgba(15,17,22,0.08),inset 0 1px 0 rgba(255,255,255,0.65)"
  };
}

/* ─── INJECT CSS (v2.1 — Navy + Coral, persistent input, 2x2 grid) ─── */
function injectCSS() {
  var old = document.getElementById("tgx-cw-styles");
  if (old) old.remove();
  var s = document.createElement("style");
  s.id = "tgx-cw-styles";
  var T = getTokens();
  var sz = getSize();
  var isLeft = C.fabPosition.indexOf("left") !== -1;
  var isMid = C.fabPosition.indexOf("mid") !== -1;
  var fabSide = isLeft ? "left:24px" : "right:24px";
  var fabVert = isMid ? "top:50%;transform:translateY(-50%)" : "bottom:24px";
  var panelSide = isLeft ? "left:24px" : "right:24px";
  var fabRadius = isMid ? "16px" : "50%";

  // One-time Google Fonts load (Inter + Fraunces)
  if (!document.getElementById("tgx-cw-fonts")) {
    var fontLink = document.createElement("link");
    fontLink.id = "tgx-cw-fonts";
    fontLink.rel = "stylesheet";
    fontLink.href = "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Fraunces:opsz,wght@9..144,400;9..144,500;9..144,600&display=swap";
    document.head.appendChild(fontLink);
  }

  s.textContent = ''
  // Reset
  +'#tgx-cw *{box-sizing:border-box;margin:0;padding:0;font-family:"Inter",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}'

  // FAB — coral, with glow
  +'#tgx-cw .tgx-fab{position:fixed;'+fabVert+';'+fabSide+';width:'+sz.fab+'px;height:'+sz.fab+'px;border-radius:'+fabRadius+';background:'+C.accentColor+';border:none;cursor:pointer;z-index:999998;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 24px '+C.accentColor+'55,0 2px 8px '+C.accentColor+'30,inset 0 1px 0 rgba(255,255,255,0.2);transition:transform .25s cubic-bezier(.22,1,.36,1),box-shadow .25s ease}'
  +'#tgx-cw .tgx-fab:hover{transform:'+(isMid?'translateY(-50%) scale(1.08)':'scale(1.08)')+';box-shadow:0 12px 36px '+C.accentColor+'65,0 4px 12px '+C.accentColor+'40,inset 0 1px 0 rgba(255,255,255,0.25)}'
  +'#tgx-cw .tgx-fab svg{width:26px;height:26px;fill:none;stroke:#fff;stroke-width:1.75;stroke-linecap:round;stroke-linejoin:round}'
  +'#tgx-cw .tgx-fab img.tgx-fab-icon{width:30px;height:30px;object-fit:contain}'
  +'#tgx-cw .tgx-fab.open svg,.tgx-fab.open img{transform:rotate(90deg);transition:transform .3s cubic-bezier(.22,1,.36,1)}'
  +'#tgx-cw .tgx-badge{position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;border-radius:10px;background:#EF4444;color:#fff;font-size:11px;font-weight:700;display:none;align-items:center;justify-content:center;padding:0 5px;box-shadow:0 2px 6px rgba(239,68,68,0.4)}'

  // Panel — cream, soft shadow
  +'#tgx-cw .tgx-panel{position:fixed;bottom:'+((isMid?'50%':'96px'))+';'+panelSide+';width:'+sz.w+'px;height:'+sz.h+'px;max-width:calc(100vw - 32px);max-height:calc(100vh - 120px);background:#FAFAF6;border-radius:'+C.radius+';border:1px solid rgba(15,26,61,0.08);box-shadow:0 32px 80px rgba(15,26,61,0.25),0 12px 24px rgba(15,26,61,0.12);display:flex;flex-direction:column;overflow:hidden;z-index:999999;opacity:0;visibility:hidden;transform:translateY(16px) scale(0.96);transition:opacity .3s cubic-bezier(.22,1,.36,1),transform .3s cubic-bezier(.22,1,.36,1),visibility .3s}'
  +(isMid?'#tgx-cw .tgx-panel{transform:translateY(calc(-50% + 16px)) scale(0.96)}#tgx-cw .tgx-panel.open{transform:translateY(-50%) scale(1)}':'')
  +'#tgx-cw .tgx-panel{transition:opacity .3s cubic-bezier(.22,1,.36,1),transform .3s cubic-bezier(.22,1,.36,1),visibility .3s,width .35s cubic-bezier(.22,1,.36,1),height .35s cubic-bezier(.22,1,.36,1)}'
  +'#tgx-cw .tgx-panel.expanded{width:min(720px,calc(100vw - 48px));height:min(900px,calc(100vh - 120px))}'
  +'#tgx-cw .tgx-expand-btn{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;border-radius:8px;background:transparent;border:none;color:rgba(255,255,255,0.85);cursor:pointer;transition:background .15s ease,color .15s ease}'
  +'#tgx-cw .tgx-expand-btn:hover{background:rgba(255,255,255,0.12);color:#fff}'
  +'#tgx-cw .tgx-expand-btn svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}'
  +'@media(max-width:480px){#tgx-cw .tgx-expand-btn{display:none}#tgx-cw .tgx-panel.expanded{width:100vw;width:100dvw;height:100vh;height:100dvh}}'
  +'#tgx-cw .tgx-panel.open{opacity:1;visibility:visible;transform:translateY(0) scale(1)}'

  // Header — compact, gradient with inset highlight + corner glow
  +'#tgx-cw .tgx-hdr-full{padding:16px 18px;background:linear-gradient(135deg,'+C.brandColor+' 0%, '+C.brandColor+'D9 100%);position:relative;overflow:hidden;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.05)}'
  +'#tgx-cw .tgx-hdr-full::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);pointer-events:none;z-index:2}'
  +'#tgx-cw .tgx-hdr-full::after{content:"";position:absolute;top:-50px;right:-30px;width:160px;height:160px;border-radius:50%;background:radial-gradient(circle,'+C.accentColor+'33 0%,'+C.accentColor+'00 60%);pointer-events:none}'
  +'#tgx-cw .tgx-hdr-full .tgx-hdr-row{display:flex;align-items:center;gap:12px;position:relative;z-index:1}'

  // Compact chat header
  +'#tgx-cw .tgx-hdr-compact{padding:14px 18px;background:linear-gradient(135deg,'+C.brandColor+' 0%, '+C.brandColor+'D9 100%);display:flex;align-items:center;gap:12px;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,0.05);position:relative;overflow:hidden}'
  +'#tgx-cw .tgx-hdr-compact::before{content:"";position:absolute;top:0;left:0;right:0;height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,0.3),transparent);pointer-events:none}'

  // Avatar — solid coral, Fraunces serif initial
  +'#tgx-cw .tgx-avatar{display:flex;align-items:center;justify-content:center;flex-shrink:0;overflow:hidden;position:relative}'
  +'#tgx-cw .tgx-avatar img{width:100%;height:100%;object-fit:cover}'
  +'#tgx-cw .tgx-avatar-hdr{background:'+C.accentColor+';color:#fff;font-family:"Fraunces",Georgia,serif;font-weight:600;font-size:20px;letter-spacing:-0.02em;box-shadow:0 4px 12px '+C.accentColor+'40, inset 0 1px 0 rgba(255,255,255,0.2);width:40px;height:40px;border-radius:12px}'
  +'#tgx-cw .tgx-avatar-msg{background:'+C.brandColor+';color:#fff;font-weight:600;font-family:"Fraunces",Georgia,serif}'

  // Status + header text
  +'#tgx-cw .tgx-status{width:6px;height:6px;border-radius:50%;background:#34D399;box-shadow:0 0 8px rgba(52,211,153,0.6);flex-shrink:0}'
  +'#tgx-cw .tgx-hdr-name{color:#fff;font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:17px;letter-spacing:-0.015em;line-height:1.2}'
  +'#tgx-cw .tgx-hdr-compact .tgx-hdr-name{font-size:15px}'
  +'#tgx-cw .tgx-hdr-sub{color:rgba(255,255,255,0.65);font-size:11px;font-weight:400;display:flex;align-items:center;gap:5px;margin-top:2px}'
  +'#tgx-cw .tgx-hdr-btn{background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:7px 9px;cursor:pointer;display:flex;align-items:center;transition:background .18s,transform .12s}'
  +'#tgx-cw .tgx-hdr-btn:hover{background:rgba(255,255,255,0.18);transform:translateY(-1px)}'

  // Screens
  +'#tgx-cw .tgx-screen{flex:1;display:flex;flex-direction:column;overflow:hidden}'
  +'#tgx-cw .tgx-screen.hidden{display:none}'

  // Home body — cream, flex column with input bar at bottom
  +'#tgx-cw .tgx-home-body{flex:1;overflow-y:auto;padding:20px 18px 12px;background:#FAFAF6;display:flex;flex-direction:column;gap:14px}'
  +'#tgx-cw .tgx-home-body::-webkit-scrollbar{width:0}'

  // Greeting zone — the headline
  +'#tgx-cw .tgx-greeting-zone{margin-bottom:2px}'
  +'#tgx-cw .tgx-greeting-zone .tgx-big-hi{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:26px;letter-spacing:-0.02em;color:'+C.brandColor+';line-height:1.2}'
  +'#tgx-cw .tgx-greeting-zone .tgx-big-hi em{font-style:italic;color:'+C.accentColor+'}'
  +'#tgx-cw .tgx-greeting-zone .tgx-sub-hi{font-size:13px;color:#5C6470;line-height:1.5;margin-top:6px}'

  // Section labels
  +'#tgx-cw .tgx-section-label{font-size:10.5px;font-weight:600;color:#8A92A0;text-transform:uppercase;letter-spacing:0.09em;margin-bottom:8px;padding-left:2px}'

  // Capability cards — 2x2 grid
  +'#tgx-cw #tgxCapCards{display:grid;grid-template-columns:1fr 1fr;gap:8px}'
  +'#tgx-cw .tgx-cap-card{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:12px;border-radius:14px;background:#fff;border:1px solid rgba(15,26,61,0.06);cursor:pointer;margin-bottom:0;text-align:left;min-height:82px;transition:all .22s cubic-bezier(.22,1,.36,1)}'
  +'#tgx-cw .tgx-cap-card:hover{transform:translateY(-2px);border-color:rgba(15,26,61,0.14);box-shadow:0 12px 24px rgba(15,26,61,0.08),0 4px 8px rgba(15,26,61,0.04)}'
  +'#tgx-cw .tgx-cap-icon{width:34px;height:34px;border-radius:11px;background:linear-gradient(135deg,'+C.accentColor+'24,'+C.accentColor+'0F);color:'+C.accentColor+';display:flex;align-items:center;justify-content:center;flex-shrink:0;margin:0}'
  +'#tgx-cw .tgx-cap-icon svg{stroke:currentColor;width:17px;height:17px;stroke-width:2}'
  +'#tgx-cw .tgx-cap-text{width:100%;min-width:0}'
  +'#tgx-cw .tgx-cap-title{font-size:13px;font-weight:600;color:'+C.brandColor+';line-height:1.3;letter-spacing:-0.005em}'
  +'#tgx-cw .tgx-cap-desc{display:none}'
  +'#tgx-cw .tgx-cap-card > span:last-child{display:none}'

  // Starters — horizontal scroll, no clipping
  +'#tgx-cw #tgxStarters{display:flex;flex-wrap:nowrap;gap:6px;overflow-x:auto;scrollbar-width:none;margin:0 -18px;padding:4px 18px 6px;min-height:38px}'
  +'#tgx-cw #tgxStarters::-webkit-scrollbar{display:none}'
  +'#tgx-cw .tgx-starter{flex-shrink:0;display:inline-block;padding:8px 14px;border-radius:999px;background:#fff;border:1px solid rgba(15,26,61,0.10);color:'+C.brandColor+';font-size:12.5px;font-weight:500;cursor:pointer;line-height:1.3;white-space:nowrap;transition:all .18s ease;font-family:inherit}'
  +'#tgx-cw .tgx-starter:hover{border-color:'+C.accentColor+';color:'+C.accentColor+';transform:translateY(-1px)}'

  // Demoted footer
  +'#tgx-cw .tgx-demoted{margin-top:6px;padding-top:10px;border-top:1px solid rgba(15,26,61,0.06);font-size:11.5px;display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap}'
  +'#tgx-cw .tgx-demoted span{color:#8A92A0}'
  +'#tgx-cw .tgx-demoted button{background:none;border:none;cursor:pointer;font-size:11.5px;font-weight:500;color:'+C.accentColor+';padding:2px 0;font-family:inherit;transition:opacity .15s}'
  +'#tgx-cw .tgx-demoted button:hover{opacity:0.75;text-decoration:underline}'

  // Messages area
  +'#tgx-cw .tgx-msgs{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:14px;background:#FAFAF6;scrollbar-width:thin;scrollbar-color:'+T.line+' transparent}'
  +'#tgx-cw .tgx-more-below{position:absolute;left:50%;bottom:120px;transform:translateX(-50%) translateY(8px);background:'+C.brandColor+';color:#fff;border:none;border-radius:999px;padding:8px 14px;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;box-shadow:0 6px 18px rgba(15,26,61,0.25);display:none;align-items:center;gap:6px;opacity:0;transition:opacity .25s ease,transform .25s ease;z-index:10}'
  +'#tgx-cw .tgx-more-below.active{display:inline-flex;opacity:1;transform:translateX(-50%) translateY(0)}'
  +'#tgx-cw .tgx-more-below:hover{filter:brightness(1.08)}'
  /* location_card */
  +'#tgx-cw .luna-location-card{background:#fff;border:1px solid '+T.line+';border-radius:14px;overflow:hidden;box-shadow:0 4px 12px rgba(15,26,61,0.06);max-width:100%}'
  +'#tgx-cw .luna-location-head{display:flex;align-items:flex-start;gap:10px;padding:12px 14px 10px;background:linear-gradient(180deg,'+C.brandColor+'08 0%,transparent 100%);border-bottom:1px solid '+T.line+'}'
  +'#tgx-cw .luna-location-pin{width:26px;height:26px;border-radius:50%;background:'+C.brandColor+';color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0}'
  +'#tgx-cw .luna-location-head-text{flex:1;min-width:0}'
  +'#tgx-cw .luna-location-name{font-size:14px;font-weight:600;color:'+T.text+';line-height:1.25;letter-spacing:-0.01em}'
  +'#tgx-cw .luna-location-subtitle{font-size:12px;color:'+T.textMuted+';margin-top:2px;line-height:1.3}'
  +'#tgx-cw .luna-location-map{height:180px;width:100%;background:#EEF2F7;position:relative;display:flex;align-items:center;justify-content:center}'
  +'#tgx-cw .luna-location-map-loading,#tgx-cw .luna-location-map-error{font-size:12px;color:'+T.textMuted+';padding:8px}'
  +'#tgx-cw .luna-location-map .leaflet-container{font-family:inherit;font-size:11px}'
  +'#tgx-cw .luna-location-desc{padding:10px 14px 0;font-size:12.5px;line-height:1.5;color:'+T.text+'}'
  +'#tgx-cw .luna-location-ctas{display:flex;gap:8px;padding:12px 14px 14px}'
  +'#tgx-cw .luna-location-cta{flex:1;display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:9px 10px;border-radius:8px;font-size:12px;font-weight:600;font-family:inherit;text-decoration:none;border:1px solid transparent;transition:transform .12s,filter .15s;cursor:pointer;line-height:1}'
  +'#tgx-cw .luna-location-cta:active{transform:scale(0.98)}'
  +'#tgx-cw .luna-location-cta-primary{background:'+C.brandColor+';color:#fff}'
  +'#tgx-cw .luna-location-cta-primary:hover{filter:brightness(1.08)}'
  +'#tgx-cw .luna-location-cta-secondary{background:#fff;color:'+T.text+';border-color:'+T.line+'}'
  +'#tgx-cw .luna-location-cta-secondary:hover{background:'+T.line+'40}'
  /* weather_card */
  +'#tgx-cw .luna-weather-card{background:#fff;border:1px solid '+T.line+';border-radius:14px;overflow:hidden;box-shadow:0 4px 12px rgba(15,26,61,0.06);max-width:100%}'
  +'#tgx-cw .luna-weather-head{display:flex;align-items:flex-start;gap:10px;padding:12px 14px 10px;background:linear-gradient(180deg,'+C.brandColor+'08 0%,transparent 100%);border-bottom:1px solid '+T.line+'}'
  +'#tgx-cw .luna-weather-icon{width:26px;height:26px;border-radius:50%;background:'+C.brandColor+';color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0}'
  +'#tgx-cw .luna-weather-head-text{flex:1;min-width:0}'
  +'#tgx-cw .luna-weather-name{font-size:13.5px;font-weight:600;color:'+T.text+';line-height:1.25;letter-spacing:-0.01em}'
  +'#tgx-cw .luna-weather-subtitle{font-size:11.5px;color:'+T.textMuted+';margin-top:2px;line-height:1.3}'
  +'#tgx-cw .luna-weather-body{padding:14px}'
  +'#tgx-cw .luna-weather-chart{display:grid;grid-template-columns:repeat(12,1fr);gap:4px;height:144px;margin-bottom:10px}'
  +'#tgx-cw .luna-weather-col{display:flex;flex-direction:column;align-items:center;height:100%}'
  +'#tgx-cw .luna-weather-temp{font-size:10px;font-weight:600;color:'+T.text+';line-height:1.2;height:14px;display:flex;align-items:center;justify-content:center;white-space:nowrap;letter-spacing:-0.01em}'
  +'#tgx-cw .luna-weather-bar-wrap{flex:1;width:100%;display:flex;align-items:flex-end;justify-content:center;min-height:0;padding:2px 0}'
  +'#tgx-cw .luna-weather-bar{width:100%;max-width:20px;background:linear-gradient(180deg,'+C.brandColor+'40,'+C.brandColor+'10);border-radius:4px 4px 1px 1px;min-height:6px;transition:background .2s}'
  +'#tgx-cw .luna-weather-col-shoulder .luna-weather-bar{background:linear-gradient(180deg,'+C.accentColor+'55,'+C.accentColor+'18)}'
  +'#tgx-cw .luna-weather-col-best .luna-weather-bar{background:linear-gradient(180deg,'+C.accentColor+','+C.accentColor+'70)}'
  +'#tgx-cw .luna-weather-col-highlight .luna-weather-bar{outline:2px solid '+C.brandColor+';outline-offset:1px;box-shadow:0 0 0 4px '+C.brandColor+'15}'
  +'#tgx-cw .luna-weather-col-highlight .luna-weather-temp{color:'+C.brandColor+';font-weight:700}'
  +'#tgx-cw .luna-weather-month-label{font-size:9.5px;color:'+T.textMuted+';margin-top:6px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;line-height:1}'
  +'#tgx-cw .luna-weather-best-pill{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:'+C.accentColor+'15;color:'+C.accentColor+';border-radius:999px;font-size:11.5px;font-weight:600;margin-top:4px;margin-bottom:10px;letter-spacing:0.01em}'
  +'#tgx-cw .luna-weather-legend{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:10px;font-size:10.5px;color:'+T.textMuted+'}'
  +'#tgx-cw .luna-weather-legend-item{display:inline-flex;align-items:center;gap:5px;line-height:1}'
  +'#tgx-cw .luna-weather-legend-swatch{display:inline-block;width:10px;height:10px;border-radius:2px}'
  +'#tgx-cw .luna-weather-swatch-best{background:'+C.accentColor+'D0}'
  +'#tgx-cw .luna-weather-swatch-shoulder{background:'+C.accentColor+'40}'
  +'#tgx-cw .luna-weather-swatch-off{background:'+C.brandColor+'30}'
  +'#tgx-cw .luna-weather-summary{font-size:12.5px;line-height:1.55;color:'+T.text+';margin-bottom:10px}'
  +'#tgx-cw .luna-weather-callout{font-size:12px;line-height:1.5;padding:10px 12px;background:'+C.brandColor+'08;border-radius:8px;color:'+T.text+';border-left:3px solid '+C.brandColor+'}'
  /* Live weather extensions */
  +'#tgx-cw .luna-weather-hero{display:flex;align-items:stretch;padding:18px 18px 16px;color:#fff;position:relative;overflow:hidden}'
  +'#tgx-cw .luna-weather-hero::after{content:"";position:absolute;inset:0;background:radial-gradient(circle at 100% 0%,rgba(255,255,255,0.15) 0%,transparent 60%);pointer-events:none}'
  +'#tgx-cw .luna-weather-hero-left{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;z-index:1}'
  +'#tgx-cw .luna-weather-hero-loc{font-size:13px;font-weight:600;letter-spacing:0.01em;opacity:0.92}'
  +'#tgx-cw .luna-weather-hero-label{font-size:11.5px;opacity:0.85;margin-bottom:4px;letter-spacing:0.01em}'
  +'#tgx-cw .luna-weather-hero-temp{font-size:42px;font-weight:300;line-height:1;letter-spacing:-0.02em;font-family:"Fraunces",Georgia,serif;margin-top:2px;margin-bottom:10px}'
  +'#tgx-cw .luna-weather-deg{font-size:18px;font-weight:400;margin-left:1px;opacity:0.78;font-family:inherit}'
  +'#tgx-cw .luna-weather-stats{display:flex;gap:14px;flex-wrap:wrap}'
  +'#tgx-cw .luna-weather-stat{display:flex;flex-direction:column;gap:1px}'
  +'#tgx-cw .luna-weather-stat-label{font-size:9.5px;opacity:0.78;text-transform:uppercase;letter-spacing:0.06em;font-weight:600}'
  +'#tgx-cw .luna-weather-stat-value{font-size:12.5px;font-weight:600}'
  +'#tgx-cw .luna-weather-hero-right{display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.95);flex-shrink:0;margin-left:8px;z-index:1}'
  /* Forecast strip */
  +'#tgx-cw .luna-weather-forecast{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;padding:12px 8px;background:#fff;border-bottom:1px solid '+T.line+'}'
  +'#tgx-cw .luna-weather-day{display:flex;flex-direction:column;align-items:center;padding:6px 2px;border-radius:8px;transition:background .15s}'
  +'#tgx-cw .luna-weather-day:hover{background:'+T.line+'30}'
  +'#tgx-cw .luna-weather-day-name{font-size:10.5px;font-weight:600;color:'+T.textMuted+';margin-bottom:4px;letter-spacing:0.02em}'
  +'#tgx-cw .luna-weather-day-icon{color:'+C.brandColor+'CC;display:flex;align-items:center;justify-content:center;height:28px;margin-bottom:2px}'
  +'#tgx-cw .luna-weather-day-hi{font-size:12px;font-weight:600;color:'+T.text+';line-height:1.2}'
  +'#tgx-cw .luna-weather-day-lo{font-size:10.5px;color:'+T.textMuted+';line-height:1.2;margin-top:1px}'
  /* Section label inside body when hero is present */
  +'#tgx-cw .luna-weather-section-label{font-size:9.5px;font-weight:600;letter-spacing:0.08em;color:'+T.textMuted+';margin-bottom:10px}'
  +'#tgx-cw .tgx-msgs::-webkit-scrollbar{width:4px}'
  +'#tgx-cw .tgx-msgs::-webkit-scrollbar-thumb{background:'+T.line+';border-radius:2px}'

  // Message rows
  +'#tgx-cw .tgx-msg-row{display:flex;gap:10px;animation:tgxFadeIn .25s cubic-bezier(.22,1,.36,1)}'
  +'#tgx-cw .tgx-msg-row.user{flex-direction:row-reverse}'
  +'#tgx-cw .tgx-msg-row.user .tgx-msg-col{align-items:flex-end}'
  +'#tgx-cw .tgx-msg-col{display:flex;flex-direction:column;gap:4px;max-width:88%;min-width:0}'

  // Bubbles
  /* streaming cursor */
  +'#tgx-cw .tgx-msg.tgx-msg-streaming::after{content:"";display:inline-block;width:7px;height:14px;margin-left:2px;vertical-align:-2px;background:'+C.accentColor+';opacity:0.7;animation:tgxStreamCursor 1s steps(2) infinite;border-radius:1px}'
  +'@keyframes tgxStreamCursor{0%,50%{opacity:0.7}51%,100%{opacity:0}}'
  +'#tgx-cw .tgx-msg{padding:12px 15px;font-size:14px;line-height:1.55;word-wrap:break-word;border-radius:18px}'
  +'#tgx-cw .tgx-msg.bot{background:#fff;color:'+C.brandColor+';border:1px solid rgba(15,26,61,0.06);border-top-left-radius:6px}'
  +'#tgx-cw .tgx-msg.user{background:linear-gradient(135deg,'+C.brandColor+','+C.brandColor+'E0);color:#fff;border-top-right-radius:6px;box-shadow:0 4px 12px '+C.brandColor+'25}'
  +'#tgx-cw .tgx-msg.agent{background:#fff;color:'+C.brandColor+';border:1px solid rgba(34,197,94,0.3);border-left:3px solid #22c55e;border-top-left-radius:6px}'
  +'#tgx-cw .tgx-msg.system{align-self:center;background:transparent;color:#8A92A0;font-size:11.5px;font-style:italic;padding:6px 0;text-align:center;max-width:100%;border:none}'
  +'#tgx-cw .tgx-msg a{color:'+C.accentColor+';text-decoration:underline;text-underline-offset:2px}'
  +'#tgx-cw .tgx-msg-time{font-size:10.5px;color:#8A92A0;padding:0 4px}'
  +'#tgx-cw .tgx-msg strong{font-weight:600}'

  // Booking widget bubble
  +'#tgx-cw .tgx-msg-row-widget{display:block;width:100%;margin:6px 0}'
  +'#tgx-cw .tgx-bubble-widget{max-width:100%;width:100%;padding:0;background:transparent;border:none;box-shadow:none}'
  +'#tgx-cw .tgx-booking-mount{width:100%;border-radius:14px;overflow:hidden;border:1px solid '+T.line+';background:#fff;box-shadow:0 4px 12px rgba(15,26,61,0.06);animation:tgxBookingFadeIn .35s ease-out both}'
  +'#tgx-cw .tgx-booking-loading{padding:24px 18px;text-align:center;color:'+T.textMuted+';font-size:13px;background:#fff;border-radius:14px;font-style:italic;border:1px solid '+T.line+';display:flex;align-items:center;justify-content:center;gap:10px;min-height:80px}'
  +'#tgx-cw .tgx-booking-loading::before{content:"";width:14px;height:14px;border-radius:50%;border:2px solid '+T.line+';border-top-color:'+C.brandColor+';animation:tgxBookingSpin .8s linear infinite}'
  +'@keyframes tgxBookingFadeIn{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}'
  +'@keyframes tgxBookingSpin{to{transform:rotate(360deg)}}'

  // Date divider
  +'#tgx-cw .tgx-date{text-align:center;padding:8px 0 4px;font-size:10.5px;color:#8A92A0;font-weight:500;letter-spacing:0.06em;text-transform:uppercase}'

  // Typing
  +'#tgx-cw .tgx-typing-row{display:none;gap:10px;align-items:flex-end;margin-top:4px;padding:0 16px}'
  +'#tgx-cw .tgx-typing-row.active{display:flex;animation:tgxFadeIn .2s ease}'
  +'#tgx-cw .tgx-typing{padding:12px 16px;border-radius:18px 18px 18px 6px;background:#fff;border:1px solid rgba(15,26,61,0.06);display:flex;gap:4px;align-items:center}'
  +'#tgx-cw .tgx-typing span{display:inline-block;width:6px;height:6px;border-radius:50%;background:#8A92A0;animation:tgxDot 1.4s infinite}'
  +'#tgx-cw .tgx-typing span:nth-child(2){animation-delay:.18s}'
  +'#tgx-cw .tgx-typing span:nth-child(3){animation-delay:.36s}'
  +'#tgx-cw .tgx-typing-status{position:relative;font-size:13px;font-weight:500;color:'+C.accentColor+';align-self:center;line-height:1.4;transition:opacity .25s ease;opacity:0;max-width:320px;padding-left:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  +'#tgx-cw .tgx-typing-status::before{content:"";position:absolute;left:0;top:50%;transform:translateY(-50%);width:8px;height:8px;border-radius:50%;background:'+C.accentColor+';box-shadow:0 0 0 0 '+C.accentColor+'80;animation:tgxStatusPulse 1.6s cubic-bezier(0.4,0,0.6,1) infinite}'
  +'#tgx-cw .tgx-typing-status.visible{opacity:0.95}'
  +'@keyframes tgxStatusPulse{0%,100%{box-shadow:0 0 0 0 '+C.accentColor+'80}50%{box-shadow:0 0 0 6px '+C.accentColor+'00}}'
  /* PHASE_3_6_HIGHLIGHTS — storyboard card styles */
  +'#tgx-cw .tgx-hl-card{margin:14px 0 8px 38px;max-width:380px;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 6px 20px -6px rgba(15,26,61,0.15);opacity:0;transform:translateY(12px) scale(0.98);transition:opacity 0.5s cubic-bezier(0.22,0.61,0.36,1),transform 0.5s cubic-bezier(0.22,0.61,0.36,1)}'
  +'#tgx-cw .tgx-hl-card.tgx-hl-in{opacity:1;transform:translateY(0) scale(1)}'
  +'#tgx-cw .tgx-hl-hero{height:120px;position:relative;overflow:hidden;background:linear-gradient(135deg,#2D5F8C 0%,#C68B5B 50%,#4FD1C5 100%)}'
  +'#tgx-cw .tgx-hl-hero img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}'
  +'#tgx-cw .tgx-hl-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.55) 0%,rgba(0,0,0,0.05) 60%,transparent 100%);pointer-events:none}'
  +'#tgx-cw .tgx-hl-hero-text{position:absolute;bottom:12px;left:16px;right:16px;color:#fff;z-index:1}'
  +'#tgx-cw .tgx-hl-eyebrow{font-size:9px;text-transform:uppercase;letter-spacing:0.16em;opacity:0.92;font-weight:600;margin-bottom:2px}'
  +'#tgx-cw .tgx-hl-title{font-family:Georgia,"Times New Roman",serif;font-size:22px;line-height:1.1;font-weight:500;letter-spacing:-0.01em}'
  +'#tgx-cw .tgx-hl-items{padding:4px 0}'
  +'#tgx-cw .tgx-hl-item{display:flex;gap:14px;align-items:flex-start;padding:13px 18px;border-bottom:1px solid rgba(15,26,61,0.06);cursor:pointer;transition:background 0.18s ease;position:relative;opacity:0;transform:translateX(-8px);transition:opacity 0.4s cubic-bezier(0.22,0.61,0.36,1),transform 0.4s cubic-bezier(0.22,0.61,0.36,1),background 0.18s ease}'
  +'#tgx-cw .tgx-hl-item.tgx-hl-in{opacity:1;transform:translateX(0)}'
  +'#tgx-cw .tgx-hl-item:last-child{border-bottom:none}'
  +'#tgx-cw .tgx-hl-item:hover{background:'+C.accentColor+'08}'
  +'#tgx-cw .tgx-hl-icon{flex-shrink:0;width:34px;height:34px;border-radius:8px;background:'+C.accentColor+'15;display:grid;place-items:center;font-size:17px;margin-top:1px}'
  +'#tgx-cw .tgx-hl-item-content{flex:1;min-width:0}'
  +'#tgx-cw .tgx-hl-item-eyebrow{font-size:9px;text-transform:uppercase;letter-spacing:0.12em;color:'+C.accentColor+';font-weight:700;margin-bottom:2px}'
  +'#tgx-cw .tgx-hl-item-h{font-size:13px;font-weight:600;color:#0F1A3D;margin-bottom:3px;line-height:1.25}'
  +'#tgx-cw .tgx-hl-item-d{font-size:12px;color:#5B6478;line-height:1.45}'
  +'#tgx-cw .tgx-hl-arrow{flex-shrink:0;color:#9BA3B5;font-size:13px;opacity:0;transform:translateX(-3px);transition:all 0.18s ease;margin-top:8px}'
  +'#tgx-cw .tgx-hl-item:hover .tgx-hl-arrow{opacity:1;transform:translateX(0);color:'+C.accentColor+'}'
  +'#tgx-cw .tgx-hl-footer{padding:11px 16px 13px;display:flex;gap:6px;flex-wrap:wrap;background:#FAFAF6}'
  +'#tgx-cw .tgx-hl-footer .tgx-hl-pill{background:#fff;border:1px solid rgba(15,26,61,0.1);color:#0F1A3D;padding:6px 11px;border-radius:100px;font-size:11px;font-weight:500;cursor:pointer;transition:all 0.18s ease}'
  +'#tgx-cw .tgx-hl-footer .tgx-hl-pill:hover{border-color:'+C.accentColor+';color:'+C.accentColor+';transform:translateY(-1px)}'
  +'#tgx-cw .tgx-hl-credit{font-size:9px;color:rgba(255,255,255,0.7);position:absolute;bottom:4px;right:8px;z-index:1;letter-spacing:0.02em}'

  // Pills (quick replies)
  +'#tgx-cw .tgx-pills{display:flex;flex-wrap:wrap;gap:8px;padding:4px 16px 8px}'
  +'#tgx-cw .tgx-pill{background:#fff;border:1px solid rgba(15,26,61,0.10);color:'+C.brandColor+';font-size:12.5px;font-weight:500;padding:8px 13px;border-radius:999px;cursor:pointer;transition:all .2s cubic-bezier(.22,1,.36,1);line-height:1.3;text-align:left;font-family:inherit}'
  +'#tgx-cw .tgx-pill:hover{border-color:'+C.accentColor+';color:'+C.accentColor+';transform:translateY(-1px)}'

  // Input bar (used by BOTH home and chat screens)
  +'#tgx-cw .tgx-input-wrap{padding:12px 16px 14px;border-top:1px solid rgba(15,26,61,0.06);background:#fff;flex-shrink:0;display:flex;gap:8px;align-items:flex-end}'
  +'#tgx-cw .tgx-input-inner{flex:1;display:flex;align-items:center;gap:8px;background:#FAFAF6;border:1px solid rgba(15,26,61,0.10);border-radius:999px;padding:4px 4px 4px 16px;transition:all .2s ease}'
  +'#tgx-cw .tgx-input-inner:focus-within{background:#fff;border-color:'+C.accentColor+';box-shadow:0 0 0 4px '+C.accentColor+'1A}'
  +'#tgx-cw .tgx-input{flex:1;background:none;border:none;padding:9px 0;font-size:14px;color:'+C.brandColor+';outline:none;line-height:1.4;font-family:inherit}'
  +'#tgx-cw .tgx-input::placeholder{color:#8A92A0;opacity:1}'
  +'#tgx-cw .tgx-send{width:38px;height:38px;border-radius:50%;background:'+C.accentColor+';border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:transform .15s,box-shadow .2s;box-shadow:0 4px 10px '+C.accentColor+'40,inset 0 1px 0 rgba(255,255,255,0.18)}'
  +'#tgx-cw .tgx-send:hover{transform:scale(1.06)}'
  +'#tgx-cw .tgx-send:active{transform:scale(0.94)}'
  +'#tgx-cw .tgx-send svg{width:16px;height:16px;stroke:#fff;fill:none}'
  /* Voice input — mic button */
  +'#tgx-cw .tgx-mic{width:34px;height:34px;border-radius:50%;background:'+C.brandColor+'0A;border:none;cursor:pointer;display:none;align-items:center;justify-content:center;flex-shrink:0;color:'+C.brandColor+'B0;transition:color .15s,background .15s,transform .15s;padding:0;font-family:inherit;position:relative}'
  +'#tgx-cw .tgx-mic.tgx-mic-available{display:inline-flex}'
  +'#tgx-cw .tgx-mic:hover{color:'+C.brandColor+';background:'+C.brandColor+'1A}'
  +'#tgx-cw .tgx-mic:active{transform:scale(0.94)}'
  +'#tgx-cw .tgx-mic svg{width:17px;height:17px;stroke:currentColor;fill:none;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}'
  +'#tgx-cw .tgx-mic.tgx-mic-listening{color:#fff;background:'+C.accentColor+'}'
  +'#tgx-cw .tgx-mic.tgx-mic-listening::before{content:"";position:absolute;inset:-3px;border-radius:50%;background:'+C.accentColor+';opacity:0.45;animation:tgxMicPulse 1.4s ease-out infinite;z-index:-1}'
  +'#tgx-cw .tgx-mic.tgx-mic-listening:hover{color:#fff;background:'+C.accentColor+';filter:brightness(1.08)}'
  +'@keyframes tgxMicPulse{0%{transform:scale(1);opacity:0.45}70%{transform:scale(1.7);opacity:0}100%{transform:scale(1.7);opacity:0}}'
  +'#tgx-cw .tgx-input.tgx-input-interim{color:'+C.brandColor+'80;font-style:italic}'

  // Escalation buttons
  +'#tgx-cw .tgx-esc-bar{display:none;gap:8px;padding:10px 16px 12px;border-top:1px solid rgba(15,26,61,0.06);flex-shrink:0;background:#fff}'
  +'#tgx-cw .tgx-esc-bar.active{display:flex}'
  +'#tgx-cw .tgx-esc-btn{flex:1;padding:10px 0;border-radius:10px;font-size:12.5px;font-weight:600;cursor:pointer;text-align:center;transition:transform .15s,opacity .15s;border:none;font-family:inherit}'
  +'#tgx-cw .tgx-esc-btn:hover{transform:translateY(-1px);opacity:0.92}'
  +'#tgx-cw .tgx-esc-btn.human{background:'+C.accentColor+';color:#fff;box-shadow:0 4px 10px '+C.accentColor+'30}'
  +'#tgx-cw .tgx-esc-btn.leave{background:#FAFAF6;color:'+C.brandColor+';border:1px solid rgba(15,26,61,0.10)}'

  // Email bar
  +'#tgx-cw .tgx-email-bar{padding:6px 16px 0;flex-shrink:0;text-align:right;display:none}'
  +'#tgx-cw .tgx-email-link{color:#5C6470;font-size:11.5px;cursor:pointer;transition:color .15s;border:none;background:none;padding:0;font-family:inherit}'
  +'#tgx-cw .tgx-email-link:hover{color:'+C.accentColor+'}'
  +'#tgx-cw .tgx-email-inline{display:flex;gap:6px;align-items:center;padding:6px 16px 0;flex-shrink:0}'
  +'#tgx-cw .tgx-email-inline input{flex:1;background:#FAFAF6;border:1px solid rgba(15,26,61,0.10);border-radius:999px;padding:7px 14px;color:'+C.brandColor+';font-size:12.5px;outline:none;font-family:inherit}'
  +'#tgx-cw .tgx-email-inline input::placeholder{color:#8A92A0}'
  +'#tgx-cw .tgx-email-inline button{background:'+C.accentColor+';color:#fff;border:none;border-radius:999px;padding:7px 14px;font-size:11.5px;font-weight:600;cursor:pointer;white-space:nowrap;font-family:inherit}'
  +'#tgx-cw .tgx-email-inline .tgx-email-cancel{background:none;color:#5C6470;padding:6px 6px;font-size:14px;font-weight:400;line-height:1}'
  +'#tgx-cw .tgx-email-status{padding:8px 14px;border-radius:999px;font-size:12px;line-height:1.4;display:inline-flex;align-items:center;gap:8px;max-width:100%;flex-wrap:wrap}'
  +'#tgx-cw .tgx-email-status-loading{background:#F5F3EC;color:#5C6470}'
  +'#tgx-cw .tgx-email-status-success{background:#ECFDF5;color:#065F46;border:1px solid #A7F3D0}'
  +'#tgx-cw .tgx-email-status-error{background:#FEF2F2;color:#991B1B;border:1px solid #FECACA;padding:10px 14px;border-radius:12px;flex-direction:column;align-items:flex-start;gap:8px}'
  +'#tgx-cw .tgx-email-status-text{font-weight:500}'
  +'#tgx-cw .tgx-email-status-actions{display:flex;gap:6px;flex-wrap:wrap}'
  +'#tgx-cw .tgx-email-mini-btn{background:#fff;color:#0F1A3D;border:1px solid rgba(15,26,61,0.18);border-radius:999px;padding:5px 11px;font-size:11.5px;font-weight:500;cursor:pointer;font-family:inherit;transition:background .15s}'
  +'#tgx-cw .tgx-email-mini-btn:hover{background:#F5F3EC}'
  +'#tgx-cw .tgx-email-mini-btn-x{color:#8A92A0;border-color:rgba(15,26,61,0.10)}'
  /* Clear-conversation confirm */
  +'#tgx-cw .tgx-clear-confirm{padding:10px 14px;background:#FEF3C7;border:1px solid #FCD34D;border-radius:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}'
  +'#tgx-cw .tgx-clear-confirm-text{font-size:12.5px;color:#78350F;font-weight:500;flex:1;min-width:140px}'
  +'#tgx-cw .tgx-clear-confirm-actions{display:flex;gap:6px;flex-wrap:wrap}'
  +'#tgx-cw .tgx-clear-confirm-btn{font-size:11.5px;font-weight:500;padding:6px 12px;border-radius:999px;cursor:pointer;border:1px solid transparent;font-family:inherit;line-height:1.2}'
  +'#tgx-cw .tgx-clear-confirm-yes{background:#DC2626;color:#fff;border-color:#DC2626}'
  +'#tgx-cw .tgx-clear-confirm-yes:hover{filter:brightness(1.08)}'
  +'#tgx-cw .tgx-clear-confirm-no{background:#fff;color:#78350F;border-color:#FCD34D}'
  +'#tgx-cw .tgx-clear-confirm-no:hover{background:#FEF3C7}'

  // Overlays
  +'#tgx-cw .tgx-overlay{position:absolute;inset:0;background:rgba(250,250,246,0.92);backdrop-filter:blur(16px) saturate(180%);-webkit-backdrop-filter:blur(16px) saturate(180%);display:flex;flex-direction:column;align-items:center;justify-content:center;padding:36px 28px;z-index:10;border-radius:'+C.radius+'}'
  +'#tgx-cw .tgx-overlay h3{color:'+C.brandColor+';font-family:"Fraunces",Georgia,serif;font-size:22px;font-weight:500;letter-spacing:-0.015em;margin-bottom:8px;text-align:center;line-height:1.2}'
  +'#tgx-cw .tgx-overlay p{color:#5C6470;font-size:13.5px;margin-bottom:22px;text-align:center;line-height:1.5}'
  +'#tgx-cw .tgx-overlay input[type="text"],#tgx-cw .tgx-overlay input[type="email"],#tgx-cw .tgx-overlay textarea{width:100%;background:#fff;border:1px solid rgba(15,26,61,0.10);border-radius:12px;padding:14px 16px;color:'+C.brandColor+';font-size:14px;outline:none;margin-bottom:12px;transition:border-color .2s,box-shadow .2s;-webkit-appearance:none;appearance:none;font-family:inherit}'
  +'#tgx-cw .tgx-overlay input:focus,#tgx-cw .tgx-overlay textarea:focus{border-color:'+C.accentColor+';box-shadow:0 0 0 3px '+C.accentColor+'25}'
  +'#tgx-cw .tgx-overlay input::placeholder,#tgx-cw .tgx-overlay textarea::placeholder{color:#8A92A0}'
  +'#tgx-cw .tgx-overlay textarea{height:88px;resize:none}'
  +'#tgx-cw .tgx-overlay .tgx-obtn{width:100%;padding:14px;border-radius:12px;background:'+C.accentColor+';color:#fff;font-size:14px;font-weight:600;border:none;cursor:pointer;margin-bottom:10px;transition:transform .15s,box-shadow .2s;box-shadow:0 4px 12px '+C.accentColor+'40;font-family:inherit;letter-spacing:0.01em}'
  +'#tgx-cw .tgx-overlay .tgx-obtn:hover{transform:translateY(-1px);box-shadow:0 6px 16px '+C.accentColor+'55}'
  +'#tgx-cw .tgx-overlay .tgx-obtn:active{transform:scale(0.98)}'
  +'#tgx-cw .tgx-overlay .tgx-olink{background:none;border:none;color:#5C6470;font-size:12.5px;cursor:pointer;text-decoration:underline;text-underline-offset:2px;font-family:inherit;padding:6px}'
  +'#tgx-cw .tgx-overlay .tgx-olink:hover{color:'+C.brandColor+'}'

  // Checkbox
  +'#tgx-cw .tgx-check{display:flex;align-items:center;gap:10px;margin-bottom:18px;cursor:pointer;text-align:left;width:100%;-webkit-user-select:none;user-select:none}'
  +'#tgx-cw .tgx-check input[type="checkbox"]{position:absolute;opacity:0;width:0;height:0;pointer-events:none}'
  +'#tgx-cw .tgx-check .tgx-cb{width:22px;height:22px;border-radius:6px;border:1.5px solid rgba(15,26,61,0.14);background:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s,border-color .15s}'
  +'#tgx-cw .tgx-check .tgx-cb svg{width:14px;height:14px;opacity:0;transform:scale(.5);transition:opacity .15s,transform .15s}'
  +'#tgx-cw .tgx-check input:checked+.tgx-cb{background:'+C.accentColor+';border-color:'+C.accentColor+'}'
  +'#tgx-cw .tgx-check input:checked+.tgx-cb svg{opacity:1;transform:scale(1)}'
  +'#tgx-cw .tgx-check .tgx-cb-label{color:#5C6470;font-size:13px;line-height:1.4}'

  // Honeypot, privacy, stars, footer
  +'#tgx-cw .tgx-hp{position:absolute;left:-9999px;top:-9999px;opacity:0;height:0;width:0;z-index:-1;pointer-events:none}'
  +'#tgx-cw .tgx-privacy{display:block;margin-top:14px;color:#8A92A0;font-size:11.5px;text-decoration:none;transition:color .15s}'
  +'#tgx-cw .tgx-privacy:hover{color:'+C.brandColor+';text-decoration:underline}'
  +'#tgx-cw .tgx-stars{display:flex;gap:10px;justify-content:center;margin-bottom:18px}'
  +'#tgx-cw .tgx-star{font-size:38px;color:#8A92A0;cursor:pointer;transition:color .15s,transform .15s;line-height:1}'
  +'#tgx-cw .tgx-footer{display:none}'

  // Block renderer styles
  +'#tgx-cw .luna-dest-card{background:#fff;border:1px solid rgba(15,26,61,0.06);border-radius:18px;overflow:hidden;transition:transform .25s cubic-bezier(.22,1,.36,1),border-color .18s,box-shadow .25s}'
  +'#tgx-cw .luna-dest-card:hover{transform:translateY(-2px);border-color:rgba(15,26,61,0.14);box-shadow:0 14px 28px rgba(15,26,61,0.08)}'
  +'#tgx-cw .luna-dest-img{width:100%;height:160px;background:#FAFAF6;overflow:hidden}'
  +'#tgx-cw .luna-dest-img img{width:100%;height:100%;object-fit:cover;display:block}'
  +'#tgx-cw .luna-dest-body{padding:14px 16px 16px}'
  +'#tgx-cw .luna-dest-row1{display:flex;align-items:baseline;justify-content:space-between;gap:8px}'
  +'#tgx-cw .luna-dest-name{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:19px;letter-spacing:-0.01em;color:'+C.brandColor+'}'
  +'#tgx-cw .luna-dest-temp{font-size:12px;color:#5C6470;white-space:nowrap}'
  +'#tgx-cw .luna-dest-vibe{font-size:13.5px;color:#5C6470;line-height:1.45;margin-top:4px}'
  +'#tgx-cw .luna-dest-tags{display:flex;flex-wrap:wrap;gap:6px;margin-top:12px}'
  +'#tgx-cw .luna-tag{font-size:11px;padding:4px 11px;border-radius:999px;background:#fff;border:1px solid rgba(15,26,61,0.18);color:'+C.brandColor+';font-weight:500}'
  +'#tgx-cw .luna-dest-actions{display:flex;gap:8px;margin-top:14px}'
  +'#tgx-cw .luna-btn{flex:1;height:36px;border-radius:10px;font-size:12.5px;font-weight:500;border:1px solid rgba(15,26,61,0.10);background:#fff;color:'+C.brandColor+';cursor:pointer;font-family:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:transform .15s,background .18s;text-decoration:none;padding:0 12px}'
  +'#tgx-cw .luna-btn:hover{background:#FAFAF6;transform:translateY(-1px)}'
  +'#tgx-cw .luna-btn-primary{background:'+C.accentColor+';border-color:'+C.accentColor+';color:#fff;box-shadow:0 2px 8px '+C.accentColor+'30}'
  +'#tgx-cw .luna-btn-primary:hover{opacity:0.92;box-shadow:0 4px 12px '+C.accentColor+'45}'
  +'#tgx-cw .luna-btn svg{width:14px;height:14px}'

  // Offer card
  +'#tgx-cw .luna-offer-card{background:#fff;border:1px solid rgba(15,26,61,0.06);border-radius:18px;overflow:hidden}'
  +'#tgx-cw .luna-offer-img{width:100%;height:170px;background:#FAFAF6;overflow:hidden}'
  +'#tgx-cw .luna-offer-img img{width:100%;height:100%;object-fit:cover;display:block}'
  +'#tgx-cw .luna-offer-body{padding:14px 16px}'
  +'#tgx-cw .luna-offer-hotel-row{display:flex;align-items:center;justify-content:space-between;gap:10px}'
  +'#tgx-cw .luna-offer-hotel{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:17px;letter-spacing:-0.01em;color:'+C.brandColor+';flex:1;min-width:0}'
  +'#tgx-cw .luna-offer-stars{display:inline-flex;gap:1px;color:#FBBF24}'
  +'#tgx-cw .luna-offer-stars svg{width:12px;height:12px}'
  +'#tgx-cw .luna-offer-dest{font-size:12.5px;color:#5C6470;margin-top:2px}'
  +'#tgx-cw .luna-offer-meta{font-size:12px;color:#5C6470;margin-top:8px;line-height:1.45}'
  +'#tgx-cw .luna-offer-price-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px}'
  +'#tgx-cw .luna-offer-price{display:flex;align-items:baseline;gap:4px}'
  +'#tgx-cw .luna-offer-price-label{font-size:11px;color:#8A92A0;text-transform:uppercase;letter-spacing:0.04em}'
  +'#tgx-cw .luna-offer-price-value{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:22px;letter-spacing:-0.01em;color:'+C.brandColor+'}'
  +'#tgx-cw .luna-offer-price-pp{font-size:11px;color:#8A92A0;margin-left:2px}'
  +'#tgx-cw .luna-offer-operator{display:flex;align-items:center;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid rgba(15,26,61,0.06);font-size:11.5px;color:#8A92A0}'
  +'#tgx-cw .luna-offer-operator-logo{height:16px;width:auto;opacity:0.85}'

  // FAQ card
  +'#tgx-cw .luna-faq-card{background:#fff;border:1px solid rgba(15,26,61,0.06);border-radius:16px;overflow:hidden}'
  +'#tgx-cw .luna-faq-head{padding:14px 16px 8px;display:flex;flex-direction:column;gap:6px}'
  +'#tgx-cw .luna-faq-pill{font-size:10px;font-weight:600;padding:3px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:0.06em;align-self:flex-start}'
  +'#tgx-cw .luna-faq-pill[data-category="policy"],#tgx-cw .luna-faq-pill[data-category="faq"]{background:rgba(168,85,247,0.15);color:#a855f7;border:1px solid rgba(168,85,247,0.25)}'
  +'#tgx-cw .luna-faq-pill[data-category="visa"]{background:rgba(59,130,246,0.15);color:#3b82f6;border:1px solid rgba(59,130,246,0.25)}'
  +'#tgx-cw .luna-faq-pill[data-category="insurance"],#tgx-cw .luna-faq-pill[data-category="baggage"]{background:rgba(245,158,11,0.15);color:#f59e0b;border:1px solid rgba(245,158,11,0.25)}'
  +'#tgx-cw .luna-faq-pill[data-category="advice"],#tgx-cw .luna-faq-pill[data-category="health"]{background:rgba(34,197,94,0.15);color:#22c55e;border:1px solid rgba(34,197,94,0.25)}'
  +'#tgx-cw .luna-faq-title{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:16px;color:'+C.brandColor+';letter-spacing:-0.005em}'
  +'#tgx-cw .luna-faq-body{padding:4px 16px 14px;font-size:13.5px;line-height:1.55;color:'+C.brandColor+'}'
  +'#tgx-cw .luna-faq-body strong{color:'+C.brandColor+';font-weight:600}'
  +'#tgx-cw .luna-faq-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 14px;border-top:1px solid rgba(15,26,61,0.06);background:#FAFAF6;font-size:11.5px;color:#5C6470}'
  +'#tgx-cw .luna-faq-source{flex:1;min-width:0}'
  +'#tgx-cw .luna-faq-link{color:'+C.accentColor+';text-decoration:none;font-weight:500;display:inline-flex;align-items:center;gap:4px;flex-shrink:0}'
  +'#tgx-cw .luna-faq-link svg{width:11px;height:11px}'

  // Booking lookup card
  +'#tgx-cw .luna-booking-card{background:#fff;border:1px solid rgba(15,26,61,0.06);border-radius:16px;overflow:hidden}'
  +'#tgx-cw .luna-booking-strip{background:linear-gradient(135deg,'+C.brandColor+','+C.brandColor+'D6);padding:12px 16px;display:flex;align-items:center;justify-content:space-between;color:#fff}'
  +'#tgx-cw .luna-booking-ref{font-size:11px;opacity:0.88;letter-spacing:0.04em}'
  +'#tgx-cw .luna-booking-status{font-size:10.5px;font-weight:600;padding:3px 9px;border-radius:999px;text-transform:uppercase;letter-spacing:0.04em}'
  +'#tgx-cw .luna-booking-status[data-status="confirmed"]{background:rgba(34,197,94,0.25);border:1px solid rgba(34,197,94,0.5);color:#5dd58c}'
  +'#tgx-cw .luna-booking-status[data-status="pending"]{background:rgba(245,158,11,0.25);border:1px solid rgba(245,158,11,0.5);color:#fbbf24}'
  +'#tgx-cw .luna-booking-status[data-status="cancelled"]{background:rgba(239,68,68,0.25);border:1px solid rgba(239,68,68,0.5);color:#f87171}'
  +'#tgx-cw .luna-booking-body{padding:14px 16px}'
  +'#tgx-cw .luna-booking-dest{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:19px;letter-spacing:-0.01em;color:'+C.brandColor+';margin-bottom:4px}'
  +'#tgx-cw .luna-booking-summary{font-size:12.5px;color:#5C6470;margin-bottom:12px}'
  +'#tgx-cw .luna-booking-rows{display:flex;flex-direction:column;gap:6px}'
  +'#tgx-cw .luna-booking-row{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;padding:4px 0}'
  +'#tgx-cw .luna-booking-label{color:#5C6470;flex-shrink:0}'
  +'#tgx-cw .luna-booking-value{color:'+C.brandColor+';font-weight:500;text-align:right}'
  +'#tgx-cw .luna-booking-value-accent{color:'+C.accentColor+'}'
  +'#tgx-cw .luna-booking-actions{display:flex;gap:8px;padding:12px 14px;border-top:1px solid rgba(15,26,61,0.06);background:#FAFAF6}'

  // Handoff card
  +'#tgx-cw .luna-handoff-card{background:linear-gradient(135deg,rgba(34,197,94,0.10),rgba(34,197,94,0.04));border:1px solid rgba(34,197,94,0.25);border-radius:16px;padding:16px;display:flex;align-items:center;gap:14px}'
  +'#tgx-cw .luna-handoff-avatar{width:44px;height:44px;border-radius:50%;overflow:hidden;flex-shrink:0;border:2px solid rgba(34,197,94,0.4);background:#fff}'
  +'#tgx-cw .luna-handoff-avatar img{width:100%;height:100%;object-fit:cover;display:block}'
  +'#tgx-cw .luna-handoff-text{flex:1;min-width:0}'
  +'#tgx-cw .luna-handoff-name{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:15px;color:'+C.brandColor+';letter-spacing:-0.005em;margin-bottom:2px}'
  +'#tgx-cw .luna-handoff-time{font-size:12px;color:#5C6470}'
  +'#tgx-cw .luna-handoff-btn{height:36px;padding:0 14px;border-radius:10px;background:#22c55e;color:#fff;font-weight:500;border:none;font-size:12.5px;cursor:pointer;font-family:inherit;flex-shrink:0;box-shadow:0 4px 10px rgba(34,197,94,0.3);transition:transform .15s,background .18s}'
  +'#tgx-cw .luna-handoff-btn:hover{background:#1ba84d;transform:translateY(-1px)}'

  // Emergency card
  +'#tgx-cw .luna-emergency-card{background:linear-gradient(135deg,rgba(239,68,68,0.10),rgba(239,68,68,0.04));border:1px solid rgba(239,68,68,0.3);border-radius:16px;padding:18px 18px 16px;display:flex;flex-direction:column;gap:10px}'
  +'#tgx-cw .luna-emergency-head{display:flex;align-items:center;gap:8px;color:#ef4444;font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:0.06em}'
  +'#tgx-cw .luna-emergency-head svg{width:14px;height:14px}'
  +'#tgx-cw .luna-emergency-reassurance{font-size:13px;color:'+C.brandColor+';line-height:1.4}'
  +'#tgx-cw .luna-emergency-phone{font-family:"Fraunces",Georgia,serif;font-weight:500;font-size:26px;letter-spacing:-0.01em;color:'+C.brandColor+';text-decoration:none;padding:6px 0 0}'
  +'#tgx-cw .luna-emergency-phone:hover{text-decoration:underline;text-decoration-color:#ef4444;text-underline-offset:4px}'
  +'#tgx-cw .luna-emergency-btn{height:40px;border-radius:10px;background:#ef4444;color:#fff;font-weight:600;border:none;font-size:13px;font-family:inherit;cursor:pointer;box-shadow:0 4px 12px rgba(239,68,68,0.35);transition:transform .15s,background .18s;margin-top:4px}'
  +'#tgx-cw .luna-emergency-btn:hover{background:#dc2626;transform:translateY(-1px)}'
  +'#tgx-cw .luna-emergency-fallback{font-size:13px;color:#5C6470;font-style:italic}'

  // Fallback
  +'#tgx-cw .luna-fallback-card{background:#fff;border:1px dashed rgba(15,26,61,0.14);border-radius:12px;padding:12px 14px;color:#5C6470;font-size:12.5px;font-style:italic}'

  // Animations
  +'@keyframes tgxDot{0%,60%,100%{opacity:.3;transform:scale(.8)}30%{opacity:1;transform:scale(1)}}'
  +'@keyframes tgxFadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}'

  +'@media (prefers-reduced-motion: reduce){'
  +'#tgx-cw *,#tgx-cw *::before,#tgx-cw *::after{animation-duration:0.01ms !important;animation-iteration-count:1 !important;transition-duration:0.01ms !important}'
  +'}';

  // Mobile
  /* Mobile responsive — comprehensive. Uses 100dvh (dynamic viewport height)
     to correctly track Android Chrome and iOS Safari URL-bar collapse, with
     100vh as fallback for older browsers. All selectors verified to match
     real elements in the DOM (avoid the previous no-op bugs). */
  var mobileCSS = '@media(max-width:480px){'
    /* Panel — full screen, dvh-aware so the input bar stays visible when
       the mobile URL bar is showing. */
    +'#tgx-cw .tgx-panel{right:0;bottom:0;left:0;top:0;width:100vw;width:100dvw;height:100vh;height:100dvh;max-height:100vh;max-height:100dvh;border-radius:0}'
    +'#tgx-cw .tgx-fab.open{display:none}'
    /* Home body — reduce padding so greeting + cards + starters + demoted +
       input all fit comfortably. */
    +'#tgx-cw .tgx-home-body{padding:14px 14px 8px;gap:10px}'
    /* Greeting — slightly smaller font so it doesn\'t eat half the screen */
    +'#tgx-cw .tgx-greeting-zone .tgx-big-hi{font-size:22px;letter-spacing:-0.015em}'
    +'#tgx-cw .tgx-greeting-zone .tgx-sub-hi{font-size:12.5px;margin-top:4px}'
    +'#tgx-cw .tgx-greeting-zone{margin-bottom:0}'
    /* Section labels — tighten margin */
    +'#tgx-cw .tgx-section-label{margin-bottom:6px;font-size:10px}'
    /* Capability cards — REAL selectors. #tgxCapCards is the grid container. */
    +'#tgx-cw #tgxCapCards{grid-template-columns:1fr 1fr;gap:7px}'
    +'#tgx-cw .tgx-cap-card{padding:11px 12px;min-height:0;gap:6px;border-radius:12px}'
    +'#tgx-cw .tgx-cap-icon{width:30px;height:30px;border-radius:9px}'
    +'#tgx-cw .tgx-cap-icon svg{width:15px;height:15px}'
    +'#tgx-cw .tgx-cap-title{font-size:12.5px}'
    +'#tgx-cw .tgx-cap-desc{display:none}' /* already hidden, reinforced for mobile */
    /* Starters — horizontal scroll lane, smaller pills */
    +'#tgx-cw #tgxStarters{margin:0 -14px;padding:2px 14px 4px;gap:5px;min-height:32px}'
    +'#tgx-cw #tgxStarters > *{font-size:11.5px;padding:6px 10px;flex-shrink:0;white-space:nowrap}'
    /* Demoted footer — tighten */
    +'#tgx-cw .tgx-demoted{font-size:11.5px;gap:6px;margin-top:2px;padding:0 2px;flex-wrap:wrap}'
    +'#tgx-cw .tgx-demoted button{font-size:11.5px}'
    /* Anchor the demoted footer to the bottom of the home body so the empty
       space appears in a deliberate-looking band above it, not as dead space
       below it. */
    +'#tgx-cw .tgx-demoted{margin-top:auto;padding-top:8px}'
    /* Input wrap — clearly elevated so it reads as the input zone, not as
       background. White background, accent border-top, subtle upward shadow. */
    +'#tgx-cw .tgx-input-wrap{padding:12px 14px 14px;gap:8px;background:#fff;border-top:1px solid rgba(15,26,61,0.10);box-shadow:0 -4px 14px rgba(15,26,61,0.04)}'
    +'#tgx-cw .tgx-input-inner{padding:4px 4px 4px 16px;border:1.5px solid rgba(15,26,61,0.15);background:#FAFAF6}'
    +'#tgx-cw .tgx-input-inner:focus-within{border-color:'+C.accentColor+';background:#fff;box-shadow:0 0 0 3px '+C.accentColor+'1F}'
    +'#tgx-cw .tgx-input{font-size:16px;padding:10px 0}' /* 16px stops iOS zoom on focus */
    +'#tgx-cw .tgx-send{min-width:42px;min-height:42px;width:42px;height:42px}'
    +'#tgx-cw .tgx-send svg{width:18px;height:18px}'
    /* Voice mic — bigger on mobile so it\\'s easy to find and tap */
    +'#tgx-cw .tgx-mic{width:40px;height:40px;background:'+C.brandColor+'14}'
    +'#tgx-cw .tgx-mic svg{width:19px;height:19px}'
    /* Chat view tightening */
    +'#tgx-cw .tgx-msgs{padding:14px 12px;gap:10px}'
    +'#tgx-cw .tgx-bar{padding:10px 12px 12px;gap:8px}'
    /* Header tightens slightly */
    +'#tgx-cw .tgx-header{padding:11px 14px}'
    +'#tgx-cw .tgx-hdr-name{font-size:14.5px}'
    +'#tgx-cw .tgx-hdr-sub{font-size:11px}'
    +'#tgx-cw .tgx-avatar-hdr{width:34px;height:34px;font-size:14px;border-radius:10px}'
    /* Hint pills below chat input — horizontal scroll */
    +'#tgx-cw .tgx-hints{flex-wrap:nowrap;overflow-x:auto;-webkit-overflow-scrolling:touch;scrollbar-width:none}'
    +'#tgx-cw .tgx-hints::-webkit-scrollbar{display:none}'
    +'#tgx-cw .tgx-hint{flex-shrink:0;white-space:nowrap}'
    /* Rich blocks — keep within bubble width */
    +'#tgx-cw .luna-dest-card,#tgx-cw .luna-offer-card,#tgx-cw .luna-faq-policy-card,#tgx-cw .luna-emergency-card,#tgx-cw .luna-location-card,#tgx-cw .luna-booking-card,#tgx-cw .luna-human-handoff-card{max-width:100%}'
    +'#tgx-cw .luna-dest-img,#tgx-cw .luna-offer-img{height:140px}'
    +'#tgx-cw .luna-location-map{height:150px}'
    +'#tgx-cw .luna-location-head,#tgx-cw .luna-dest-body,#tgx-cw .luna-offer-body{padding:10px 12px}'
    +'#tgx-cw .luna-location-ctas,#tgx-cw .luna-dest-cta-row,#tgx-cw .luna-offer-cta-row{padding:10px 12px;gap:6px}'
    +'#tgx-cw .luna-location-cta,#tgx-cw .luna-dest-cta,#tgx-cw .luna-offer-cta{padding:10px 8px;font-size:11.5px}'
    +'#tgx-cw .luna-location-name,#tgx-cw .luna-dest-name,#tgx-cw .luna-offer-title{font-size:13.5px}'
    /* Email bar */
    +'#tgx-cw .tgx-email-bar{padding:6px 12px 0}'
    +'#tgx-cw .tgx-email-inline{flex-wrap:wrap;gap:6px;padding:6px 12px 0}'
    +'#tgx-cw .tgx-email-inline input{flex:1 1 100%;min-width:0}'
    +'#tgx-cw .tgx-email-inline button{padding:9px 14px;min-height:36px}'
    +'#tgx-cw .tgx-email-status{font-size:11.5px;padding:8px 12px}'
    +'#tgx-cw .tgx-email-mini-btn{min-height:32px;padding:6px 12px}'
    /* Booking embed */
    +'#tgx-cw .tgx-booking-mount{border-radius:12px}'
    /* More-below pill stays clear of input */
    +'#tgx-cw .tgx-more-below{bottom:78px}'
    /* Quick-reply chips → single column for tap-friendly width */
    +'#tgx-cw .luna-chips{flex-direction:column;gap:6px}'
    +'#tgx-cw .luna-chip{width:100%;text-align:center}'
    /* Welcome panel inside chat */
    +'#tgx-cw .tgx-welcome{padding:14px}'
    +'#tgx-cw .tgx-welcome-title{font-size:14px}'
    +'#tgx-cw .tgx-welcome-step{font-size:12.5px}';
  if (C.mobileBubble === "small") {
    mobileCSS += '#tgx-cw .tgx-fab{width:46px;height:46px;box-shadow:0 4px 14px rgba(0,0,0,0.25)}'
      +'#tgx-cw .tgx-fab svg{width:22px;height:22px}';
  } else if (C.mobileBubble === "hidden") {
    mobileCSS += '#tgx-cw .tgx-fab{display:none}';
  }
  mobileCSS += '}';
  /* Ultra-narrow refinement under 360px (small Android phones, split screen) */
  mobileCSS += '@media(max-width:360px){'
    +'#tgx-cw .tgx-greeting-zone .tgx-big-hi{font-size:20px}'
    +'#tgx-cw .tgx-home-body{padding:12px 12px 6px;gap:9px}'
    +'#tgx-cw #tgxCapCards{grid-template-columns:1fr 1fr;gap:6px}'
    +'#tgx-cw .tgx-cap-card{padding:10px 11px}'
    +'#tgx-cw .tgx-input-wrap{padding:8px 12px 10px}'
    +'#tgx-cw .luna-dest-img,#tgx-cw .luna-offer-img{height:120px}'
    +'#tgx-cw .luna-location-map{height:130px}'
    +'#tgx-cw .luna-location-ctas{flex-direction:column}'
    +'#tgx-cw .luna-location-cta{justify-content:center}'
  +'}';
  s.textContent += mobileCSS;
  document.head.appendChild(s);
}

/* ─── AVATAR HELPER ──────────────────────────────────────── */
function makeAvatar(size, forHeader) {
  var el = document.createElement("div");
  el.className = "tgx-avatar " + (forHeader ? "tgx-avatar-hdr" : "tgx-avatar-msg");
  el.style.cssText = "width:"+size+"px;height:"+size+"px;border-radius:"+(size>30?"11px":"7px")+";font-size:"+Math.round(size*0.45)+"px";
  if (C.profileImage && isSafeUrl(C.profileImage)) {
    /* Build <img> via createElement — never innerHTML with Airtable-sourced URLs */
    var img = document.createElement("img");
    img.src = C.profileImage;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    el.appendChild(img);
  } else {
    el.textContent = C.logoText || "";
  }
  return el;
}

/* ─── URL SAFETY ─────────────────────────────────────────── */
/* Only allow http(s) URLs. Blocks javascript:, data:, vbscript: etc. */
function isSafeUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > 2000) return false;
  /* Strip control chars and whitespace that could be used for evasion */
  var cleaned = url.replace(/[\s\u0000-\u001F\u007F]/g, "");
  return /^https?:\/\//i.test(cleaned);
}

/* ─── SAFE MARKDOWN RENDERER ─────────────────────────────── */
/* Renders the small markdown subset Luna uses (**bold**, *italic*, [label](url),
   bare deep-link URLs, \n -> <br>) into a parent element using DOM nodes only.
   Never calls innerHTML with text content. XSS-safe by construction. */
function renderSafeMarkdown(parent, text) {
  if (typeof text !== "string") return;

  /* Tokeniser: walk the string and emit tokens for links, bold, italic, newlines, and plain text.
     Regex chosen to match the original rendering (so nothing visible changes for users). */
  var PATTERNS = [
    { name: "link",     re: /\[([^\]]+?)\]\((https?:\/\/[^\s)]+?)\)/g },
    { name: "deeplink", re: /(^|[^"(\w])(https?:\/\/dl\.tvllnk\.com[^\s<>")\]]+)/g },
    { name: "bold",     re: /\*\*([^*]+?)\*\*/g },
    { name: "italic",   re: /\*([^*]+?)\*/g }
  ];

  /* First pass: find all matches and their positions */
  var matches = [];
  PATTERNS.forEach(function(p) {
    p.re.lastIndex = 0;
    var m;
    while ((m = p.re.exec(text)) !== null) {
      matches.push({
        type: p.name,
        start: m.index + (p.name === "deeplink" ? m[1].length : 0),
        end: m.index + m[0].length,
        groups: m.slice(1),
        full: m[0]
      });
    }
  });

  /* Sort by start, remove overlaps (first match wins) */
  matches.sort(function(a, b) { return a.start - b.start; });
  var filtered = [];
  var lastEnd = -1;
  matches.forEach(function(m) {
    if (m.start >= lastEnd) { filtered.push(m); lastEnd = m.end; }
  });

  /* Emit tokens: plain text (with \n handling) + DOM nodes for markdown matches */
  function emitPlain(str) {
    if (!str) return;
    var parts = str.split("\n");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].length > 0) parent.appendChild(document.createTextNode(parts[i]));
      if (i < parts.length - 1) parent.appendChild(document.createElement("br"));
    }
  }

  var cursor = 0;
  filtered.forEach(function(m) {
    emitPlain(text.slice(cursor, m.start));

    if (m.type === "bold") {
      var b = document.createElement("strong");
      b.textContent = m.groups[0];
      parent.appendChild(b);
    } else if (m.type === "italic") {
      var i = document.createElement("em");
      i.textContent = m.groups[0];
      parent.appendChild(i);
    } else if (m.type === "link") {
      var label = m.groups[0];
      var url = m.groups[1];
      if (isSafeUrl(url)) {
        var a = document.createElement("a");
        a.href = url;
        var isSearch = /dl\.tvllnk\.com|travellinx/i.test(url);
        a.target = isSearch ? "_self" : "_blank";
        a.rel = "noopener noreferrer";
        if (isSearch) a.className = "tgx-search-link";
        a.textContent = label;
        parent.appendChild(a);
      } else {
        /* Unsafe URL — render as plain text */
        parent.appendChild(document.createTextNode(m.full));
      }
    } else if (m.type === "deeplink") {
      var url2 = m.groups[1];
      if (isSafeUrl(url2)) {
        var a2 = document.createElement("a");
        a2.href = url2;
        a2.target = "_self";
        a2.rel = "noopener noreferrer";
        a2.className = "tgx-search-link";
        a2.textContent = "Click here to view results";
        parent.appendChild(a2);
      } else {
        parent.appendChild(document.createTextNode(m.full));
      }
    }

    cursor = m.end;
  });

  emitPlain(text.slice(cursor));
}

/* ─── BUILD DOM ──────────────────────────────────────────── */
function buildDOM() {
  var T = getTokens();
  var root = document.createElement("div");
  root.id = "tgx-cw";

  /* FAB — icon injected safely below; use a placeholder span */
  root.innerHTML = ''
  +'<button class="tgx-fab" id="tgxFab"><span id="tgxFabIcon"></span><span class="tgx-badge" id="tgxBadge">0</span></button>'
  +'<div class="tgx-panel" id="tgxPanel">'

    /* ── HOME SCREEN ── */
    +'<div class="tgx-screen" id="tgxHomeScreen">'
      +'<div class="tgx-hdr-full">'
        +'<div class="tgx-hdr-row">'
          +'<div id="tgxHomeAvatar"></div>'
          +'<div style="flex:1;min-width:0"><div class="tgx-hdr-name" id="tgxHomeName"></div><div class="tgx-hdr-sub"><div class="tgx-status"></div>Online now</div></div>'
          +'<button class="tgx-hdr-btn" id="tgxHomeClose"></button>'
        +'</div>'
      +'</div>'
      +'<div class="tgx-home-body">'
        +'<div class="tgx-greeting-zone">'
          +'<div class="tgx-big-hi" id="tgxBigHi"></div>'
          +'<div class="tgx-sub-hi" id="tgxSubHi"></div>'
        +'</div>'
        +'<div>'
          +'<div class="tgx-section-label">What I can help with</div>'
          +'<div id="tgxCapCards"></div>'
        +'</div>'
        +'<div>'
          +'<div class="tgx-section-label">Try asking</div>'
          +'<div id="tgxStarters"></div>'
        +'</div>'
        +'<div class="tgx-demoted">'
          +'<span>Prefer a person?</span>'
          +'<button id="tgxDemotedHuman"></button>'
          +'<span>·</span>'
          +'<button id="tgxDemotedLeave"></button>'
        +'</div>'
      +'</div>'
      +'<div class="tgx-input-wrap" id="tgxHomeInputWrap">'
        +'<div class="tgx-input-inner">'
          +'<input class="tgx-input" id="tgxHomeInput" placeholder="Ask me anything..." autocomplete="off">'
          +'<button class="tgx-mic" id="tgxHomeMic" type="button" aria-label="Voice input" title="Voice input"></button>'
        +'</div>'
        +'<button class="tgx-send" id="tgxHomeSend"></button>'
      +'</div>'
    +'</div>'

    /* ── CHAT SCREEN ── */
    +'<div class="tgx-screen hidden" id="tgxChatScreen">'
      +'<div class="tgx-hdr-compact">'
        +'<button class="tgx-hdr-btn" id="tgxBackHome"></button>'
        +'<div id="tgxChatAvatar"></div>'
        +'<div style="flex:1;min-width:0"><div class="tgx-hdr-name" id="tgxChatName" style="font-size:14px"></div><div class="tgx-hdr-sub"><div class="tgx-status"></div>Online</div></div>'
        +'<button class="tgx-hdr-btn" id="tgxClearChat" title="Start a new conversation" aria-label="Start a new conversation"></button>'
        +'<button class="tgx-expand-btn tgx-hdr-btn" id="tgxExpandBtn" title="Expand window" aria-label="Expand window"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg></button>'
        +'<button class="tgx-hdr-btn" id="tgxChatClose"></button>'
      +'</div>'
      +'<div class="tgx-date" id="tgxDateDiv">Today</div>'
      +'<div class="tgx-msgs" id="tgxMsgs"></div>'
      +'<div class="tgx-typing-row" id="tgxTypingRow"><div id="tgxTypingAvatar"></div><div class="tgx-typing" id="tgxTyping"><span></span><span></span><span></span></div><div class="tgx-typing-status" id="tgxTypingStatus"></div></div>'
      +'<div id="tgxPills" class="tgx-pills"></div>'
      +'<div class="tgx-email-bar" id="tgxEmailBar"><span class="tgx-email-link" id="tgxEmailLink">&#128231; Email this chat</span></div>'
      +'<div class="tgx-input-wrap"><div class="tgx-input-inner"><input class="tgx-input" id="tgxInput" placeholder="Ask me anything..." autocomplete="off"><button class="tgx-mic" id="tgxChatMic" type="button" aria-label="Voice input" title="Voice input"></button></div><button class="tgx-send" id="tgxSend"></button></div>'
      +'<div class="tgx-esc-bar" id="tgxEscBar"><button class="tgx-esc-btn human" id="tgxHuman"></button><button class="tgx-esc-btn leave" id="tgxLeave"></button></div>'
      +'<div class="tgx-footer" id="tgxFooterChat"></div>'
    +'</div>'

  +'</div>';

  document.body.appendChild(root);

  /* ── Populate tainted fields via textContent / safe DOM — never innerHTML ── */
  function setText(id, val) { var el = document.getElementById(id); if (el) el.textContent = val || ""; }

  /* FAB icon: custom image (validated URL) or built-in SVG */
  var fabIconEl = document.getElementById("tgxFabIcon");
  if (C.bubbleIcon && isSafeUrl(C.bubbleIcon)) {
    var fabImg = document.createElement("img");
    fabImg.className = "tgx-fab-icon";
    fabImg.src = C.bubbleIcon;
    fabImg.alt = "Chat";
    fabImg.referrerPolicy = "no-referrer";
    fabIconEl.appendChild(fabImg);
  } else {
    /* svgIcon returns a trusted static string — safe to innerHTML */
    fabIconEl.innerHTML = svgIcon("chat", 24, "#fff");
  }

  /* Static SVG icons in buttons — safe because svgIcon args are all internal constants */
  document.getElementById("tgxHomeClose").innerHTML = svgIcon("minus",16,"rgba(255,255,255,0.65)");
  document.getElementById("tgxBackHome").innerHTML = svgIcon("arrowLeft",17,"rgba(255,255,255,0.7)");
  document.getElementById("tgxChatClose").innerHTML = svgIcon("minus",16,"rgba(255,255,255,0.65)");
  /* Clear-conversation button — refresh icon */
  var tgxClearChatBtn = document.getElementById("tgxClearChat");
  if (tgxClearChatBtn) {
    tgxClearChatBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.7)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>';
    tgxClearChatBtn.addEventListener("click", function(e) {
      e.preventDefault();
      showClearConfirm();
    });
  }
  document.getElementById("tgxSend").innerHTML = svgIcon("send",16,"#fff");

  /* Tainted Airtable fields — textContent only */
  setText("tgxHomeName", C.name);
  setText("tgxChatName", C.name);
  // v2.1: greeting zone — render welcome with italic emphasis on *word*
  var bigHi = document.getElementById("tgxBigHi");
  if (bigHi) {
    var raw = C.welcome || "Hi there — how can I help today?";
    // Build DOM nodes so we don't innerHTML untrusted text
    var idx = 0; var node;
    raw.split(/(\*[^*]+\*)/).forEach(function(part) {
      if (!part) return;
      if (/^\*[^*]+\*$/.test(part)) {
        node = document.createElement("em");
        node.textContent = part.slice(1, -1);
      } else {
        node = document.createTextNode(part);
      }
      bigHi.appendChild(node);
    });
  }
  var subHi = document.getElementById("tgxSubHi");
  if (subHi) subHi.textContent = C.tagline || "Find a trip, manage your booking, or just ask me anything — I'm here.";
  setText("tgxWelcome", C.welcome);
  setText("tgxFooterHome", C.footer);
  setText("tgxFooterChat", C.footer);
  setText("tgxDemotedHuman", C.escalateLabel);
  setText("tgxDemotedLeave", C.leaveLabel);
  setText("tgxHuman", C.escalateLabel);
  setText("tgxLeave", C.leaveLabel);

  /* Insert avatars */
  document.getElementById("tgxHomeAvatar").appendChild(makeAvatar(42, true));
  document.getElementById("tgxChatAvatar").appendChild(makeAvatar(32, true));
  document.getElementById("tgxTypingAvatar").appendChild(makeAvatar(26, false));

  /* Build capability cards — safely */
  var cards = C.capabilityCards || D.capabilityCards;
  var cardsEl = document.getElementById("tgxCapCards");
  cards.forEach(function(card){
    var btn = document.createElement("button");
    btn.className = "tgx-cap-card";

    var iconWrap = document.createElement("div");
    iconWrap.className = "tgx-cap-icon";
    iconWrap.innerHTML = svgIcon(card.icon, 18, "#fff"); /* svgIcon validates name against whitelist */

    var textWrap = document.createElement("div");
    textWrap.style.cssText = "flex:1;min-width:0";

    var titleEl = document.createElement("div");
    titleEl.className = "tgx-cap-title";
    titleEl.textContent = card.title || "";

    var descEl = document.createElement("div");
    descEl.className = "tgx-cap-desc";
    descEl.textContent = card.desc || "";

    textWrap.appendChild(titleEl);
    textWrap.appendChild(descEl);

    var chevron = document.createElement("span");
    chevron.innerHTML = svgIcon("chevronRight", 15, getTokens().text3);

    btn.appendChild(iconWrap);
    btn.appendChild(textWrap);
    btn.appendChild(chevron);

    btn.addEventListener("click", function(){ switchToChat(); sendToAI(card.title); });
    cardsEl.appendChild(btn);
  });

  /* Build starter pills */
  var startersEl = document.getElementById("tgxStarters");
  C.hints.forEach(function(hint){
    var btn = document.createElement("button");
    btn.className = "tgx-starter";
    btn.textContent = hint;
    btn.addEventListener("click", function(){ switchToChat(); sendToAI(hint); });
    startersEl.appendChild(btn);
  });

  return root;
}

/* ─── SCREEN SWITCHING ──────────────────────────────────── */
function switchToHome() {
  currentScreen = "home";
  document.getElementById("tgxHomeScreen").classList.remove("hidden");
  document.getElementById("tgxChatScreen").classList.add("hidden");
  saveSession();
}
function switchToChat() {
  currentScreen = "chat";
  document.getElementById("tgxChatScreen").classList.remove("hidden");
  document.getElementById("tgxHomeScreen").classList.add("hidden");
  if (msgs.length === 0) startChat();
  setTimeout(function(){ $input.focus(); }, 100);
  saveSession();
}

/* ─── HELPERS ────────────────────────────────────────────── */
var $fab, $panel, $msgs, $input, $send, $pills, $typing, $badge, $escBar, $emailBar;

function scrollBottom() { setTimeout(function(){ $msgs.scrollTop = $msgs.scrollHeight; }, 50); }

/* Scrolls so the first NEW message (passed in) is at the top of the visible area.
   If the new content overflows below the viewport, toggles a "more below" indicator
   that fades in. The indicator is auto-hidden when the user scrolls near the bottom
   or when a new message arrives. */
var _moreBelowEl = null;
var _moreBelowScrollHandler = null;
function ensureMoreBelowIndicator() {
  if (_moreBelowEl) return _moreBelowEl;
  var el = document.createElement("button");
  el.className = "tgx-more-below";
  el.type = "button";
  el.setAttribute("aria-label", "Scroll to latest");
  el.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg><span>More</span>';
  el.addEventListener("click", function () {
    $msgs.scrollTo({ top: $msgs.scrollHeight, behavior: "smooth" });
    el.classList.remove("active");
  });
  /* Position next to the msgs container — append into chat screen */
  var chatScreen = $msgs.parentElement;
  if (chatScreen) chatScreen.appendChild(el);
  _moreBelowEl = el;
  return el;
}
function scrollToNewMessage(firstNewRow) {
  if (!firstNewRow) { scrollBottom(); return; }
  /* Use scrollIntoView with instant scroll for reliable top-anchoring. Smooth
     scroll is unreliable on mobile during layout shifts (typing indicator
     collapse, image loads) — the animation can end up at a stale offset.
     scrollIntoView({block:'start'}) anchors the element to the visible top
     consistently across browsers. Then we nudge a few px so we don't crop
     into the row's padding. Double-RAF ensures we measure AFTER all layout
     reflows from the message insertion + typing indicator removal. */
  requestAnimationFrame(function () { requestAnimationFrame(function () {
    try {
      firstNewRow.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
      // Pull back a couple of pixels so the row's top edge clears the container's
      // top padding cleanly. Without this the first line can be hidden behind
      // the messages container's padding-top.
      if ($msgs.scrollTop > 6) $msgs.scrollTop -= 6;
    } catch (e) {
      // Fallback to manual calc
      var targetTop = firstNewRow.offsetTop - 4;
      var maxTop = $msgs.scrollHeight - $msgs.clientHeight;
      if (targetTop > maxTop) targetTop = maxTop;
      if (targetTop < 0) targetTop = 0;
      $msgs.scrollTop = targetTop;
    }
    /* Toggle more-below indicator after the scroll settles */
    setTimeout(function () {
      var indicator = ensureMoreBelowIndicator();
      var distanceFromBottom = $msgs.scrollHeight - ($msgs.scrollTop + $msgs.clientHeight);
      if (distanceFromBottom > 40) {
        indicator.classList.add("active");
        /* On any further user scroll, hide once they reach the bottom */
        if (!_moreBelowScrollHandler) {
          _moreBelowScrollHandler = function () {
            var d = $msgs.scrollHeight - ($msgs.scrollTop + $msgs.clientHeight);
            if (d < 40) indicator.classList.remove("active");
          };
          $msgs.addEventListener("scroll", _moreBelowScrollHandler, { passive: true });
        }
      } else {
        indicator.classList.remove("active");
      }
    }, 250);
  }); });
}
function hideMoreBelow() { if (_moreBelowEl) _moreBelowEl.classList.remove("active"); }

/* Renders an embedded My Booking widget as a chat message. The "descriptor"
   is the same object the message was stored with: { kind, widgetId }. */
function renderBookingWidgetMessage(descriptor, pendingPills) {
  if (!descriptor || descriptor.kind !== "booking_lookup" || !isSafeWidgetId(descriptor.widgetId)) {
    return;
  }

  /* New booking lookup → any previously captured context is stale (could be
     a different visitor, or the same visitor checking a different trip).
     Cleared here so we don't accidentally answer questions about the OLD
     booking while the NEW lookup form is on screen. The new context will
     be captured when this booking loads via watchForBookingLoad → release. */
  _currentBookingContext = null;

  var row = document.createElement("div");
  row.className = "tgx-msg-row tgx-msg-row-widget";

  var bubble = document.createElement("div");
  bubble.className = "tgx-bubble-widget";

  var mount = document.createElement("div");
  mount.className = "tgx-booking-mount";
  /* Expose chat brand colours as CSS vars on the mount so any styles inside
     the booking widget that read CSS custom properties pick up our theme. */
  if (C.brandColor) mount.style.setProperty('--tg-booking-brand', C.brandColor);
  if (C.accentColor) mount.style.setProperty('--tg-booking-accent', C.accentColor);
  bubble.appendChild(mount);

  var placeholder = document.createElement("div");
  placeholder.className = "tgx-booking-loading";
  placeholder.textContent = "Loading booking lookup...";
  mount.appendChild(placeholder);

  row.appendChild(bubble);
  $msgs.appendChild(row);
  scrollBottom();

  /* Release any pending follow-up pills the moment the booking is successfully
     retrieved (.tgm-found appears in the widget's shadow DOM). If the lookup
     fails (.tgm-nf appears) we leave pills hidden — no point pushing follow-up
     questions about a trip we couldn't find. Defensive: any failure to set up
     the observer falls back silently to no pills, never breaks the booking
     bubble itself. */
  /* Watch the embedded booking widget for the moment its lookup succeeds
     (.tgm-found appears in the shadow DOM). On success we do two things:
       1. Capture a privacy-redacted summary of the booking into
          _currentBookingContext, so subsequent /api/luna-chat calls can
          give Luna conversational context about the trip.
       2. If pills were deferred (FQs/OPTs from the booking-trigger turn),
          release them now — pills only appear when the booking actually
          loaded successfully.
     If the lookup fails (.tgm-nf appears) we don't capture context and we
     don't show pills — no trip is on screen to follow up about.
     If the visitor sends another message before the booking loads, the
     observer is cancelled (see cancelPendingPillReleases). */
  function watchForBookingLoad(widgetInstance) {
    if (typeof MutationObserver === "undefined") return;
    if (!widgetInstance || !widgetInstance.shadow) return;

    var released = false;
    var releaseTimeout = null;
    var trackerEntry = null;

    function untrack() {
      if (!trackerEntry) return;
      var idx = _pendingPillReleases.indexOf(trackerEntry);
      if (idx !== -1) _pendingPillReleases.splice(idx, 1);
      trackerEntry = null;
    }

    function release() {
      if (released) return;
      released = true;
      if (releaseTimeout) clearTimeout(releaseTimeout);
      try { observer.disconnect(); } catch (_) {}
      untrack();

      /* Capture redacted booking summary for future Luna turns */
      try {
        if (typeof widgetInstance.getSafeContextSummary === "function") {
          var summary = widgetInstance.getSafeContextSummary();
          if (summary && typeof summary === "object") {
            _currentBookingContext = summary;
          }
        }
      } catch (e) {
        console.warn("Luna widget: failed to capture booking context:", e.message);
      }

      /* Release deferred pills, if any were queued from the booking-trigger turn */
      if (pendingPills && pendingPills.length) {
        try {
          showPills(pendingPills, function(pill) { sendToAI(pill); });
        } catch (e) {
          console.warn("Luna widget: failed to show booking follow-up pills:", e.message);
        }
      }
    }

    function cancel() {
      if (released) return;
      released = true;
      if (releaseTimeout) clearTimeout(releaseTimeout);
      try { observer.disconnect(); } catch (_) {}
      untrack();
      /* No context capture, no pills — this is the visitor moving on before booking loaded */
    }

    try {
      var observer = new MutationObserver(function() {
        try {
          if (widgetInstance.shadow.querySelector(".tgm-found")) {
            release();
          }
        } catch (_) { /* shadow may have been torn down */ }
      });
      observer.observe(widgetInstance.shadow, { childList: true, subtree: true });

      /* Safety net: if for any reason the observer never fires (e.g. visitor
         abandons the form, browser quirk), make sure we don't leak the
         observer forever. 30 minutes is well past any plausible session. */
      releaseTimeout = setTimeout(function() {
        try { observer.disconnect(); } catch (_) {}
        untrack();
      }, 30 * 60 * 1000);

      /* Register so a new visitor message can cancel us */
      trackerEntry = { cancel: cancel };
      _pendingPillReleases.push(trackerEntry);
    } catch (e) {
      console.warn("Luna widget: pill release observer failed:", e.message);
    }
  }

  Promise.all([
    loadBookingWidgetScript(),
    fetchBookingConfig(descriptor.widgetId)
  ])
  .then(function(results) {
    var config = results[1];
    if (!config) {
      placeholder.textContent = "Sorry, the booking lookup form couldn't load. You can contact us directly instead.";
      return;
    }
    if (placeholder.parentNode) placeholder.parentNode.removeChild(placeholder);
    try {
      var widgetInstance = new window.TGMyBookingWidget(mount, config);
      watchForBookingLoad(widgetInstance);
    } catch (err) {
      console.error("Luna widget: failed to init booking widget:", err);
      var errEl = document.createElement("div");
      errEl.className = "tgx-booking-loading";
      errEl.textContent = "Sorry, the booking lookup form couldn't load. You can contact us directly instead.";
      mount.appendChild(errEl);
    }
  })
  .catch(function(err) {
    console.error("Luna widget: booking widget script failed:", err);
    placeholder.textContent = "Sorry, the booking lookup form couldn't load. You can contact us directly instead.";
  });
}

function addMsg(role, text, noStore, originalText, pendingPills, blocks) {
  /* Booking widget embed — unchanged */
  if (role === "widget") {
    renderBookingWidgetMessage(text, pendingPills);
    if (!noStore) {
      msgs.push({ role: "widget", content: text, ts: Date.now() });
      saveSession();
    }
    return;
  }

  /* System messages — unchanged */
  if (role === "system") {
    var sysDiv = document.createElement("div");
    sysDiv.className = "tgx-msg system";
    sysDiv.textContent = text;
    $msgs.appendChild(sysDiv);
    if (!noStore) {
      msgs.push({ role: role, content: text, ts: Date.now() });
      saveSession();
    }
    scrollBottom();
    if ($emailBar && msgs.length >= 3) $emailBar.style.display = "block";
    return;
  }

  /* User messages — single bubble */
  if (role === "user") {
    appendBubbleRow(role, text);
    if (!noStore) {
      msgs.push({ role: role, content: text, ts: Date.now() });
      saveSession();
    }
    scrollBottom();
    if ($emailBar && msgs.length >= 3) $emailBar.style.display = "block";
    return;
  }

  /* Bot / agent — new block-aware path. If blocks were passed, render each
     in order. Otherwise fall back to plain prose (legacy behaviour). */
  hideMoreBelow();
  var firstNewRow = null;
  var rowsBefore = $msgs.children.length;
  if ((role === "bot" || role === "agent") && Array.isArray(blocks) && blocks.length > 0) {
    var ctx = buildBlockContext();
    blocks.forEach(function (item) {
      if (item.type === "prose") {
        appendBubbleRow(role, item.text);
      } else if (item.type === "block") {
        appendBlockRow(role, item.blockType, item.props || {}, ctx);
      }
      /* malformed items silently dropped */
    });
  } else {
    appendBubbleRow(role, text);
  }
  /* Capture first newly-appended row so we can scroll its TOP into view */
  if ($msgs.children.length > rowsBefore) {
    firstNewRow = $msgs.children[rowsBefore];
  }

  if (!noStore) {
    msgs.push({
      role: role,
      content: text,
      original: originalText || null,
      blocks: blocks || null,
      ts: Date.now()
    });
    saveSession();
  }

  scrollToNewMessage(firstNewRow);
  if ($emailBar && msgs.length >= 3) $emailBar.style.display = "block";
}

/* ─── HELPER: appendBubbleRow — renders a single prose message bubble ─── */
function appendBubbleRow(role, text) {
  var row = document.createElement("div");
  row.className = "tgx-msg-row" + (role === "user" ? " user" : "");
  if (role === "bot" || role === "agent") row.appendChild(makeAvatar(26, false));

  var col = document.createElement("div");
  col.className = "tgx-msg-col";

  var bubble = document.createElement("div");
  bubble.className = "tgx-msg " + role;
  renderSafeMarkdown(bubble, text);
  col.appendChild(bubble);

  var timeEl = document.createElement("span");
  timeEl.className = "tgx-msg-time";
  var now = new Date();
  timeEl.textContent = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
  col.appendChild(timeEl);

  row.appendChild(col);
  $msgs.appendChild(row);
}

/* ─── HELPER: appendBlockRow — renders a rich block (uses block-renderers) ─── */
function appendBlockRow(role, blockType, props, ctx) {
  if (!window.LunaBlockRenderers || typeof window.LunaBlockRenderers.renderBlock !== "function") {
    console.warn("[Luna] block-renderers not loaded; skipping block:", blockType);
    return;
  }

  /* quick_replies renders as pills under the input, not inline */
  if (blockType === "quick_replies") {
    var replies = (props && Array.isArray(props.replies)) ? props.replies : [];
    if (replies.length > 0) {
      showPills(replies, function (txt) { sendToAI(txt); });
    }
    return;
  }

  /* All other blocks render as a full-width row in the thread */
  var row = document.createElement("div");
  row.className = "tgx-msg-row tgx-msg-row-widget";

  var bubble = document.createElement("div");
  bubble.className = "tgx-bubble-widget";

  try {
    var blockEl = window.LunaBlockRenderers.renderBlock(blockType, props, ctx);
    if (blockEl) bubble.appendChild(blockEl);
  } catch (e) {
    console.error("[Luna] block render failed:", blockType, e.message);
    return;
  }

  row.appendChild(bubble);
  $msgs.appendChild(row);
}

/* ─── HELPER: buildBlockContext — dispatch callback for block events ─── */
function buildBlockContext() {
  return {
    dispatch: function (event) {
      if (!event || typeof event !== "object") return;
      switch (event.type) {
        case "send_message":
          if (typeof event.text === "string" && event.text.trim()) {
            sendToAI(event.text);
          }
          break;
        case "booking_action":
          if (event.action === "pay_balance") {
            sendToAI("I'd like to pay my balance for booking " + (event.reference || ""));
          } else if (event.action === "view_documents") {
            sendToAI("Can I get my travel documents for booking " + (event.reference || ""));
          } else {
            sendToAI(event.action ? "Help me with: " + event.action : "Help me with my booking");
          }
          break;
        case "handoff":
          escalateToHuman();
          break;
        default:
          console.log("[Luna] unhandled block event:", event);
      }
    }
  };
}

function showPills(items, onClick) {
  $pills.innerHTML = "";
  items.forEach(function(txt){
    var btn = document.createElement("button");
    btn.className = "tgx-pill";
    btn.textContent = txt;
    btn.addEventListener("click", function(){ onClick(txt); });
    $pills.appendChild(btn);
  });
}
function clearPills() { $pills.innerHTML = ""; }

function parseResponse(text) {
  if (typeof text !== "string") return { body: "", fqs: [], opts: [], blocks: [] };

  /* v2: extract [BLOCK]{...}[/BLOCK] markers via the block parser.
     If none found, fall back to legacy [FQ]/[OPT] line parsing.
     If found, also strip any [FQ]/[OPT] lines from prose items (mixed mode). */
  var blockItems = [];
  try {
    if (window.LunaBlockParser && typeof window.LunaBlockParser.parseLunaResponse === "function") {
      blockItems = window.LunaBlockParser.parseLunaResponse(text);
    }
  } catch (e) {
    console.warn("[Luna] block parser failed, falling back to legacy:", e.message);
    blockItems = [];
  }

  var hasBlocks = blockItems.some(function (i) { return i.type === "block"; });
  if (!hasBlocks) {
    /* Pure legacy path — identical to original parseResponse */
    var fqs = [], opts = [], clean = [];
    text.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (/^\[FQ\]/i.test(trimmed)) fqs.push(trimmed.replace(/^\[FQ\]\s*/i, ""));
      else if (/^\[OPT\]/i.test(trimmed)) opts.push(trimmed.replace(/^\[OPT\]\s*/i, ""));
      else clean.push(line);
    });
    return { body: clean.join("\n").trim(), fqs: fqs, opts: opts, blocks: [] };
  }

  /* Mixed mode: blocks present, also extract any [FQ]/[OPT] from prose items */
  var fqs2 = [], opts2 = [];
  var cleanedItems = blockItems.map(function (item) {
    if (item.type !== "prose") return item;
    var keptLines = [];
    item.text.split("\n").forEach(function (line) {
      var trimmed = line.trim();
      if (/^\[FQ\]/i.test(trimmed)) {
        fqs2.push(trimmed.replace(/^\[FQ\]\s*/i, ""));
      } else if (/^\[OPT\]/i.test(trimmed)) {
        opts2.push(trimmed.replace(/^\[OPT\]\s*/i, ""));
      } else {
        keptLines.push(line);
      }
    });
    var cleanedText = keptLines.join("\n").trim();
    if (!cleanedText) return null;
    return { type: "prose", text: cleanedText };
  }).filter(Boolean);

  var bodyParts = cleanedItems
    .filter(function (i) { return i.type === "prose"; })
    .map(function (i) { return i.text; });

  return {
    body: bodyParts.join("\n\n"),
    fqs: fqs2,
    opts: opts2,
    blocks: cleanedItems
  };
}

/* ─── EMAIL THIS CHAT ────────────────────────────────────── */
function buildTranscript() {
  var lines = [];
  msgs.forEach(function(m) {
    if (m.role === "system" || m.role === "widget") return;
    var d = new Date(m.ts);
    var time = ("0"+d.getHours()).slice(-2) + ":" + ("0"+d.getMinutes()).slice(-2);
    var sender = m.role === "user" ? "You" : m.role === "agent" ? "Agent" : (C.name || "Luna AI");
    var line = sender + " (" + time + "): " + m.content;
    if (m.original) line += "\n  [Original: " + m.original + "]";
    lines.push(line);
  });
  return lines.join("\n\n");
}

// Derive the email-transcript endpoint from the chat endpoint URL.
function emailTranscriptEndpoint() {
  if (typeof C.emailTranscriptEndpoint === 'string' && C.emailTranscriptEndpoint) {
    return C.emailTranscriptEndpoint;
  }
  // Same host as the chat endpoint, different path
  return C.endpoint.replace(/\/api\/luna-chat\b.*$/, '/api/email-chat-transcript');
}

// Reset the email bar back to its idle link state.
function resetEmailBar() {
  var bar = $emailBar;
  if (!bar) return;
  bar.innerHTML = '<span class="tgx-email-link" id="tgxEmailLink">&#128231; Email this chat</span>';
  var link = document.getElementById('tgxEmailLink');
  if (link) link.addEventListener('click', handleEmailChat);
}

// Copy the transcript text to the clipboard. Fallback for if email send fails.
function copyTranscriptToClipboard(btnEl) {
  var text = buildTranscript();
  var done = function(ok) {
    if (!btnEl) return;
    var orig = btnEl.textContent;
    btnEl.textContent = ok ? 'Copied!' : 'Copy failed';
    setTimeout(function() { btnEl.textContent = orig; }, 1500);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function() { done(true); }, function() { done(false); });
  } else {
    // Older browser fallback
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(ok);
    } catch (e) {
      done(false);
    }
  }
}

// Actually send the transcript via the server-side endpoint.
// Updates the email bar to show loading -> success / error states.
function sendChatTranscript(email) {
  var bar = $emailBar;
  if (!bar) return;
  bar.innerHTML = '<div class="tgx-email-status tgx-email-status-loading">Sending\u2026</div>';

  var payload = {
    clientName: C.clientName || '',
    visitorEmail: email,
    transcript: buildTranscript(),
    visitorName: userName || '',
    conversationId: convId || '',
    brandColor: C.brandColor || '',
    accentColor: C.accentColor || ''
  };

  fetch(emailTranscriptEndpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function(r) {
    return r.json().then(function(data) { return { ok: r.ok, status: r.status, data: data }; });
  }).then(function(result) {
    if (result.ok) {
      // Success — show toast then revert after a few seconds
      visitorEmail = email; // remember for next time
      bar.innerHTML = '<div class="tgx-email-status tgx-email-status-success">\u2713 Sent to ' + email + '. Check your inbox.</div>';
      setTimeout(resetEmailBar, 4500);
    } else {
      // Server-side error — show message + copy fallback
      var msg = (result.data && result.data.error) || 'Something went wrong';
      showEmailError(msg, email);
    }
  }).catch(function(err) {
    console.warn('[Luna] email transcript send failed:', err && err.message);
    showEmailError('Couldn\'t reach the server', email);
  });
}

// Show an error state with a copy-fallback option.
function showEmailError(message, email) {
  var bar = $emailBar;
  if (!bar) return;
  bar.innerHTML =
    '<div class="tgx-email-status tgx-email-status-error">' +
      '<div class="tgx-email-status-text">' + (message || 'Send failed') + '</div>' +
      '<div class="tgx-email-status-actions">' +
        '<button class="tgx-email-mini-btn" id="tgxEmailRetry">Try again</button>' +
        '<button class="tgx-email-mini-btn" id="tgxEmailCopy">Copy transcript</button>' +
        '<button class="tgx-email-mini-btn tgx-email-mini-btn-x" id="tgxEmailDismiss">Cancel</button>' +
      '</div>' +
    '</div>';
  document.getElementById('tgxEmailRetry').addEventListener('click', function() {
    if (email) sendChatTranscript(email); else handleEmailChat();
  });
  document.getElementById('tgxEmailCopy').addEventListener('click', function(e) {
    copyTranscriptToClipboard(e.target);
  });
  document.getElementById('tgxEmailDismiss').addEventListener('click', resetEmailBar);
}

// Entry point — clicking "Email this chat" link
function handleEmailChat() {
  if (visitorEmail) {
    // Already have an email from previous interaction — confirm before sending
    sendChatTranscript(visitorEmail);
    return;
  }
  // No email yet — prompt for one
  var bar = $emailBar;
  if (!bar) return;
  bar.innerHTML = '';
  var wrap = document.createElement("div");
  wrap.className = "tgx-email-inline";
  wrap.innerHTML =
    '<input type="email" id="tgxInlineEmail" placeholder="Enter your email" autocomplete="email">' +
    '<button id="tgxInlineEmailGo">Send</button>' +
    '<button class="tgx-email-cancel" id="tgxInlineEmailX" aria-label="Cancel">\u00d7</button>';
  bar.appendChild(wrap);
  bar.style.display = "block";
  setTimeout(function(){
    var inp = document.getElementById("tgxInlineEmail");
    if (!inp) return;
    inp.focus();
    var submit = function() {
      var em = inp.value.trim();
      if (em && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) {
        sendChatTranscript(em);
      } else {
        inp.style.borderColor = '#EF4444';
        inp.focus();
        setTimeout(function() { inp.style.borderColor = ''; }, 1200);
      }
    };
    document.getElementById("tgxInlineEmailGo").addEventListener("click", submit);
    document.getElementById("tgxInlineEmailX").addEventListener("click", resetEmailBar);
    inp.addEventListener("keydown", function(e){
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      if (e.key === "Escape") { e.preventDefault(); resetEmailBar(); }
    });
  }, 50);
}

/* ─── ABLY: init (capability token auth) ───────────────────── */
function initAbly() {
  if (!window.Ably) {
    console.warn("Luna widget: Ably SDK not loaded, real-time disabled");
    return;
  }
  if (!C.ablyTokenEndpoint) {
    console.warn("Luna widget: no ablyTokenEndpoint configured, real-time disabled");
    return;
  }
  if (!convId) convId = "conv_" + Date.now() + "_" + Math.random().toString(36).substr(2,6);

  /* authCallback: Ably SDK calls this when it needs a token, and whenever the
     current token is near expiry. We never hold a root key client-side. */
  function authCallback(tokenParams, callback) {
    fetch(C.ablyTokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ convId: convId, clientName: C.clientName })
    })
    .then(function(r) {
      if (!r.ok) throw new Error("Token endpoint returned " + r.status);
      return r.json();
    })
    .then(function(tokenDetails) { callback(null, tokenDetails); })
    .catch(function(err) {
      console.error("Luna widget: Ably token fetch failed:", err.message);
      callback(err, null);
    });
  }

  ably = new Ably.Realtime({
    authCallback: authCallback,
    clientId: "visitor_" + convId
  });

  dashChannel = ably.channels.get("luna-dashboard");
  chatChannel = ably.channels.get("luna-chat:" + convId);
  agentsChannel = ably.channels.get("luna-agents");

  chatChannel.subscribe("message", function(msg){
    var d = msg.data;
    if (d && d.from === "agent") {
      if (d.translateTo) {
        translateText(d.text, d.translateTo).then(function(translated) {
          addMsg("agent", translated, false, d.text);
          if (!panelOpen) { unread++; $badge.textContent = unread; $badge.style.display = "flex"; }
        });
      } else {
        addMsg("agent", d.text);
        if (!panelOpen) { unread++; $badge.textContent = unread; $badge.style.display = "flex"; }
      }
    }
  });

  chatChannel.subscribe("handler_change", function(msg){
    var d = msg.data;
    if (!d) return;
    if (d.handler === "agent" || (d.handler && d.handler !== "waiting" && d.handler !== "ai")) {
      addMsg("system", (d.agentName || "An agent") + " has joined the chat.");
      liveMode = true;
      $escBar.classList.remove("active");
    }
    if (d.handler === "resolved" || d.handler === "closed") {
      addMsg("system", "This conversation has been closed.");
      liveMode = false;
      var resolvedChannel = chatChannel;
      showRatingOverlay(resolvedChannel);
      chatChannel.unsubscribe();
      convId = "conv_" + Date.now() + "_" + Math.random().toString(36).substr(2,6);
      chatChannel = ably.channels.get("luna-chat:" + convId);
      convStarted = false;
      $escBar.classList.add("active");
    }
  });

  chatChannel.subscribe("typing", function(msg){
    var d = msg.data;
    if (d && d.from === "agent") {
      $typing.classList.add("active");
      scrollBottom();
      clearTimeout(typingTimeout);
      typingTimeout = setTimeout(function(){ $typing.classList.remove("active"); }, 2000);
    }
  });

  ably.connection.on("connected", function(){
    console.log("Luna widget: Ably connected (token auth), convId=" + convId);
  });

  ably.connection.on("failed", function(err){
    console.error("Luna widget: Ably connection failed:", err && err.reason);
  });
}

/* ─── ABLY: publish helpers ──────────────────────────────── */
function ensureConversationStarted() {
  if (convStarted || !dashChannel) return;
  convStarted = true;
  var now = new Date().toISOString();
  var isMobile = /Mobi|Android/i.test(navigator.userAgent);
  dashChannel.publish("new_conversation", {
    convId: convId,
    visitor: {
      name: userName || "Anonymous",
      email: visitorEmail || undefined,
      marketingConsent: marketingConsent,
      page: window.location.href,
      device: isMobile ? "mobile" : "desktop",
      country: visitorCountry,
      visitorId: visitorId,
      lang: conversationLang || "English"
    },
    handler: "ai",
    startedAt: now,
    messages: msgs.filter(function(m){return m.role !== "widget";}).map(function(m){ return {from: m.role === "user" ? "visitor" : m.role, text: m.content, timestamp: new Date(m.ts).toISOString()}; })
  });

  if (C.airtableKey && C.airtableBase && C.convTable) {
    var botHistory = msgs.filter(function(m){return m.role!=="system" && m.role!=="widget";}).map(function(m){return m.role+": "+m.content;}).join("\n");
    fetch("https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable, {
      method:"POST",
      headers:{"Authorization":"Bearer "+C.airtableKey,"Content-Type":"application/json"},
      body:JSON.stringify({records:[{fields:{
        "fldgQj90mYwsVO4yK":convId,"fldqx6k7WvrqE8BW1":userName||"Anonymous",
        "fldYdZq59FCpKQ7Hf":"Bot","fldSoy7BMqyzVb5pp":now,"fld1GghMiUnAmdtow":now,
        "fldZ38GYN4XbHGl03":botHistory
      }}],typecast:true})
    }).catch(function(e){ console.warn("Airtable conv create error:", e); });
  }
}

/* ─── TRANSLATION ────────────────────────────────────────── */
async function translateText(text, targetLang) {
  try {
    var res = await fetch(C.endpoint.replace("/api/luna-chat", "/api/translate"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({text: text, targetLang: targetLang})
    });
    if (res.ok) { var data = await res.json(); return data.translated || data.text || text; }
  } catch(e) { console.warn("Luna widget: translation failed:", e.message); }
  return text;
}

function publishMessage(from, text) {
  if (!chatChannel) return;
  chatChannel.publish("message", { from: from, text: text, lang: conversationLang || "English", timestamp: new Date().toISOString() });
}

function publishHandlerChange(handler) {
  if (!chatChannel) return;
  chatChannel.publish("handler_change", {handler: handler});
}

/* ─── NAME COLLECTION OVERLAY ────────────────────────────── */
function showNameOverlay() {
  var ov = document.createElement("div");
  ov.className = "tgx-overlay";
  ov.id = "tgxNameOv";
  var html = '<h3>'+C.namePrompt+'</h3><p>This helps us personalise your experience.</p>'
    +'<input type="text" id="tgxNameIn" placeholder="Your name" autofocus>'
    +'<input type="email" id="tgxEmailIn" placeholder="Email (optional)">'
    +'<input type="text" id="tgxHpIn" class="tgx-hp" tabindex="-1" autocomplete="off">'
    +'<label class="tgx-check" id="tgxMarketingLabel">'
    +'<input type="checkbox" id="tgxMarketingIn">'
    +'<span class="tgx-cb"><svg viewBox="0 0 14 14" fill="none"><path d="M2.5 7.5L5.5 10.5L11.5 3.5" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></span>'
    +'<span class="tgx-cb-label">I\'d like to receive offers and updates</span>'
    +'</label>'
    +'<button class="tgx-obtn" id="tgxNameGo">Continue</button>'
    +'<button class="tgx-olink" id="tgxNameSkip">'+C.skipLabel+'</button>';
  if (C.privacyUrl) {
    html += '<a class="tgx-privacy" href="'+C.privacyUrl+'" target="_blank" rel="noopener">See our privacy policy</a>';
  }
  ov.innerHTML = html;
  $panel.appendChild(ov);
  var formOpenedAt = Date.now();
  setTimeout(function(){
    var ni = document.getElementById("tgxNameIn");
    var ei = document.getElementById("tgxEmailIn");
    var mi = document.getElementById("tgxMarketingIn");
    var hp = document.getElementById("tgxHpIn");
    ni.focus();
    function doSubmit() {
      if (hp && hp.value) { ov.innerHTML = '<h3>Something went wrong</h3><p>Please refresh the page and try again.</p>'; return; }
      if (Date.now() - formOpenedAt < 2000) { ov.innerHTML = '<h3>Something went wrong</h3><p>Please refresh the page and try again.</p>'; return; }
      userName = ni.value.trim();
      visitorEmail = ei.value.trim();
      marketingConsent = mi.checked;
      nameCollected = true;
      var emailValid = visitorEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(visitorEmail);
      if (emailValid && marketingConsent) {
        fetch(C.endpoint.replace("/api/luna-chat", "/api/subscribe"), {
          method: "POST", headers: {"Content-Type": "application/json"},
          body: JSON.stringify({ clientName: C.clientName, name: userName, email: visitorEmail })
        }).catch(function(e){ console.warn("Luna widget: subscribe error:", e); });
      }
      saveSession();
      ov.remove();
      /* Home screen is already visible underneath — no need to switch */
    }
    document.getElementById("tgxNameGo").addEventListener("click", doSubmit);
    document.getElementById("tgxNameSkip").addEventListener("click", function(){
      userName = ""; visitorEmail = ""; marketingConsent = false; nameCollected = true;
      saveSession();
      ov.remove();
      /* Home screen is already visible underneath */
    });
    ni.addEventListener("keydown", function(e){ if (e.key === "Enter") { e.preventDefault(); ei.focus(); } });
    ei.addEventListener("keydown", function(e){ if (e.key === "Enter") { e.preventDefault(); doSubmit(); } });
  }, 50);
}

/* ─── LEAVE A MESSAGE OVERLAY ────────────────────────────── */
function showLeaveOverlay() {
  var ov = document.createElement("div");
  ov.className = "tgx-overlay";
  ov.id = "tgxLeaveOv";
  ov.innerHTML = '<h3>Leave us a message</h3><p>We\'ll get back to you as soon as possible.</p>'
    +'<input type="text" id="tgxLeaveEmail" placeholder="Your email address">'
    +'<textarea id="tgxLeaveMsg" placeholder="Your message..."></textarea>'
    +'<button class="tgx-obtn" id="tgxLeaveGo">Send message</button>'
    +'<button class="tgx-olink" id="tgxLeaveCancel">Cancel</button>';
  $panel.appendChild(ov);
  setTimeout(function(){
    document.getElementById("tgxLeaveEmail").focus();
    document.getElementById("tgxLeaveGo").addEventListener("click", doLeaveMessage);
    document.getElementById("tgxLeaveCancel").addEventListener("click", function(){ ov.remove(); });
  }, 50);
}

function doLeaveMessage() {
  var email = document.getElementById("tgxLeaveEmail").value.trim();
  var message = document.getElementById("tgxLeaveMsg").value.trim();
  if (!email || !message) return;
  var ov = document.getElementById("tgxLeaveOv");
  var now = new Date().toISOString();
  if (dashChannel) {
    dashChannel.publish("new_conversation", {
      convId: convId, visitor: {name: userName || "Anonymous", email: email, page: window.location.href},
      handler: "closed", startedAt: now,
      messages: [{from: "visitor", text: "[Left a message] " + message, timestamp: now}]
    });
  }
  if (C.airtableKey && C.airtableBase && C.convTable) {
    var botHistory = msgs.filter(function(m){return m.role!=="system" && m.role!=="widget";}).map(function(m){return m.role+": "+m.content;}).join("\n");
    fetch("https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable, {
      method:"POST",
      headers:{"Authorization":"Bearer "+C.airtableKey,"Content-Type":"application/json"},
      body:JSON.stringify({records:[{fields:{
        "fldgQj90mYwsVO4yK":convId,"fldqx6k7WvrqE8BW1":userName||"Anonymous","fldZXcvl7k3FS5Gu7":email,
        "fldYdZq59FCpKQ7Hf":"Closed","fldSoy7BMqyzVb5pp":now,"fld1GghMiUnAmdtow":now,
        "fldZ38GYN4XbHGl03":"[Left a message] "+message+"\n\n--- Bot history ---\n"+botHistory
      }}],typecast:true})
    }).catch(function(e){ console.warn("Airtable leave-msg error:", e); });
  }
  if (ov) ov.remove();
  addMsg("system", "Message sent! We'll be in touch soon.");
}

/* ─── RATING OVERLAY ─────────────────────────────────────── */
function showRatingOverlay(ratingChannel) {
  var T = getTokens();
  var ov = document.createElement("div");
  ov.className = "tgx-overlay";
  ov.id = "tgxRatingOv";
  ov.innerHTML = '<h3>How was your experience?</h3><p>Rate your conversation</p>'
    +'<div class="tgx-stars" id="tgxStars">'
    +'<span class="tgx-star" data-v="1">&#9733;</span><span class="tgx-star" data-v="2">&#9733;</span>'
    +'<span class="tgx-star" data-v="3">&#9733;</span><span class="tgx-star" data-v="4">&#9733;</span>'
    +'<span class="tgx-star" data-v="5">&#9733;</span></div>'
    +'<button class="tgx-olink" id="tgxRatingSkip">Skip</button>';
  $panel.appendChild(ov);
  setTimeout(function(){
    var stars = ov.querySelectorAll(".tgx-star");
    stars.forEach(function(star){
      star.addEventListener("mouseenter", function(){
        var val = parseInt(this.getAttribute("data-v"));
        stars.forEach(function(s){
          s.style.cssText = parseInt(s.getAttribute("data-v")) <= val ? "color:#FFD60A;transform:scale(1.15)" : "color:"+T.text3+";transform:scale(1)";
        });
      });
      star.addEventListener("click", function(){
        var val = parseInt(this.getAttribute("data-v"));
        if (ratingChannel) ratingChannel.publish("rating", {rating: val});
        ov.innerHTML = '<h3>Thanks for your feedback!</h3><p>You can start a new chat anytime.</p>';
        setTimeout(function(){ if (ov.parentNode) ov.remove(); }, 2000);
      });
    });
    var sc = document.getElementById("tgxStars");
    if (sc) sc.addEventListener("mouseleave", function(){ stars.forEach(function(s){ s.style.cssText = "color:"+T.text3+";transform:scale(1)"; }); });
    document.getElementById("tgxRatingSkip").addEventListener("click", function(){ ov.remove(); });
  }, 50);
}

/* ─── CALL LUNA AI ENDPOINT ──────────────────────────────── */
/* ─── STREAMING SEND ────────────────────────────────────
   Streams Luna's response via SSE for a feel-alive experience. Falls back
   to non-streaming callLuna() if streaming fails or isn't available.

   Returns the same shape as callLuna() so sendToAI can use either path.

   Side-effects during streaming:
     - Creates a placeholder bot bubble after first text chunk and updates
       it as deltas arrive (with [BLOCK]... stripped from the visible text).
     - Hides the typing indicator on first chunk.

   The function returns the full data once the 'done' event arrives, so
   the caller can run normal post-processing (block rendering, pills,
   escalation detection, etc).

   If a bubble was created during streaming, returns { reply, escalate,
   detectedLanguage, _streamedBubble: <element> } so the caller knows it
   doesn't need to render the prose part again. */
async function streamFromLuna(userText) {
  history.push({role: "user", content: userText});
  var requestBody = {
    message: userText, convId: convId, visitorName: userName || undefined,
    clientName: C.clientName, history: history.slice(-16), page: window.location.pathname,
    stream: true
  };
  if (_currentPageContext && typeof _currentPageContext === "object") {
    requestBody.pageContext = _currentPageContext;
  }
  if (_currentBookingContext && typeof _currentBookingContext === "object") {
    requestBody.bookingContext = _currentBookingContext;
  }

  var streamedBubbleRow = null;
  var streamedBubble = null;
  var visibleText = "";       // What we've shown in the bubble (with [BLOCK] stripped)
  var fullText = "";          // What we've received total (raw)
  var inBlockBuffer = false;  // Whether we've seen [BLOCK] but not [/BLOCK]

  function ensureBubble() {
    if (streamedBubbleRow) return;
    // Hide typing indicator now that text is coming
    $typing.classList.remove("active");
    stopTypingStatus();
    // Create the row + bubble structure manually (mirrors appendBubbleRow)
    streamedBubbleRow = document.createElement("div");
    streamedBubbleRow.className = "tgx-msg-row";
    streamedBubbleRow.appendChild(makeAvatar(26, false));
    var col = document.createElement("div");
    col.className = "tgx-msg-col";
    streamedBubble = document.createElement("div");
    streamedBubble.className = "tgx-msg bot tgx-msg-streaming";
    col.appendChild(streamedBubble);
    var timeEl = document.createElement("span");
    timeEl.className = "tgx-msg-time";
    var now = new Date();
    timeEl.textContent = ("0" + now.getHours()).slice(-2) + ":" + ("0" + now.getMinutes()).slice(-2);
    col.appendChild(timeEl);
    streamedBubbleRow.appendChild(col);
    $msgs.appendChild(streamedBubbleRow);
    // Scroll the new bubble into view at the top of the visible area
    scrollToNewMessage(streamedBubbleRow);
  }

  function appendVisible(deltaText) {
    if (!deltaText) return;
    fullText += deltaText;
    // Mini state machine: if [BLOCK] appears anywhere in fullText, switch
    // to buffering mode. We re-derive visibleText each time so a [BLOCK]
    // marker split across delta chunks (e.g. " [BLO" + "CK]...") doesn't
    // leak partial markers into the visible bubble.
    if (!inBlockBuffer) {
      var blockIdx = fullText.indexOf('[BLOCK]');
      if (blockIdx !== -1) {
        // [BLOCK] arrived — visible text is everything before it.
        visibleText = fullText.slice(0, blockIdx);
        inBlockBuffer = true;
        ensureBubble();
        // Clear bubble before re-render — renderSafeMarkdown only appends.
        streamedBubble.textContent = '';
        renderSafeMarkdown(streamedBubble, visibleText);
        return;
      }
      // Defensive: if the tail of fullText is a partial "[", "[B", "[BL", "[BLO",
      // "[BLOC", or "[BLOCK", hold those bytes back from the visible bubble so
      // a chunk split across the marker boundary doesn't briefly show "[BLO".
      var tail = fullText.slice(-7);
      var holdback = 0;
      var partials = ['[BLOCK', '[BLOC', '[BLO', '[BL', '[B', '['];
      for (var pi = 0; pi < partials.length; pi++) {
        if (tail.endsWith(partials[pi])) { holdback = partials[pi].length; break; }
      }
      visibleText = fullText.slice(0, fullText.length - holdback);
      ensureBubble();
      // Clear bubble before re-render — renderSafeMarkdown only appends.
      streamedBubble.textContent = '';
      renderSafeMarkdown(streamedBubble, visibleText);
    }
    // If we're already buffering a block, nothing visible to update
  }

  try {
    var res = await fetch(C.endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json", "Accept": "text/event-stream"},
      body: JSON.stringify(requestBody)
    });
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    if (!res.body || typeof res.body.getReader !== 'function') {
      throw new Error("Streaming not supported by browser");
    }

    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = "";
    var convIdFromMeta = null;
    var detectedLanguage = null;
    var donePayload = null;

    function processEvent(eventName, dataJson) {
      var data;
      try { data = JSON.parse(dataJson); } catch (e) { return; }
      if (eventName === 'meta') {
        if (data.convId) convIdFromMeta = data.convId;
      } else if (eventName === 'status') {
        // Phase 3.5: server-supplied real-time status text.
        // Cancel any pending client-side timers so they don't overwrite the
        // server's more accurate status with a generic one.
        stopTypingStatus();
        if (typeof data.text === 'string' && data.text) {
          setTypingStatus(data.text);
        }
      } else if (eventName === 'text') {
        if (typeof data.delta === 'string') appendVisible(data.delta);
      } else if (eventName === 'done') {
        donePayload = data;
        if (data.detectedLanguage) detectedLanguage = data.detectedLanguage;
      } else if (eventName === 'error') {
        // Server-side stream error — show fallback text
        donePayload = {
          reply: data.fallbackReply || "I'm having trouble right now. Please try again.",
          escalate: true,
          error: true
        };
      }
    }

    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      // SSE events are separated by double newlines
      var parts = buffer.split('\n\n');
      buffer = parts.pop(); // Keep the (potentially incomplete) last part
      for (var p = 0; p < parts.length; p++) {
        var raw = parts[p];
        if (!raw.trim()) continue;
        // Parse "event: NAME\ndata: JSON"
        var lines = raw.split('\n');
        var eventName = 'message';
        var dataLines = [];
        for (var li = 0; li < lines.length; li++) {
          var line = lines[li];
          if (line.indexOf('event:') === 0) eventName = line.slice(6).trim();
          else if (line.indexOf('data:') === 0) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) {
          processEvent(eventName, dataLines.join('\n'));
        }
      }
      if (donePayload) break;
    }

    if (!donePayload) {
      // Stream ended without 'done' — use whatever we have
      donePayload = {
        reply: fullText || "I'm having trouble right now. Please try again.",
        escalate: false
      };
    }

    var finalReply = donePayload.reply || fullText || "";
    history.push({role: "assistant", content: finalReply});
    if (detectedLanguage) conversationLang = detectedLanguage;
    saveSession();

    return {
      reply: finalReply,
      escalate: !!donePayload.escalate,
      detectedLanguage: detectedLanguage,
      _streamedBubble: streamedBubble, // Caller can replace this when rendering parsed result
      _streamedBubbleRow: streamedBubbleRow,
      _streamedVisibleText: visibleText
    };
  } catch (err) {
    console.warn("[Luna] streaming failed:", err.message, "— falling back to non-streaming");
    // Clean up any partial bubble
    if (streamedBubbleRow && streamedBubbleRow.parentNode) {
      streamedBubbleRow.parentNode.removeChild(streamedBubbleRow);
    }
    // Remove the user message from history we just pushed, callLuna will re-push
    if (history.length > 0 && history[history.length - 1].role === 'user') {
      history.pop();
    }
    // Fall back to non-streaming
    return await callLuna(userText);
  }
}

async function callLuna(userText) {
  history.push({role: "user", content: userText});
  try {
    var requestBody = {
      message: userText, convId: convId, visitorName: userName || undefined,
      clientName: C.clientName, history: history.slice(-16), page: window.location.pathname
    };
    /* Attach the redacted booking summary if the visitor has retrieved a
       booking earlier in this session. Lets Luna answer follow-up questions
       with the actual destination/dates/airline, rather than asking for
       facts already on screen. Set/captured by watchForBookingLoad. */
    if (_currentBookingContext && typeof _currentBookingContext === "object") {
      requestBody.bookingContext = _currentBookingContext;
    }
    var res = await fetch(C.endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(requestBody)
    });
    if (!res.ok) {
      var errText = await res.text();
      console.error("Luna widget: endpoint error:", res.status, errText);
      return {reply: "I'm having trouble connecting right now. You can use the \"" + C.escalateLabel + "\" button below to reach our team directly."};
    }
    var data = await res.json();
    var reply = data.reply || "Sorry, I'm having trouble connecting right now.";
    history.push({role: "assistant", content: reply});
    if (data.detectedLanguage) conversationLang = data.detectedLanguage;
    saveSession();
    return data;
  } catch(e) {
    console.error("Luna widget: fetch error:", e.message);
    return {reply: "I'm having trouble connecting right now. You can use the \"" + C.escalateLabel + "\" button below to reach our team directly."};
  }
}

/* ─── SEND MESSAGE (AI mode) ─────────────────────────────── */
/* ─── PROGRESSIVE TYPING STATUS ─────────────────────────────
   While waiting for Luna's response, show a contextual status
   that updates every ~800ms. Gives the perception of work
   happening without changing actual response time. */
var _typingStatusTimers = [];
function pickStage2Status(text) {
  var t = (text || "").toLowerCase();
  /* Match on visitor intent — most specific first */
  if (/booking|reference|reservation|confirm/.test(t)) return "Looking up your booking…";
  if (/cancel|refund|insurance|baggage|visa|passport|policy|terms/.test(t)) return "Checking the policy…";
  if (/stuck|lost|emergency|urgent|stranded|help/.test(t)) return "Pulling up emergency info…";
  if (/holiday|sunshine|hot|warm|sun|beach|family|honeymoon|romantic|february|march|april|may|june|july|august|september|october|november|december|january|winter|summer|spring|autumn|where|ideas|inspire|suggestion/.test(t)) return "Finding destinations…";
  if (/price|cost|deal|offer|cheap|budget|all.?inclusive|package/.test(t)) return "Checking what's available…";
  if (/speak|human|agent|team|expert|someone/.test(t)) return "Finding the right person…";
  return "Thinking it through…";
}
function startTypingStatus(visitorText) {
  stopTypingStatus(); /* clear any prior timers */
  var $status = document.getElementById("tgxTypingStatus");
  if (!$status) return;
  $status.textContent = "";
  $status.classList.remove("visible");
  var stage1 = "Thinking…";
  var stage2 = pickStage2Status(visitorText);
  var stage3 = "Still working…";
  /* Stage 1 — show after 400ms (avoid flashing on fast responses) */
  _typingStatusTimers.push(setTimeout(function() {
    $status.textContent = stage1;
    $status.classList.add("visible");
  }, 400));
  /* Stage 2 — show after 1400ms */
  _typingStatusTimers.push(setTimeout(function() {
    $status.classList.remove("visible");
    setTimeout(function() {
      $status.textContent = stage2;
      $status.classList.add("visible");
    }, 250); /* let the fade-out finish before changing text */
  }, 1400));
  /* Stage 3 — show after 3000ms */
  _typingStatusTimers.push(setTimeout(function() {
    $status.classList.remove("visible");
    setTimeout(function() {
      $status.textContent = stage3;
      $status.classList.add("visible");
    }, 250);
  }, 3000));
}
function stopTypingStatus() {
  _typingStatusTimers.forEach(function(t) { clearTimeout(t); });
  _typingStatusTimers = [];
  var $status = document.getElementById("tgxTypingStatus");
  if ($status) {
    $status.classList.remove("visible");
    $status.textContent = "";
  }
}

// Phase 3.5: set a status text directly with smooth fade transition.
// Used by SSE status events from the server.
function setTypingStatus(text) {
  var $status = document.getElementById("tgxTypingStatus");
  if (!$status) return;
  // If text matches what's already shown, do nothing (no flicker)
  if ($status.textContent === text && $status.classList.contains("visible")) return;
  // Fade out, swap, fade in
  $status.classList.remove("visible");
  setTimeout(function() {
    $status.textContent = text;
    $status.classList.add("visible");
  }, 200);
}

async function sendToAI(text) {
  if (!text.trim()) return;
  cancelAutoTrigger();
  cancelPendingPillReleases();   /* drop any stale booking-pill observers from earlier turns */
  clearPills();
  /* Ensure we're on chat screen */
  if (currentScreen !== "chat") switchToChat();
  addMsg("user", text);
  $input.value = "";
  $input.disabled = true;
  $typing.classList.add("active");
  startTypingStatus(text);
  scrollBottom();

  ensureConversationStarted();
  publishMessage("visitor", text);

  // Streaming is on by default. Gracefully degrades to non-streaming if the
  // server doesn't honour stream=true (older deployments) or the browser
  // lacks ReadableStream support.
  var useStreaming = (C.streaming !== false) && (typeof ReadableStream !== "undefined");
  var data = useStreaming ? await streamFromLuna(text) : await callLuna(text);
  $typing.classList.remove("active");
  stopTypingStatus();

  /* Strip [BOOKING_LOOKUP:rec...] marker BEFORE [FQ]/[OPT] parsing,
     so the form shows below the bot's text. */
  var rawReply = data.reply || "";
  var bookingExtracted = extractBookingLookupMarker(rawReply);
  var workingReply = bookingExtracted.cleanText;

  var parsed = parseResponse(workingReply);
  if (data._streamedBubble) {
    // The prose has already been streamed into a live bubble. We need to:
    //   1. Replace its content with the FINAL parsed prose (cleans up any
    //      stray [BLOCK] fragments left in visibleText), and
    //   2. Render blocks as separate rows BELOW the streamed bubble.
    // We also need to store the message in msgs[] so it persists.
    try {
      // Strip the streaming class so any per-stream styling is removed
      data._streamedBubble.classList.remove("tgx-msg-streaming");
      // Re-render with the parsed body (in case [BLOCK] sneaked into visible text).
      // Must clear first — renderSafeMarkdown only appends, so without this
      // the bubble would contain the streamed prose PLUS the parsed prose.
      if (parsed.body) {
        data._streamedBubble.textContent = "";
        renderSafeMarkdown(data._streamedBubble, parsed.body);
      }
    } catch (e) {}
    // Render any blocks as new rows beneath the streamed prose
    if (parsed.blocks && parsed.blocks.length > 0) {
      var ctx = buildBlockContext();
      parsed.blocks.forEach(function(item) {
        if (item.type === "block") {
          appendBlockRow("bot", item.blockType, item.props || {}, ctx);
        }
        // We skip "prose" items because the prose was already streamed
      });
    }
    // Persist the message
    msgs.push({
      role: "bot",
      content: parsed.body,
      original: workingReply,
      blocks: (parsed.blocks && parsed.blocks.length > 0) ? parsed.blocks : null,
      ts: Date.now()
    });
    saveSession();
    publishMessage("ai", parsed.body);
  } else if (parsed.blocks && parsed.blocks.length > 0) {
    /* v2 block-aware rendering — pass blocks through */
    addMsg("bot", parsed.body, false, null, null, parsed.blocks);
    publishMessage("ai", parsed.body);
  } else if (parsed.body) {
    addMsg("bot", parsed.body);
    publishMessage("ai", parsed.body);
  }

  /* If a booking widget marker was found, render the embedded widget.
     Pills (FQs/OPTs) are deferred until AFTER the booking is successfully
     retrieved — passed to renderBookingWidgetMessage which releases them
     when .tgm-found appears in the booking widget's shadow DOM. If lookup
     fails, pills stay hidden — see watchForBookingLoad. */
  if (bookingExtracted.widgetId) {
    var deferredPills = parsed.opts.length > 0 ? parsed.opts : (parsed.fqs.length > 0 ? parsed.fqs : null);
    addMsg("widget", { kind: "booking_lookup", widgetId: bookingExtracted.widgetId }, false, null, deferredPills);
  }

  /* v2: auto-redirect for deep links DISABLED.
     In v1, Luna emitted deep links as prose markdown and the widget navigated
     to the first dl.tvllnk.com URL after 1.5s. In v2, deep links live inside
     destination_card / offer_card blocks as a "See deals" button the visitor
     clicks intentionally. Auto-redirecting on URL detection (a) triggers
     host-site scripts that pre-fetch travel URLs and (b) yanks the visitor
     out of the chat without consent. Both are bugs. v2 requires explicit click. */

  if (data.escalate === true) setTimeout(function(){ escalateToHuman(); }, 100);

  /* Pills shown immediately UNLESS we deferred them above for a booking lookup */
  if (!bookingExtracted.widgetId) {
    if (parsed.opts.length > 0) {
      showPills(parsed.opts, function(opt){ sendToAI(opt); });
    } else if (parsed.fqs.length > 0) {
      showPills(parsed.fqs, function(fq){ sendToAI(fq); });
    }
  }
  $input.disabled = false;
  $input.focus();
}

/* ─── SEND MESSAGE (Live mode) ───────────────────────────── */
function sendToAgent(text) {
  if (!text.trim()) return;
  clearPills(); addMsg("user", text);
  $input.value = "";
  publishMessage("visitor", text);
}

/* ─── ESCALATE TO HUMAN ─────────────────────────────────── */
async function escalateToHuman() {
  if (liveMode) return;
  if (currentScreen !== "chat") switchToChat();
  clearPills();

  /* Check if any agents are online via Ably presence */
  var agentsOnline = false;
  if (agentsChannel) {
    try {
      var members = await agentsChannel.presence.get();
      agentsOnline = members && members.length > 0;
    } catch(e) {
      console.warn("Luna widget: presence check failed:", e.message);
    }
  }

  if (agentsOnline) {
    /* Agents are online — real escalation */
    addMsg("system", "Connecting you to our team...");
    ensureConversationStarted();
    publishHandlerChange("waiting");

    if (C.airtableKey && C.airtableBase && C.convTable) {
      try {
        var searchUrl = "https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable+"?filterByFormula="+encodeURIComponent("{ConversationID}='"+convId+"'")+"&maxRecords=1";
        var sRes = await fetch(searchUrl, {headers:{"Authorization":"Bearer "+C.airtableKey}});
        var sData = await sRes.json();
        if (sData.records && sData.records.length > 0) {
          await fetch("https://api.airtable.com/v0/"+C.airtableBase+"/"+C.convTable+"/"+sData.records[0].id, {
            method:"PATCH",
            headers:{"Authorization":"Bearer "+C.airtableKey,"Content-Type":"application/json"},
            body:JSON.stringify({fields:{"fldYdZq59FCpKQ7Hf":"Waiting"},typecast:true})
          });
        }
      } catch(e) { console.warn("Airtable escalation error:", e); }
    }

    liveMode = true;
    $escBar.classList.remove("active");
    addMsg("system", "You're in the queue. An agent will be with you shortly.");
  } else {
    /* No agents online */
    addMsg("system", "Sorry, there are no agents available right now. You can leave us a message and we'll get back to you, or you can carry on chatting with " + C.name + ".");
    showPills(["Leave a message", "Continue chatting"], function(choice) {
      if (choice === "Leave a message") {
        showLeaveOverlay();
      } else {
        clearPills();
        addMsg("system", "No problem! I'm still here to help. What can I do for you?");
        $input.focus();
      }
    });
  }
}

/* ─── START CHAT ─────────────────────────────────────────── */
function startChat() {
  var welcomeText = C.welcome;
  if (userName) welcomeText = "Hey " + userName + "! " + welcomeText.replace(/^Hey there! /, "").replace(/^Hey there\b/, "");
  addMsg("bot", welcomeText);
  showPills(C.hints, function(h){ sendToAI(h); });
}

/* ─── INPUT HANDLER ──────────────────────────────────────── */
function handleSend() {
  var text = $input.value.trim();
  if (!text) return;
  cancelAutoTrigger();
  if (liveMode) sendToAgent(text);
  else sendToAI(text);
}

/* ─── BOOT ───────────────────────────────────────────────── */
/* ─── VIEWPORT META INJECTION ────────────────────────────
   Many older client websites (especially hand-coded sites, legacy WordPress
   themes, or e-commerce sites built before mobile-first became standard) are
   missing a proper viewport meta tag. Without it, mobile browsers render
   pages at 980px CSS width and zoom out — which means our `@media(max-width:480px)`
   query never fires on real phones.

   We check at boot. If no viewport meta exists, we inject the standard one.
   If one exists (even with bad values), we leave it alone so we never override
   an intentional host-page choice. */
/* ─── VOICE INPUT ────────────────────────────────────────
   Web Speech API integration. Free, no infrastructure required.
   Supported: Chrome, Edge, Safari (iOS 14.5+, macOS Big Sur+).
   Hidden in Firefox and unsupported browsers.

   The mic button is wired to both input pills (home and chat). When tapped:
     - Permission prompt fires (first time)
     - Visual switches to "listening" pulse
     - Interim transcript shows in italic grey inside the input
     - Final transcript replaces interim
     - Second tap (or speech-end timeout) stops recognition
     - User reviews and hits send (we never auto-send)
*/

var _voiceRecognition = null;
var _voiceState = "idle"; // idle | listening | error
var _voiceActiveInput = null; // 'home' or 'chat' — which input is currently dictating
var _voiceFinalText = ""; // text accumulated from final results
var _voiceMicHomeEl = null;
var _voiceMicChatEl = null;
var _voiceInputHomeEl = null;
var _voiceInputChatEl = null;

function micIconSvg() {
  // Two paths: mic body + stand
  return '<svg viewBox="0 0 24 24"><path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v1a7 7 0 0 1-14 0v-1"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>';
}

function isVoiceSupported() {
  try {
    return typeof window !== "undefined" &&
      (typeof window.SpeechRecognition !== "undefined" ||
       typeof window.webkitSpeechRecognition !== "undefined");
  } catch (e) { return false; }
}

function getVoiceLang() {
  // Use the browser locale if available, fallback to en-GB.
  try {
    return (navigator.language || navigator.userLanguage || "en-GB");
  } catch (e) { return "en-GB"; }
}

function ensureVoiceRecognition() {
  if (_voiceRecognition) return _voiceRecognition;
  if (!isVoiceSupported()) return null;
  var Cls = window.SpeechRecognition || window.webkitSpeechRecognition;
  var r = new Cls();
  r.continuous = true;
  r.interimResults = true;
  r.lang = getVoiceLang();
  r.maxAlternatives = 1;

  r.onstart = function() {
    _voiceState = "listening";
    updateMicVisuals();
  };

  r.onresult = function(ev) {
    if (!_voiceActiveInput) return;
    var input = _voiceActiveInput === "home" ? _voiceInputHomeEl : _voiceInputChatEl;
    if (!input) return;
    var interim = "";
    for (var i = ev.resultIndex; i < ev.results.length; i++) {
      var r2 = ev.results[i];
      if (r2.isFinal) {
        // Append final text, with a space if needed
        var seg = (r2[0] && r2[0].transcript) || "";
        if (seg) {
          _voiceFinalText = (_voiceFinalText ? _voiceFinalText + " " : "") + seg.trim();
        }
      } else {
        interim += (r2[0] && r2[0].transcript) || "";
      }
    }
    // Compose: finalised text + grey interim
    var combined = _voiceFinalText;
    if (interim) {
      combined = combined ? combined + " " + interim : interim;
    }
    input.value = combined;
    // Visual hint that text is coming in
    if (interim) input.classList.add("tgx-input-interim");
    else input.classList.remove("tgx-input-interim");
  };

  r.onerror = function(ev) {
    var err = (ev && ev.error) || "unknown";
    console.warn("[Luna] voice recognition error:", err);
    _voiceState = "error";
    updateMicVisuals();
    // Specific UX for the most common error
    if (err === "not-allowed" || err === "service-not-allowed") {
      // Permission denied — show inline hint via placeholder
      var input = _voiceActiveInput === "home" ? _voiceInputHomeEl : _voiceInputChatEl;
      if (input) {
        var orig = input.placeholder;
        input.placeholder = "Microphone permission needed";
        setTimeout(function() { if (input.placeholder === "Microphone permission needed") input.placeholder = orig; }, 3500);
      }
    }
    // No matter the error, return to idle
    setTimeout(function() { _voiceState = "idle"; updateMicVisuals(); }, 1500);
  };

  r.onend = function() {
    _voiceState = "idle";
    updateMicVisuals();
    // Strip any leftover interim styling
    if (_voiceInputHomeEl) _voiceInputHomeEl.classList.remove("tgx-input-interim");
    if (_voiceInputChatEl) _voiceInputChatEl.classList.remove("tgx-input-interim");
    _voiceActiveInput = null;
  };

  _voiceRecognition = r;
  return r;
}

function updateMicVisuals() {
  var listening = _voiceState === "listening";
  if (_voiceMicHomeEl) _voiceMicHomeEl.classList.toggle("tgx-mic-listening", listening && _voiceActiveInput === "home");
  if (_voiceMicChatEl) _voiceMicChatEl.classList.toggle("tgx-mic-listening", listening && _voiceActiveInput === "chat");
}

function startVoiceFor(which) {
  var r = ensureVoiceRecognition();
  if (!r) return;
  // Pre-seed final text with what's already in the input so dictation appends
  var input = which === "home" ? _voiceInputHomeEl : _voiceInputChatEl;
  _voiceFinalText = (input && input.value) ? input.value.trim() : "";
  _voiceActiveInput = which;
  try {
    r.start();
  } catch (e) {
    // Already started — stop, brief pause, restart with new owner
    try { r.stop(); } catch (ee) {}
    setTimeout(function() {
      try { r.start(); } catch (ee) {}
    }, 200);
  }
}

function stopVoice() {
  if (!_voiceRecognition) return;
  try { _voiceRecognition.stop(); } catch (e) {}
}

function toggleVoiceFor(which) {
  if (_voiceState === "listening") {
    if (_voiceActiveInput === which) {
      stopVoice();
    } else {
      // User tapped the other screen's mic while still listening — switch context
      stopVoice();
      setTimeout(function() { startVoiceFor(which); }, 200);
    }
  } else {
    startVoiceFor(which);
  }
}

// Called once at boot to wire up the two mic buttons. If unsupported, the
// buttons stay hidden (CSS default `display:none` — only `.tgx-mic-available`
// makes them appear).
function initVoiceInput() {
  _voiceMicHomeEl = document.getElementById("tgxHomeMic");
  _voiceMicChatEl = document.getElementById("tgxChatMic");
  _voiceInputHomeEl = document.getElementById("tgxHomeInput");
  _voiceInputChatEl = document.getElementById("tgxInput");

  // Inject SVG into both mic buttons
  if (_voiceMicHomeEl) _voiceMicHomeEl.innerHTML = micIconSvg();
  if (_voiceMicChatEl) _voiceMicChatEl.innerHTML = micIconSvg();

  // If not supported (e.g. Firefox), leave the mic buttons hidden via CSS
  // default (display:none). Otherwise reveal them.
  if (!isVoiceSupported()) {
    console.log("[Luna] voice input not supported in this browser");
    return;
  }

  // Web Speech requires a secure origin (HTTPS or localhost)
  var isSecure = (typeof location !== "undefined") &&
    (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1");
  if (!isSecure) {
    console.log("[Luna] voice input requires HTTPS — hidden");
    return;
  }

  if (_voiceMicHomeEl) {
    _voiceMicHomeEl.classList.add("tgx-mic-available");
    _voiceMicHomeEl.addEventListener("click", function(e) {
      e.preventDefault();
      toggleVoiceFor("home");
    });
  }
  if (_voiceMicChatEl) {
    _voiceMicChatEl.classList.add("tgx-mic-available");
    _voiceMicChatEl.addEventListener("click", function(e) {
      e.preventDefault();
      toggleVoiceFor("chat");
    });
  }
}

function ensureViewportMeta() {
  try {
    var existing = document.querySelector('meta[name="viewport"]');
    if (existing) {
      /* Host page has a viewport tag — respect it, even if it's not ideal.
         Log a hint if it lacks width=device-width so the dev can investigate. */
      var content = existing.getAttribute('content') || '';
      if (!/width\s*=\s*device-width/i.test(content)) {
        console.warn('[Luna] Host page viewport meta lacks width=device-width:', content,
          '— mobile rendering may be off. Recommend updating to: <meta name="viewport" content="width=device-width,initial-scale=1">');
      }
      return;
    }
    /* No viewport meta — inject the standard one */
    var meta = document.createElement('meta');
    meta.setAttribute('name', 'viewport');
    meta.setAttribute('content', 'width=device-width,initial-scale=1');
    meta.setAttribute('data-luna-injected', '1');
    /* Insert before any existing meta tags so it takes effect as early as possible */
    var firstMeta = document.querySelector('meta');
    if (firstMeta && firstMeta.parentNode) {
      firstMeta.parentNode.insertBefore(meta, firstMeta);
    } else if (document.head) {
      document.head.appendChild(meta);
    }
    console.log('[Luna] Injected viewport meta tag (host page was missing one)');
  } catch (err) {
    console.warn('[Luna] ensureViewportMeta failed:', err && err.message);
  }
}

/* ─── CONVERSATION LOGGING ────────────────────────────────
   Builds a transcript and POSTs it to /api/log-conversation when the
   conversation ends. The server then scores it for quality and surfaces
   any knowledge gaps in the agency owner's dashboard. */
function buildTranscript() {
  if (!msgs || !msgs.length) return "";
  var lines = [];
  msgs.forEach(function(m) {
    if (!m || !m.content) return;
    var role = m.role;
    var who;
    if (role === "user") who = "Visitor";
    else if (role === "bot") who = "Luna";
    else if (role === "agent") who = "Agent";
    else if (role === "widget") return; // skip system/widget messages
    else if (role === "system") return;
    else who = "Other";
    // Strip any leftover markers
    var content = (m.content || "")
      .replace(/\[BLOCK\][\s\S]*?\[\/BLOCK\]/g, "")
      .replace(/\[BOOKING_LOOKUP[^\]]*\]/g, "")
      .replace(/\[KNOWLEDGE:rec[A-Za-z0-9]{14}\]/g, "")
      .trim();
    if (content) lines.push(who + ": " + content);
  });
  return lines.join("\n\n");
}

function countVisitorMessages() {
  if (!msgs) return 0;
  return msgs.filter(function(m){ return m && m.role === "user"; }).length;
}

var _lastLoggedAt = 0;
function logConversationToServer(opts) {
  opts = opts || {};
  // Throttle — don't beacon more than once per 5 seconds
  var now = Date.now();
  if (now - _lastLoggedAt < 5000 && !opts.force) return;
  // Skip if no real conversation happened
  if (countVisitorMessages() === 0) return;
  _lastLoggedAt = now;

  var transcript = buildTranscript();
  if (!transcript) return;

  var payload = {
    convId: convId,
    clientName: C.clientName || "",
    transcript: transcript,
    visitorName: userName || "",
    visitorEmail: visitorEmail || "",
    pageUrl: window.location.href,
    wasEscalated: !!opts.escalated
  };

  var url = C.endpoint.replace(/\/api\/luna-chat\b.*$/, "/api/log-conversation");
  var body = JSON.stringify(payload);

  // Prefer sendBeacon for unload — it's the only reliable way during pagehide.
  // Otherwise use fetch with keepalive so it survives navigation.
  try {
    if (opts.beacon && navigator.sendBeacon) {
      var blob = new Blob([body], { type: "application/json" });
      navigator.sendBeacon(url, blob);
      return;
    }
  } catch (e) { /* fall through to fetch */ }

  try {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
      keepalive: true
    }).catch(function(){ /* ignore */ });
  } catch (e) { /* ignore */ }
}

/* Hook into existing close events */
function attachConversationEndListeners() {
  // visibilitychange fires when tab becomes hidden — most reliable cross-browser signal
  document.addEventListener("visibilitychange", function() {
    if (document.visibilityState === "hidden") {
      logConversationToServer({ beacon: true });
    }
  });
  // pagehide is the canonical "user is leaving" event
  window.addEventListener("pagehide", function() {
    logConversationToServer({ beacon: true });
  });
  // beforeunload as a belt-and-braces fallback (less reliable on mobile)
  window.addEventListener("beforeunload", function() {
    logConversationToServer({ beacon: true });
  });
}

async function boot() {
  /* Make sure mobile browsers don't fall back to legacy desktop emulation */
  ensureViewportMeta();
  /* Attach unload listeners so we can log the conversation server-side */
  try { attachConversationEndListeners(); } catch(e) {}

  /* Fetch remote config */
  var clientSlug = C.clientName || attr("clientName") || "default";
  try {
    var cfgRes = await fetch(C.endpoint.replace("/api/luna-chat", "/api/widget-config") + "?client=" + encodeURIComponent(clientSlug));
    if (cfgRes.ok) {
      var apiConfig = await cfgRes.json();
      rebuildConfig(apiConfig);
      console.log("Luna widget: loaded API config for", clientSlug);
    } else {
      console.warn("Luna widget: config API returned", cfgRes.status, "— using defaults");
    }
  } catch(e) {
    console.warn("Luna widget: config fetch failed, using defaults:", e.message);
  }

  /* Persistent visitor ID */
  try {
    visitorId = localStorage.getItem("luna_visitor_id");
    if (!visitorId) {
      visitorId = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2,9);
      localStorage.setItem("luna_visitor_id", visitorId);
    }
  } catch(e) {
    visitorId = "v_" + Date.now() + "_" + Math.random().toString(36).substr(2,9);
  }

  /* Country detection */
  try {
    var geoRes = await fetch("https://ipapi.co/json/");
    if (geoRes.ok) { var geoData = await geoRes.json(); visitorCountry = geoData.country_code || ""; }
  } catch(e) {}

  /* Restore session (name, messages, convId) from previous page */
  sessionRestored = restoreSession();

  injectCSS();
  buildDOM();

  $fab = document.getElementById("tgxFab");
  $panel = document.getElementById("tgxPanel");
  $msgs = document.getElementById("tgxMsgs");
  $input = document.getElementById("tgxInput");
  $send = document.getElementById("tgxSend");
  $pills = document.getElementById("tgxPills");
  $typing = document.getElementById("tgxTypingRow");
  $badge = document.getElementById("tgxBadge");
  $escBar = document.getElementById("tgxEscBar");
  $emailBar = document.getElementById("tgxEmailBar");

  /* Replay stored messages if session was restored */
  if (sessionRestored && msgs.length > 0) {
    var storedMsgs = msgs.slice();
    msgs = []; /* clear so addMsg re-pushes them */
    storedMsgs.forEach(function(m) {
      if (m.role === "widget") {
        /* "content" is the descriptor object — pass through as text param */
        addMsg("widget", m.content, false);
      } else if (m.blocks && Array.isArray(m.blocks) && m.blocks.length > 0) {
        /* v2: restore with blocks intact */
        addMsg(m.role, m.content, false, m.original, null, m.blocks);
      } else {
        addMsg(m.role, m.content, false, m.original);
      }
    });
    if (currentScreen === "chat") {
      document.getElementById("tgxChatScreen").classList.remove("hidden");
      document.getElementById("tgxHomeScreen").classList.add("hidden");
    }
  }

  $send.addEventListener("click", handleSend);
  $input.addEventListener("keydown", function(e){
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (liveMode && chatChannel) chatChannel.publish("typing", {from: "visitor"});
  });

  document.getElementById("tgxHuman").addEventListener("click", escalateToHuman);
  document.getElementById("tgxLeave").addEventListener("click", showLeaveOverlay);
  document.getElementById("tgxEmailLink").addEventListener("click", handleEmailChat);

  /* Home screen nav */
  document.getElementById("tgxBackHome").addEventListener("click", switchToHome);
  document.getElementById("tgxDemotedHuman").addEventListener("click", function(){ switchToChat(); escalateToHuman(); });
  document.getElementById("tgxDemotedLeave").addEventListener("click", function(){ switchToChat(); showLeaveOverlay(); });

  // v2.1: send icon for home input
  var homeSendBtn = document.getElementById("tgxHomeSend");
  if (homeSendBtn) {
    homeSendBtn.innerHTML = svgIcon("send", 16, "#fff");
  }

  // v2.1: home-screen input wiring — same flow as chat-screen input
  var homeInput = document.getElementById("tgxHomeInput");
  function submitHome() {
    if (!homeInput) return;
    var t = homeInput.value.trim();
    if (!t) return;
    cancelAutoTrigger();
    homeInput.value = "";
    switchToChat();
    sendToAI(t);
  }
  if (homeSendBtn) homeSendBtn.addEventListener("click", submitHome);
  if (homeInput) homeInput.addEventListener("keydown", function(e) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitHome(); }
  });

  /* Voice input — Web Speech API, free, no infrastructure */
  initVoiceInput();

  /* Open/close */
  // Track whether the widget is currently in expanded mode.
  var expandedMode = false;
  // Track whether we've already greeted with a contextual opener this session.
  var contextualOpenerSent = false;

  function openChat(opts) {
    opts = opts || {};
    cancelAutoTrigger();
    panelOpen = true;
    // Always refresh page context on open — visitor may have navigated.
    _currentPageContext = gatherPageContext();
    if (opts.expanded) {
      expandedMode = true;
      $panel.classList.add("expanded");
      // Expanded mode skips the home screen — drop visitor straight into chat.
      // switchToChat() handles startChat() if msgs is empty.
      switchToChat();
    }
    $panel.classList.add("open");
    $fab.classList.add("open");
    unread = 0;
    $badge.style.display = "none";
    if (!nameCollected && C.collectName) {
      showNameOverlay();
    }
    // If expanded mode AND no prior chat AND no contextual opener fired yet,
    // request a contextual opener from the backend. By now startChat() has
    // run (via switchToChat above) so there's exactly one welcome bubble
    // in the DOM that we can replace once the contextual reply arrives.
    if (opts.expanded && !contextualOpenerSent && msgs.length <= 1) {
      requestContextualOpener();
    }
  }
  function closeChat() {
    panelOpen = false;
    $panel.classList.remove("open");
    $fab.classList.remove("open");
  }

  function toggleExpanded() {
    expandedMode = !expandedMode;
    $panel.classList.toggle("expanded", expandedMode);
    // Update icon
    var btn = document.getElementById("tgxExpandBtn");
    if (btn) {
      btn.title = expandedMode ? "Shrink window" : "Expand window";
      btn.setAttribute("aria-label", expandedMode ? "Shrink window" : "Expand window");
    }
    // If user manually expanded BEFORE any chat happened, fire contextual opener.
    // Treat this the same as opening in expanded mode — user is signalling they
    // want a richer conversation.
    if (expandedMode && !contextualOpenerSent && msgs.length <= 1) {
      // Make sure we're on chat screen — manual expand from home screen should
      // jump to chat too.
      if (currentScreen !== "chat") switchToChat();
      // Refresh page context in case visitor has navigated.
      _currentPageContext = gatherPageContext();
      requestContextualOpener();
    }
  }

  /* Request a contextual opener from the backend by sending the page context
     with a special flag. We send it via the regular fetch (not streaming)
     since we want one short greeting line, not a full response. */
  // PHASE_3_6_HIGHLIGHTS — fetch and render the storyboard card.
  // Fires after the contextual opener has updated the greeting, but only
  // when in expanded mode. Independent of the opener: if the card fails,
  // the chat works normally.
  var highlightsCardRequested = false;
  function requestHighlightsCard(fallbackPills) {
    if (highlightsCardRequested) return;
    if (!_currentPageContext || !_currentPageContext.title) return;
    if (!expandedMode) return; /* only in expanded mode */
    highlightsCardRequested = true;

    function applyFallback() {
      if (fallbackPills && fallbackPills.length) {
        clearPills();
        showPills(fallbackPills, function(pill) { sendToAI(pill); });
      }
    }

    var endpoint = C.endpoint.replace(/\/api\/luna-chat\b.*$/, '/api/highlights-card');
    fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        clientName: C.clientName,
        pageContext: _currentPageContext
      })
    }).then(function(r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function(data) {
      if (!data || !data.items || !data.items.length) {
        applyFallback();
        return;
      }
      renderHighlightsCard(data);
    }).catch(function(e) {
      console.warn('Luna highlights card failed:', e && e.message);
      applyFallback();
    });
  }

  function renderHighlightsCard(data) {
    if (!$msgs) return;
    // Build the card DOM (no innerHTML for content — render as DOM nodes for XSS safety)
    var card = document.createElement('div');
    card.className = 'tgx-hl-card';

    // Hero
    var hero = document.createElement('div');
    hero.className = 'tgx-hl-hero';
    if (data.photo && data.photo.url) {
      var img = document.createElement('img');
      img.src = data.photo.url;
      img.alt = (data.heroTitle || '') + (data.photo.photographer ? ' — photo by ' + data.photo.photographer : '');
      img.loading = 'eager';
      hero.appendChild(img);
    }
    var heroText = document.createElement('div');
    heroText.className = 'tgx-hl-hero-text';
    if (data.heroEyebrow) {
      var hEyebrow = document.createElement('div');
      hEyebrow.className = 'tgx-hl-eyebrow';
      hEyebrow.textContent = data.heroEyebrow;
      heroText.appendChild(hEyebrow);
    }
    if (data.heroTitle) {
      var hTitle = document.createElement('div');
      hTitle.className = 'tgx-hl-title';
      hTitle.textContent = data.heroTitle;
      heroText.appendChild(hTitle);
    }
    hero.appendChild(heroText);
    if (data.photo && data.photo.photographer && data.photo.source) {
      var credit = document.createElement('div');
      credit.className = 'tgx-hl-credit';
      credit.textContent = 'Photo: ' + data.photo.photographer + ' / ' + data.photo.source;
      hero.appendChild(credit);
    }
    card.appendChild(hero);

    // Items
    var itemsWrap = document.createElement('div');
    itemsWrap.className = 'tgx-hl-items';
    var itemEls = [];
    (data.items || []).slice(0, 4).forEach(function(it) {
      var row = document.createElement('div');
      row.className = 'tgx-hl-item';
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');

      var icon = document.createElement('div');
      icon.className = 'tgx-hl-icon';
      icon.textContent = it.icon || '✨';
      row.appendChild(icon);

      var content = document.createElement('div');
      content.className = 'tgx-hl-item-content';
      if (it.eyebrow) {
        var iEyebrow = document.createElement('div');
        iEyebrow.className = 'tgx-hl-item-eyebrow';
        iEyebrow.textContent = it.eyebrow;
        content.appendChild(iEyebrow);
      }
      if (it.headline) {
        var iHead = document.createElement('div');
        iHead.className = 'tgx-hl-item-h';
        iHead.textContent = it.headline;
        content.appendChild(iHead);
      }
      if (it.description) {
        var iDesc = document.createElement('div');
        iDesc.className = 'tgx-hl-item-d';
        iDesc.textContent = it.description;
        content.appendChild(iDesc);
      }
      row.appendChild(content);

      var arrow = document.createElement('div');
      arrow.className = 'tgx-hl-arrow';
      arrow.textContent = '→';
      row.appendChild(arrow);

      // Click sends "Tell me more about [headline]" as a user message
      var prompt = 'Tell me more about ' + (it.headline || it.eyebrow || 'this');
      row.addEventListener('click', function() { sendToAI(prompt); });
      row.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sendToAI(prompt); }
      });

      itemsWrap.appendChild(row);
      itemEls.push(row);
    });
    card.appendChild(itemsWrap);

    // Footer pills
    if (Array.isArray(data.pills) && data.pills.length) {
      var footer = document.createElement('div');
      footer.className = 'tgx-hl-footer';
      data.pills.slice(0, 4).forEach(function(p) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tgx-hl-pill';
        btn.textContent = p;
        btn.addEventListener('click', function() { sendToAI(p); });
        footer.appendChild(btn);
      });
      card.appendChild(footer);
    }

    $msgs.appendChild(card);
    if ($msgs.scrollTo) {
      $msgs.scrollTo({ top: $msgs.scrollHeight, behavior: 'smooth' });
    } else {
      $msgs.scrollTop = $msgs.scrollHeight;
    }

    // Trigger reveal animation. Card fades/rises in, then items stagger.
    requestAnimationFrame(function() {
      card.classList.add('tgx-hl-in');
      itemEls.forEach(function(el, i) {
        setTimeout(function() {
          el.classList.add('tgx-hl-in');
        }, 250 + (i * 150));
      });
    });
  }

  function requestContextualOpener() {
    if (contextualOpenerSent) return;
    if (!_currentPageContext || !_currentPageContext.title) return;
    contextualOpenerSent = true;
    fetch(C.endpoint, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({
        clientName: C.clientName,
        convId: convId,
        history: [],
        pageContext: _currentPageContext,
        page: _currentPageContext.path,
        openerRequest: true,
        stream: false
      })
    }).then(function(r) {
      if (!r.ok) return null;
      return r.json();
    }).then(function(data) {
      if (!data || !data.reply) return;
      // Replace the generic welcome bubble with the contextual one. We do this
      // gently — if the visitor has already interacted, we just add the
      // contextual opener as an additional message.
      var bubbleUpdated = false;
      if (msgs.length === 1 && msgs[0].role === "bot") {
        // Update the existing welcome bubble
        var bubbles = $msgs.querySelectorAll('.tgx-msg.bot');
        if (bubbles.length >= 1) {
          // Use the LAST .tgx-msg.bot (in case there are non-message bot-styled elements)
          var bubble = bubbles[bubbles.length - 1];
          bubble.textContent = '';
          renderSafeMarkdown(bubble, data.reply);
          msgs[0].content = data.reply;
          bubbleUpdated = true;
        }
      }
      if (!bubbleUpdated) {
        // Visitor has interacted already, or DOM structure unexpected — append
        // as an additional bot message rather than overwriting.
        addMsg("bot", data.reply);
      }
      // Phase 3: contextual discover-mode pills under the greeting.
      // One-shot — clicking removes all, sends as user message.
      // PHASE_3_6_HIGHLIGHTS: in expanded mode, the card has its own pills,
      // so we defer pill display until we know whether the card loaded.
      // If the card succeeds, its own footer pills cover the same ground.
      // If the card fails, we fall back to showing the opener pills.
      var openerPills = (data.pills && Array.isArray(data.pills) && data.pills.length > 0)
        ? data.pills : null;

      if (!expandedMode && openerPills) {
        clearPills();
        showPills(openerPills, function(pill) {
          sendToAI(pill);
        });
      }
      // PHASE_3_6_HIGHLIGHTS: fire the highlights card request right after
      // the opener completes (only in expanded mode). Pass the opener pills
      // as a fallback in case the card fails.
      if (expandedMode) {
        setTimeout(function() {
          requestHighlightsCard(openerPills);
        }, 350);
      }
    }).catch(function(e) {
      console.warn("Luna contextual opener failed:", e && e.message);
    });
  }

  document.getElementById("tgxHomeClose").addEventListener("click", closeChat);
  document.getElementById("tgxChatClose").addEventListener("click", closeChat);
  // Expand toggle button — present in chat header only (hidden on mobile)
  var _expBtn = document.getElementById("tgxExpandBtn");
  if (_expBtn) _expBtn.addEventListener("click", toggleExpanded);

  $fab.addEventListener("click", function(){
    if (panelOpen) closeChat(); else openChat();
  });

  window.openLunaChat = openChat;
  window.closeLunaChat = closeChat;
  window.expandLunaChat = function() {
    openChat({ expanded: true });
  };

  // Phase 3 trigger — clicking any element with data-luna-expanded="true"
  // opens the widget in expanded mode with a contextual opener.
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.getAttribute && el.getAttribute('data-luna-expanded') === 'true') {
        e.preventDefault();
        e.stopPropagation();
        window.expandLunaChat();
        return;
      }
      el = el.parentElement;
    }
  });

  // luna=expanded trigger — opens expanded mode on page load.
  // We check BOTH the query string (?luna=expanded) and the hash fragment
  // (#luna=expanded). Hash fragments survive server-side redirects because
  // they are never sent to the server, so they work on sites where the CMS
  // strips query strings (e.g. via a 301/302 to a clean URL).
  try {
    var _params = new URLSearchParams(window.location.search);
    var _hashStr = (window.location.hash || '').replace(/^#/, '');
    var _hashParams = new URLSearchParams(_hashStr);
    if (_params.get('luna') === 'expanded' || _hashParams.get('luna') === 'expanded') {
      setTimeout(function() { window.expandLunaChat(); }, 800);
    }
  } catch(e) { /* no URLSearchParams in very old browsers — ignore */ }

  loadAbly(function(){ initAbly(); });

  /* Auto-trigger */
  var at = C.autoTrigger;
  if (at && at.enabled && at.delay && at.message) {
    var alreadyTriggered = false;
    try { alreadyTriggered = sessionStorage.getItem("luna_auto_triggered") === "1"; } catch(e) {}
    var isMobileHidden = C.mobileBubble === "hidden" && window.innerWidth < 440;

    if (!alreadyTriggered && !isMobileHidden) {
      autoTriggerTimer = setTimeout(function() {
        if (visitorInteracted || panelOpen || msgs.length > 0 || autoTriggered) return;
        autoTriggered = true;
        try { sessionStorage.setItem("luna_auto_triggered", "1"); } catch(e) {}

        panelOpen = true;
        $panel.classList.add("open");
        $fab.classList.add("open");

        if (!nameCollected) nameCollected = true;
        switchToChat();
        addMsg("bot", at.message);
        if (C.hints && C.hints.length > 0) showPills(C.hints, function(h){ sendToAI(h); });
        if (!document.hidden) playNotifSound();
      }, at.delay * 1000);
    }
  }
}

/* Run on DOM ready */
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}

})();
