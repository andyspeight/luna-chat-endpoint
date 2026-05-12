/**
 * Luna Card Library
 * ─────────────────
 * Single source of truth for the 20 landing-card catalogue.
 * Each card defines:
 *   - id         stable string used in client config (NEVER change once shipped)
 *   - name       default visible title (clients can override)
 *   - description default body line (clients can override)
 *   - intent     the Luna mode triggered when the card is tapped
 *   - icon       lucide icon name
 *   - iconColour token name → maps to a CSS class in the widget
 *   - bucket     for grouping in the editor library picker
 *
 * To add a new card: append to CARD_LIBRARY. Never reorder or rename existing IDs.
 *
 * Spec ref: luna-chat-v2-spec.md §2
 */

const CARD_LIBRARY = [
  // ─────────── DESTINATIONS & INSPIRATION ───────────
  {
    id: 'find_holiday',
    name: 'Find a holiday',
    description: "Tell me your dates and vibe — I'll suggest something that fits.",
    intent: 'destination_search',
    icon: 'map-pin',
    iconColour: 'c-dest',
    bucket: 'destinations'
  },
  {
    id: 'browse_offers',
    name: 'Browse our offers',
    description: "This week's best-value deals, hand-picked.",
    intent: 'view_offers',
    icon: 'tag',
    iconColour: 'c-dest',
    bucket: 'destinations'
  },
  {
    id: 'resort_guides',
    name: 'Resort guides',
    description: 'Local know-how on the resorts we love.',
    intent: 'resort_guide',
    icon: 'book-open',
    iconColour: 'c-dest',
    bucket: 'destinations'
  },
  {
    id: 'inspire_me',
    name: 'Inspire me',
    description: "Not sure where to go? Let's find something brilliant.",
    intent: 'inspiration',
    icon: 'sparkles',
    iconColour: 'c-dest',
    bucket: 'destinations'
  },
  {
    id: 'compare_destinations',
    name: 'Compare destinations',
    description: "Crete vs Rhodes? Cyprus vs Turkey? I'll lay them out side-by-side.",
    intent: 'compare',
    icon: 'bar-chart-2',
    iconColour: 'c-dest',
    bucket: 'destinations'
  },

  // ─────────── BOOKING & POST-SALE ───────────
  {
    id: 'my_booking',
    name: 'My booking',
    description: 'Check details, dates, balance due, documents.',
    intent: 'booking_lookup',
    icon: 'calendar',
    iconColour: 'c-book',
    bucket: 'booking'
  },
  {
    id: 'pay_balance',
    name: 'Pay a balance',
    description: 'Settle up before your trip.',
    intent: 'pay_balance',
    icon: 'credit-card',
    iconColour: 'c-book',
    bucket: 'booking'
  },
  {
    id: 'booking_addons',
    name: 'Add to my booking',
    description: 'Transfers, baggage, room upgrades, excursions.',
    intent: 'booking_addons',
    icon: 'plus-circle',
    iconColour: 'c-book',
    bucket: 'booking'
  },
  {
    id: 'documents',
    name: 'Travel documents',
    description: 'Tickets, vouchers, ATOL certificates.',
    intent: 'documents',
    icon: 'file-text',
    iconColour: 'c-book',
    bucket: 'booking'
  },
  {
    id: 'booking_change',
    name: 'Make a change',
    description: "Dates, names, party size — see what's possible.",
    intent: 'booking_change',
    icon: 'edit-3',
    iconColour: 'c-book',
    bucket: 'booking'
  },

  // ─────────── PRACTICAL & SUPPORT ───────────
  {
    id: 'visa_passport',
    name: 'Visa & passport',
    description: 'Entry rules and validity by country.',
    intent: 'visa_passport',
    icon: 'file-check',
    iconColour: 'c-info',
    bucket: 'practical'
  },
  {
    id: 'travel_advice',
    name: 'Travel advice',
    description: 'Latest FCDO guidance and safety info.',
    intent: 'travel_advice',
    icon: 'shield',
    iconColour: 'c-info',
    bucket: 'practical'
  },
  {
    id: 'baggage_airline',
    name: 'Baggage & airlines',
    description: 'Allowances, seat selection, check-in.',
    intent: 'baggage_airline',
    icon: 'briefcase',
    iconColour: 'c-info',
    bucket: 'practical'
  },
  {
    id: 'insurance',
    name: 'Insurance',
    description: "What's covered, what isn't, how to claim.",
    intent: 'insurance',
    icon: 'umbrella',
    iconColour: 'c-info',
    bucket: 'practical'
  },
  {
    id: 'cancellation',
    name: 'Cancellation & refunds',
    description: 'Our policies, your rights, the process.',
    intent: 'cancellation_policy',
    icon: 'refresh-cw',
    iconColour: 'c-info',
    bucket: 'practical'
  },
  {
    id: 'health_vaccinations',
    name: 'Health & vaccinations',
    description: 'What you need before you travel.',
    intent: 'health_vaccinations',
    icon: 'heart-pulse',
    iconColour: 'c-info',
    bucket: 'practical'
  },

  // ─────────── HUMAN CONTACT ───────────
  {
    id: 'speak_expert',
    name: 'Speak to an expert',
    description: 'Real human, real fast — book a callback or chat.',
    intent: 'handoff_callback',
    icon: 'message-square',
    iconColour: 'c-human',
    bucket: 'human'
  },
  {
    id: 'find_branch',
    name: 'Find a branch',
    description: 'Pop in for a chat, find your nearest one.',
    intent: 'find_branch',
    icon: 'map',
    iconColour: 'c-human',
    bucket: 'human'
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp us',
    description: 'Quick message, instant reply during opening hours.',
    intent: 'whatsapp',
    icon: 'message-circle',
    iconColour: 'c-human',
    bucket: 'human'
  },
  {
    id: 'emergency',
    name: 'Out-of-hours emergency',
    description: "If you're already on holiday and something's gone wrong.",
    intent: 'emergency_contact',
    icon: 'phone',
    iconColour: 'c-human',
    bucket: 'human'
  }
];

/**
 * Starter packs — preset card configurations per client type.
 * Used by the editor to give new clients a one-click sensible default.
 */
const STARTER_PACKS = {
  'Tour Operator': ['find_holiday', 'browse_offers', 'my_booking', 'speak_expert'],
  'Travel Agent': ['find_holiday', 'my_booking', 'cancellation', 'speak_expert'],
  'Homeworker':   ['speak_expert', 'find_holiday', 'my_booking', 'whatsapp'],
  'Specialist':   ['resort_guides', 'inspire_me', 'speak_expert', 'my_booking']
};

const DEFAULT_STARTER_PACK = 'Travel Agent';

/**
 * Default landing copy. Used when client hasn't set their own.
 * The asterisks wrap the accent-italic word.
 */
const DEFAULT_GREETING = 'Hi there — how can I *help*?';
const DEFAULT_SUB_GREETING =
  "I'm Luna. Whether you're researching a holiday, managing an existing booking, or just have a quick question — I'm here.";

/**
 * Validation constraints — mirrored in the editor UI and the API.
 */
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

/** Look up a card by ID. Returns undefined if not in the library. */
function getCard(id) {
  return CARD_LIBRARY.find(c => c.id === id);
}

/** Filter library by bucket — used by the "Add card" picker in the editor. */
function getCardsByBucket(bucket) {
  return CARD_LIBRARY.filter(c => c.bucket === bucket);
}

/**
 * Resolve a client's chosen card IDs into renderable card objects,
 * applying any per-card overrides the client has set in cardOverrides.
 *
 * @param {string[]} chosenIds   from client.landingCards
 * @param {object}   overrides   from client.cardOverrides ({ [id]: { name?, description? } })
 * @returns {Array}  Card objects ready to render, in order, with overrides applied.
 *                   Unknown IDs are silently dropped (forward compatibility).
 */
function resolveLandingCards(chosenIds, overrides = {}) {
  if (!Array.isArray(chosenIds)) return [];
  return chosenIds
    .map(id => {
      const base = getCard(id);
      if (!base) return null; // unknown ID — skip
      const o = overrides[id] || {};
      return {
        ...base,
        name: o.name || base.name,
        description: o.description || base.description
      };
    })
    .filter(Boolean);
}

/** Returns the card IDs for a given starter pack, or null. */
function getStarterPackCards(packName) {
  return STARTER_PACKS[packName] || null;
}

/**
 * Detect whether a client's current landingCards match a known starter pack
 * (order-sensitive). Used by the editor to show "Travel Agent" vs "Custom".
 */
function detectStarterPack(chosenIds) {
  if (!Array.isArray(chosenIds)) return 'Custom';
  for (const [name, cards] of Object.entries(STARTER_PACKS)) {
    if (
      cards.length === chosenIds.length &&
      cards.every((id, i) => id === chosenIds[i])
    ) {
      return name;
    }
  }
  return 'Custom';
}

/**
 * Validate a landing config before saving. Returns { ok, errors: [] }.
 */
function validateLandingConfig({
  landingCards,
  cardOverrides,
  landingGreeting,
  landingSubGreeting,
  suggestedPrompts
}) {
  const errors = [];

  if (!Array.isArray(landingCards)) {
    errors.push('landingCards must be an array');
  } else {
    if (landingCards.length < CONSTRAINTS.minCards) {
      errors.push(`At least ${CONSTRAINTS.minCards} cards required`);
    }
    if (landingCards.length > CONSTRAINTS.maxCards) {
      errors.push(`No more than ${CONSTRAINTS.maxCards} cards allowed`);
    }
    landingCards.forEach(id => {
      if (!getCard(id)) errors.push(`Unknown card ID: ${id}`);
    });
  }

  if (cardOverrides && typeof cardOverrides === 'object') {
    Object.entries(cardOverrides).forEach(([id, o]) => {
      if (o.name && o.name.length > CONSTRAINTS.titleOverrideMax) {
        errors.push(`Title override for "${id}" exceeds ${CONSTRAINTS.titleOverrideMax} chars`);
      }
      if (o.description && o.description.length > CONSTRAINTS.descriptionOverrideMax) {
        errors.push(`Description override for "${id}" exceeds ${CONSTRAINTS.descriptionOverrideMax} chars`);
      }
    });
  }

  if (landingGreeting && landingGreeting.length > CONSTRAINTS.greetingMax) {
    errors.push(`Greeting exceeds ${CONSTRAINTS.greetingMax} chars`);
  }
  if (landingSubGreeting && landingSubGreeting.length > CONSTRAINTS.subGreetingMax) {
    errors.push(`Sub-greeting exceeds ${CONSTRAINTS.subGreetingMax} chars`);
  }

  if (suggestedPrompts) {
    if (!Array.isArray(suggestedPrompts)) {
      errors.push('suggestedPrompts must be an array');
    } else if (suggestedPrompts.length > CONSTRAINTS.maxPrompts) {
      errors.push(`No more than ${CONSTRAINTS.maxPrompts} prompts allowed`);
    }
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Resolve final landing state for rendering — pulls defaults where client has nothing set.
 *
 * @param {object} client  the client record from Airtable
 * @returns {object}       { cards, greeting, subGreeting, prompts }
 */
function buildLandingState(client) {
  let chosenIds;
  try {
    chosenIds = client.landingCards ? JSON.parse(client.landingCards) : null;
  } catch (e) {
    chosenIds = null;
  }
  // Fall back to default starter pack if client has no config
  if (!chosenIds || chosenIds.length === 0) {
    chosenIds = STARTER_PACKS[DEFAULT_STARTER_PACK];
  }

  let overrides = {};
  try {
    overrides = client.cardOverrides ? JSON.parse(client.cardOverrides) : {};
  } catch (e) {
    overrides = {};
  }

  let prompts = [];
  try {
    prompts = client.suggestedPrompts ? JSON.parse(client.suggestedPrompts) : [];
  } catch (e) {
    prompts = [];
  }

  return {
    cards: resolveLandingCards(chosenIds, overrides),
    greeting: client.landingGreeting || DEFAULT_GREETING,
    subGreeting: client.landingSubGreeting || DEFAULT_SUB_GREETING,
    prompts: pickRandom(prompts, 3),
    emergencyPhone: client.emergencyPhone || null
  };
}

/** Shuffle and take first N (for rotating suggested prompts). */
function pickRandom(arr, n) {
  if (!Array.isArray(arr) || arr.length <= n) return arr || [];
  const shuffled = [...arr].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, n);
}

// ESM + CommonJS exports
const exports_ = {
  CARD_LIBRARY,
  STARTER_PACKS,
  DEFAULT_STARTER_PACK,
  DEFAULT_GREETING,
  DEFAULT_SUB_GREETING,
  CONSTRAINTS,
  getCard,
  getCardsByBucket,
  resolveLandingCards,
  getStarterPackCards,
  detectStarterPack,
  validateLandingConfig,
  buildLandingState
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exports_;
}
if (typeof window !== 'undefined') {
  window.LunaCardLibrary = exports_;
}
