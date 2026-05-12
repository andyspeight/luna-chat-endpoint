/**
 * Luna Card Library
 * ─────────────────
 * Single source of truth for the 20 landing-card catalogue.
 *
 * IMPORTANT — Airtable mapping (verified live 12 May 2026):
 *   - Cards JSON   → CapabilityCards (Long text, JSON array)
 *   - Greeting     → WidgetWelcome (Single line text)
 *   - Sub-greeting → WidgetTagline (Single line text)
 *   - Prompts      → WidgetHints (Long text, one per line)
 *   - Business     → BusinessType (singleSelect) / BusinessTypes (multi)
 *   - Emergency    → EmergencyPhone (Phone number)
 *
 * The CapabilityCards field already exists with a legacy shape:
 *   { icon, title, desc }
 * We extend to:
 *   { id, icon, title, desc, intent }
 * Cards saved by this code include id+intent. Legacy cards without id keep
 * working — Luna falls back to using the title as the prompt.
 *
 * To add a new card: append to CARD_LIBRARY. Never reorder or rename existing IDs.
 *
 * Spec ref: luna-chat-v2-spec.md §2
 */

const CARD_LIBRARY = [
  // ─────────── DESTINATIONS & INSPIRATION ───────────
  { id: 'find_holiday',         name: 'Find a holiday',         description: "Tell me your dates and vibe — I'll suggest something that fits.", intent: 'destination_search',  icon: 'map-pin',      iconColour: 'c-dest',  bucket: 'destinations' },
  { id: 'browse_offers',        name: 'Browse our offers',      description: "This week's best-value deals, hand-picked.",                       intent: 'view_offers',         icon: 'tag',          iconColour: 'c-dest',  bucket: 'destinations' },
  { id: 'resort_guides',        name: 'Resort guides',          description: 'Local know-how on the resorts we love.',                           intent: 'resort_guide',        icon: 'book-open',    iconColour: 'c-dest',  bucket: 'destinations' },
  { id: 'inspire_me',           name: 'Inspire me',             description: "Not sure where to go? Let's find something brilliant.",            intent: 'inspiration',         icon: 'sparkles',     iconColour: 'c-dest',  bucket: 'destinations' },
  { id: 'compare_destinations', name: 'Compare destinations',   description: "Crete vs Rhodes? Cyprus vs Turkey? I'll lay them out side-by-side.", intent: 'compare',          icon: 'bar-chart-2',  iconColour: 'c-dest',  bucket: 'destinations' },

  // ─────────── BOOKING & POST-SALE ───────────
  { id: 'my_booking',     name: 'My booking',         description: 'Check details, dates, balance due, documents.',                intent: 'booking_lookup',  icon: 'calendar',     iconColour: 'c-book', bucket: 'booking' },
  { id: 'pay_balance',    name: 'Pay a balance',      description: 'Settle up before your trip.',                                   intent: 'pay_balance',     icon: 'credit-card',  iconColour: 'c-book', bucket: 'booking' },
  { id: 'booking_addons', name: 'Add to my booking',  description: 'Transfers, baggage, room upgrades, excursions.',                intent: 'booking_addons',  icon: 'plus-circle',  iconColour: 'c-book', bucket: 'booking' },
  { id: 'documents',      name: 'Travel documents',   description: 'Tickets, vouchers, ATOL certificates.',                         intent: 'documents',       icon: 'file-text',    iconColour: 'c-book', bucket: 'booking' },
  { id: 'booking_change', name: 'Make a change',      description: "Dates, names, party size — see what's possible.",               intent: 'booking_change',  icon: 'edit-3',       iconColour: 'c-book', bucket: 'booking' },

  // ─────────── PRACTICAL & SUPPORT ───────────
  { id: 'visa_passport',        name: 'Visa & passport',        description: 'Entry rules and validity by country.',           intent: 'visa_passport',         icon: 'file-check',  iconColour: 'c-info', bucket: 'practical' },
  { id: 'travel_advice',        name: 'Travel advice',          description: 'Latest FCDO guidance and safety info.',          intent: 'travel_advice',         icon: 'shield',      iconColour: 'c-info', bucket: 'practical' },
  { id: 'baggage_airline',      name: 'Baggage & airlines',     description: 'Allowances, seat selection, check-in.',          intent: 'baggage_airline',       icon: 'briefcase',   iconColour: 'c-info', bucket: 'practical' },
  { id: 'insurance',            name: 'Insurance',              description: "What's covered, what isn't, how to claim.",      intent: 'insurance',             icon: 'umbrella',    iconColour: 'c-info', bucket: 'practical' },
  { id: 'cancellation',         name: 'Cancellation & refunds', description: 'Our policies, your rights, the process.',        intent: 'cancellation_policy',   icon: 'refresh-cw',  iconColour: 'c-info', bucket: 'practical' },
  { id: 'health_vaccinations',  name: 'Health & vaccinations',  description: 'What you need before you travel.',               intent: 'health_vaccinations',   icon: 'heart-pulse', iconColour: 'c-info', bucket: 'practical' },

  // ─────────── HUMAN CONTACT ───────────
  { id: 'speak_expert', name: 'Speak to an expert',     description: 'Real human, real fast — book a callback or chat.',           intent: 'handoff_callback',  icon: 'message-square',  iconColour: 'c-human', bucket: 'human' },
  { id: 'find_branch',  name: 'Find a branch',          description: 'Pop in for a chat, find your nearest one.',                  intent: 'find_branch',       icon: 'map',             iconColour: 'c-human', bucket: 'human' },
  { id: 'whatsapp',     name: 'WhatsApp us',            description: 'Quick message, instant reply during opening hours.',         intent: 'whatsapp',          icon: 'message-circle',  iconColour: 'c-human', bucket: 'human' },
  { id: 'emergency',    name: 'Out-of-hours emergency', description: "If you're already on holiday and something's gone wrong.",   intent: 'emergency_contact', icon: 'phone',           iconColour: 'c-human', bucket: 'human' }
];

/**
 * Starter packs — keyed by Airtable BusinessType options.
 * Matches the 9 options live in field fldxLNsvxmrEXeRQN.
 */
const STARTER_PACKS = {
  'Travel Agent':          ['find_holiday', 'my_booking', 'cancellation', 'speak_expert'],
  'Tour Operator':         ['find_holiday', 'browse_offers', 'my_booking', 'speak_expert'],
  'Cruise Specialist':     ['inspire_me', 'resort_guides', 'my_booking', 'speak_expert'],
  'Ski Specialist':        ['resort_guides', 'inspire_me', 'my_booking', 'speak_expert'],
  'Car Rental':            ['find_holiday', 'my_booking', 'booking_change', 'speak_expert'],
  'Tickets & Attractions': ['inspire_me', 'my_booking', 'booking_change', 'speak_expert'],
  'Corporate Travel':      ['my_booking', 'documents', 'booking_change', 'speak_expert'],
  'B2B / Tech':            ['find_holiday', 'speak_expert', 'compare_destinations', 'browse_offers'],
  'Custom':                null
};

const DEFAULT_STARTER_PACK = 'Travel Agent';

const DEFAULT_GREETING = 'Hi there — how can I *help*?';
const DEFAULT_SUB_GREETING =
  "I'm Luna. Whether you're researching a holiday, managing an existing booking, or just have a quick question — I'm here.";

const CONSTRAINTS = {
  minCards: 2,
  maxCards: 6,
  maxPrompts: 10,
  greetingMax: 60,
  subGreetingMax: 200,
  titleOverrideMax: 30,
  descriptionOverrideMax: 80
};

// ─────────── HELPERS ───────────

function getCard(id) {
  return CARD_LIBRARY.find(c => c.id === id);
}

function getCardsByBucket(bucket) {
  return CARD_LIBRARY.filter(c => c.bucket === bucket);
}

/**
 * Resolve a stored CapabilityCards array into renderable cards.
 *
 * Handles three shapes:
 *  1. New format: { id, icon, title, desc, intent }  →  hydrate from library
 *  2. New format with title/desc overrides           →  hydrate, then override
 *  3. Legacy format: { icon, title, desc }           →  pass through, intent=null
 */
function resolveStoredCards(storedCards) {
  if (!Array.isArray(storedCards)) return [];

  return storedCards
    .map(stored => {
      // Legacy card — no id field
      if (!stored.id) {
        return {
          id: null,
          name: stored.title || '',
          description: stored.desc || '',
          icon: stored.icon || 'help-circle',
          iconColour: 'c-info',
          intent: null,
          bucket: null,
          legacy: true
        };
      }

      // New-format card — hydrate from library
      const base = getCard(stored.id);
      if (!base) return null; // unknown ID, drop

      return {
        ...base,
        name: stored.title || base.name,
        description: stored.desc || base.description,
        icon: stored.icon || base.icon
      };
    })
    .filter(Boolean);
}

function getStarterPackCards(packName) {
  return STARTER_PACKS[packName] || null;
}

function detectStarterPack(storedCards) {
  if (!Array.isArray(storedCards) || storedCards.length === 0) return 'Custom';
  const ids = storedCards.map(c => c.id).filter(Boolean);
  if (ids.length !== storedCards.length) return 'Custom';

  for (const [name, cards] of Object.entries(STARTER_PACKS)) {
    if (!cards) continue;
    if (cards.length === ids.length && cards.every((id, i) => id === ids[i])) {
      return name;
    }
  }
  return 'Custom';
}

function validateLandingConfig({ capabilityCards, widgetWelcome, widgetTagline, widgetHints }) {
  const errors = [];

  if (!Array.isArray(capabilityCards)) {
    errors.push('capabilityCards must be an array');
  } else {
    if (capabilityCards.length < CONSTRAINTS.minCards) {
      errors.push(`At least ${CONSTRAINTS.minCards} cards required`);
    }
    if (capabilityCards.length > CONSTRAINTS.maxCards) {
      errors.push(`No more than ${CONSTRAINTS.maxCards} cards allowed`);
    }
    capabilityCards.forEach((c, i) => {
      if (!c.title || typeof c.title !== 'string') {
        errors.push(`Card #${i + 1}: title is required`);
      } else if (c.title.length > CONSTRAINTS.titleOverrideMax) {
        errors.push(`Card #${i + 1}: title exceeds ${CONSTRAINTS.titleOverrideMax} chars`);
      }
      if (c.desc && c.desc.length > CONSTRAINTS.descriptionOverrideMax) {
        errors.push(`Card #${i + 1}: description exceeds ${CONSTRAINTS.descriptionOverrideMax} chars`);
      }
      if (c.id && !getCard(c.id)) {
        errors.push(`Card #${i + 1}: unknown card ID "${c.id}"`);
      }
    });
  }

  if (widgetWelcome && widgetWelcome.length > CONSTRAINTS.greetingMax) {
    errors.push(`Welcome exceeds ${CONSTRAINTS.greetingMax} chars`);
  }
  if (widgetTagline && widgetTagline.length > CONSTRAINTS.subGreetingMax) {
    errors.push(`Tagline exceeds ${CONSTRAINTS.subGreetingMax} chars`);
  }

  if (widgetHints) {
    const lines = typeof widgetHints === 'string'
      ? widgetHints.split('\n').map(l => l.trim()).filter(Boolean)
      : (Array.isArray(widgetHints) ? widgetHints : []);
    if (lines.length > CONSTRAINTS.maxPrompts) {
      errors.push(`No more than ${CONSTRAINTS.maxPrompts} prompts allowed`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Build the final landing state from a client's Airtable record.
 * The ONLY function that reads raw Airtable field names. Everything downstream
 * uses the normalised return shape.
 */
function buildLandingState(client) {
  let cards = [];
  let storedCards = null;

  try {
    storedCards = client.CapabilityCards ? JSON.parse(client.CapabilityCards) : null;
  } catch (e) {
    storedCards = null;
  }

  if (Array.isArray(storedCards) && storedCards.length > 0) {
    cards = resolveStoredCards(storedCards);
  } else {
    // Fall back to BusinessType-driven starter pack
    const businessType = resolveBusinessType(client);
    const packIds = STARTER_PACKS[businessType] || STARTER_PACKS[DEFAULT_STARTER_PACK];
    cards = (packIds || []).map(id => {
      const base = getCard(id);
      return base ? { ...base } : null;
    }).filter(Boolean);
  }

  let prompts = [];
  if (client.WidgetHints && typeof client.WidgetHints === 'string') {
    prompts = client.WidgetHints
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .slice(0, CONSTRAINTS.maxPrompts);
  }

  return {
    cards,
    greeting: client.WidgetWelcome || DEFAULT_GREETING,
    subGreeting: client.WidgetTagline || DEFAULT_SUB_GREETING,
    prompts: pickRandom(prompts, 3),
    emergencyPhone: client.EmergencyPhone || null,
    businessType: resolveBusinessType(client)
  };
}

/**
 * Resolve a usable BusinessType from the client record.
 * Handles Airtable's object shape and plain strings.
 */
function resolveBusinessType(client) {
  if (Array.isArray(client.BusinessTypes) && client.BusinessTypes.length > 0) {
    const first = client.BusinessTypes[0];
    return typeof first === 'string' ? first : (first.name || DEFAULT_STARTER_PACK);
  }
  if (client.BusinessType) {
    return typeof client.BusinessType === 'string'
      ? client.BusinessType
      : (client.BusinessType.name || DEFAULT_STARTER_PACK);
  }
  return DEFAULT_STARTER_PACK;
}

/**
 * Convert a runtime cards array → the JSON string written back to Airtable.
 * Strips runtime-only fields (legacy flag, bucket, intent, iconColour).
 * Persists exactly what the editor lets clients change: id, icon, title, desc.
 */
function serialiseCardsForAirtable(cards) {
  if (!Array.isArray(cards)) return '[]';
  const stripped = cards.map(c => {
    const out = {
      icon: c.icon,
      title: c.name || c.title,
      desc: c.description || c.desc
    };
    if (c.id) out.id = c.id;
    return out;
  });
  return JSON.stringify(stripped);
}

function pickRandom(arr, n) {
  if (!Array.isArray(arr) || arr.length <= n) return arr || [];
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

const exports_ = {
  CARD_LIBRARY,
  STARTER_PACKS,
  DEFAULT_STARTER_PACK,
  DEFAULT_GREETING,
  DEFAULT_SUB_GREETING,
  CONSTRAINTS,
  getCard,
  getCardsByBucket,
  resolveStoredCards,
  getStarterPackCards,
  detectStarterPack,
  validateLandingConfig,
  buildLandingState,
  resolveBusinessType,
  serialiseCardsForAirtable
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exports_;
}
if (typeof window !== 'undefined') {
  window.LunaCardLibrary = exports_;
}
