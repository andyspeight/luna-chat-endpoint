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

  // Image (optional, validated)
  if (props.image) {
    const imgWrap = el('div', 'luna-dest-img');
    const img = document.createElement('img');
    img.src = safeUrl(props.image);
    img.alt = ''; // decorative; name is below
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    imgWrap.appendChild(img);
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
    const link = document.createElement('a');
    link.className = 'luna-btn luna-btn-primary';
    link.href = safeUrl(props.deepLink);
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'See deals';
    link.appendChild(iconNode('arrow-right'));
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
    const book = document.createElement('a');
    book.className = 'luna-btn luna-btn-primary';
    book.href = safeUrl(props.bookUrl);
    book.target = '_blank';
    book.rel = 'noopener noreferrer';
    book.textContent = 'Book';
    book.appendChild(iconNode('arrow-right'));
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

// ─────────── DISPATCH ───────────

const RENDERERS = {
  destination_card:    renderDestinationCard,
  offer_card:          renderOfferCard,
  faq_policy_card:     renderFaqPolicyCard,
  booking_lookup_card: renderBookingLookupCard,
  human_handoff_card:  renderHumanHandoffCard,
  emergency_card:      renderEmergencyCard,
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

const exports_ = {
  renderBlock,
  renderItems,
  safeUrl,
  // Exposed for tests / debugging
  _RENDERERS: RENDERERS,
  _ICONS: ICONS
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exports_;
}
if (typeof window !== 'undefined') {
  window.LunaBlockRenderers = exports_;
}
