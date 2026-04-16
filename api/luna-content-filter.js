/**
 * Luna Content Filter v1.0
 * ========================
 * Three-tier content safety system for Luna Chat.
 *
 * - Scans visitor messages BEFORE they reach the AI (saves cost, blocks abuse)
 * - Scans AI responses BEFORE they reach the visitor (catches anything that slips through)
 * - Handles l33t speak, spaced-out evasion, zero-width characters, and creative misspellings
 *
 * Usage:
 *   const { LunaContentFilter } = require('./luna-content-filter');
 *   const filter = new LunaContentFilter({ agentName: 'Sunshine Holidays' });
 *
 *   // Check visitor input
 *   const input = filter.classifyInput(visitorMessage);
 *   if (input.blocked) return input.deflection;
 *
 *   // Check AI output
 *   const output = filter.filterOutput(aiResponse);
 *   return output.filtered;
 */

// ─────────────────────────────────────────────
// WORD LISTS — organised by category
// ─────────────────────────────────────────────

const PROFANITY = [
  'fuck', 'fucking', 'fucked', 'fucker', 'fuckers', 'fucks', 'motherfucker',
  'motherfucking', 'shit', 'shitting', 'shitty', 'bullshit', 'horseshit',
  'cunt', 'cunts', 'cock', 'cocks', 'cocksucker', 'dick', 'dicks', 'dickhead',
  'prick', 'pricks', 'twat', 'twats', 'wanker', 'wankers', 'wank', 'tosser',
  'tossers', 'bellend', 'arsehole', 'arseholes', 'asshole', 'assholes',
  'bastard', 'bastards', 'bitch', 'bitches', 'bitchy', 'whore', 'whores',
  'slut', 'sluts', 'slag', 'slags', 'skank', 'skanks',
  'arse', 'bollocks', 'bugger', 'crap', 'crappy',
  'damn', 'damned', 'dammit', 'goddamn', 'goddammit', 'piss',
  'pissed', 'pissing', 'sodding', 'sod', 'tit', 'tits', 'knob', 'knobhead',
  'minger', 'munter', 'pillock', 'plonker',
  'stfu', 'gtfo', 'wtf', 'ffs', 'jfc'
];

const RACIAL_ETHNIC_SLURS = [
  'nigger', 'niggers', 'nigga', 'niggas', 'coon', 'coons', 'darkie',
  'darkies', 'jigaboo', 'sambo', 'golliwog', 'golliwogs',
  'pickaninny', 'jungle bunny', 'porch monkey',
  'chink', 'chinks', 'chinky', 'gook', 'gooks', 'zipperhead',
  'slanteye', 'coolie', 'coolies', 'chinaman', 'chinamen',
  'paki', 'pakis', 'curry muncher', 'dothead', 'raghead', 'ragheads',
  'towelhead', 'towelheads', 'sand nigger', 'sand niggers', 'camel jockey',
  'spic', 'spics', 'spick', 'wetback', 'wetbacks', 'beaner', 'beaners',
  'greaser', 'greasers',
  'honky', 'honkey', 'white trash', 'trailer trash',
  'hajji', 'haji', 'sandnigger',
  'kike', 'kikes', 'yid', 'yids', 'heeb', 'heebs', 'hymie', 'shylock',
  'gyppo', 'gyppos', 'pikey', 'pikeys',
  'abo', 'abos', 'boong', 'redskin', 'redskins', 'squaw',
  'go back to your country', 'send them back'
];

const HOMOPHOBIC_TRANSPHOBIC = [
  'fag', 'fags', 'faggot', 'faggots', 'dyke', 'dykes',
  'lesbo', 'lesbos', 'poof', 'poofter', 'ponce',
  'batty', 'battyboy', 'bender', 'tranny', 'trannies', 'shemale',
  'she-male', 'he-she', 'ladyboy'
];

const RELIGIOUS_DEROGATORY = [
  'bible basher', 'bible thumper', 'holy roller',
  'kafir', 'kuffar', 'papist', 'christ killer',
  'sky fairy', 'sky daddy'
];

const POLITICAL_IDEOLOGICAL = [
  'nazi', 'nazis', 'neo-nazi', 'fascist', 'fascists',
  'white supremacy', 'white supremacist', 'white power', 'white pride',
  'white nationalist', 'white genocide', 'race war', 'race traitor',
  'ethnostate', 'ethnic cleansing', 'final solution', 'holocaust denial',
  'great replacement', 'replacement theory',
  'heil hitler', 'sieg heil', '1488', '14 words',
  'blood and soil', 'deus vult', 'remove kebab',
  'kill all', 'acab', 'all cops are bastards',
  'libtard', 'conservatard', 'republitard', 'democrap',
  'woke mob', 'feminazi', 'commie', 'sheeple'
];

const VIOLENCE_THREATS = [
  'kill you', 'kill myself', 'kill yourself', 'kys',
  'i will hurt', 'i will find you', 'watch your back',
  'you will pay', 'you deserve to die', 'go die',
  'bomb threat', 'rape', 'raping', 'rapist',
  'murder', 'attack you', 'beat you up',
  'punch you', 'slap you', 'strangle'
];

const SEXUAL_CONTENT = [
  'porn', 'porno', 'pornography', 'xxx', 'nsfw', 'hentai',
  'prostitute', 'prostitution', 'escort service',
  'happy ending', 'strip club', 'stripclub', 'brothel',
  'erotic', 'orgasm', 'orgasms',
  'masturbate', 'masturbation', 'blowjob', 'blow job',
  'handjob', 'hand job', 'bondage', 'bdsm',
  'fetish', 'vibrator', 'dildo',
  'boobies', 'titties', 'nude', 'nudes',
  'horny', 'shagging'
];

const DISABILITY_ABLEIST = [
  'retard', 'retarded', 'retards', 'spaz', 'spazzy', 'spastic',
  'cripple', 'crippled', 'gimp', 'mongoloid',
  'psycho', 'psychos', 'lunatic', 'lunatics', 'nutcase',
  'nutjob', 'mental case', 'schizo', 'window licker'
];


// ─────────────────────────────────────────────
// L33T SPEAK / EVASION NORMALISATION
// ─────────────────────────────────────────────

const LEET_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's',
  '7': 't', '8': 'b', '9': 'g', '@': 'a', '$': 's',
  '!': 'i', '+': 't', '(': 'c', '|': 'l'
};

const SEPARATOR_CHARS = /[\s\-_.*·,;:!?'"\/\\()[\]{}#~^`+=<>@$%&|]+/g;

function normalise(text) {
  if (!text || typeof text !== 'string') return '';
  let n = text.toLowerCase();
  for (const [char, rep] of Object.entries(LEET_MAP)) {
    n = n.split(char).join(rep);
  }
  // Remove zero-width and invisible Unicode characters
  n = n.replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '');
  // Collapse repeated characters beyond 2 (fuuuuck → fuuck)
  n = n.replace(/(.)\1{2,}/g, '$1$1');
  return n;
}

function removeSpacing(text) {
  return text.replace(SEPARATOR_CHARS, '');
}


// ─────────────────────────────────────────────
// FILTER CLASS
// ─────────────────────────────────────────────

class LunaContentFilter {
  constructor(options = {}) {
    this.abuseCount = 0;
    this.maxAbuse = options.maxAbuse || 2;
    this.agentName = options.agentName || 'the team';
    this.logCallback = options.onFlag || null;
    this.customBlocklist = options.customBlocklist || [];

    // Combine all word lists
    this.allTerms = [
      ...PROFANITY,
      ...RACIAL_ETHNIC_SLURS,
      ...HOMOPHOBIC_TRANSPHOBIC,
      ...RELIGIOUS_DEROGATORY,
      ...POLITICAL_IDEOLOGICAL,
      ...VIOLENCE_THREATS,
      ...SEXUAL_CONTENT,
      ...DISABILITY_ABLEIST,
      ...this.customBlocklist
    ];

    // Build category lookup for logging
    this.categoryMap = new Map();
    const cats = {
      profanity: PROFANITY,
      racial_ethnic: RACIAL_ETHNIC_SLURS,
      homophobic_transphobic: HOMOPHOBIC_TRANSPHOBIC,
      religious: RELIGIOUS_DEROGATORY,
      political_ideological: POLITICAL_IDEOLOGICAL,
      violence_threats: VIOLENCE_THREATS,
      sexual_content: SEXUAL_CONTENT,
      disability_ableist: DISABILITY_ABLEIST,
      custom: this.customBlocklist
    };
    for (const [cat, terms] of Object.entries(cats)) {
      for (const t of terms) this.categoryMap.set(t.toLowerCase(), cat);
    }

    // Separate single words from multi-word phrases
    this.singleWords = new Set();
    this.multiWordPhrases = [];
    for (const term of this.allTerms) {
      const lower = term.toLowerCase();
      if (lower.includes(' ')) {
        this.multiWordPhrases.push(lower);
      } else {
        this.singleWords.add(lower);
      }
    }
  }

  /**
   * LAYER 3 — Classify visitor input BEFORE sending to the AI.
   * Returns: { blocked, deflection, category, term, conversationClosed }
   */
  classifyInput(message) {
    if (!message || typeof message !== 'string') {
      return { blocked: false, deflection: null, category: null, term: null };
    }

    const result = this._scan(message);

    if (result.found) {
      this.abuseCount++;

      if (this.logCallback) {
        this.logCallback({
          type: 'input_blocked',
          category: result.category,
          term: result.term,
          abuseCount: this.abuseCount,
          timestamp: new Date().toISOString()
        });
      }

      if (this.abuseCount >= this.maxAbuse) {
        return {
          blocked: true,
          deflection: `I'm not able to continue this conversation. Please contact ${this.agentName} directly if you need help with a travel booking.`,
          category: result.category,
          term: result.term,
          conversationClosed: true
        };
      }

      return {
        blocked: true,
        deflection: "I'm here to help with travel questions. What destination or trip can I help you with?",
        category: result.category,
        term: result.term,
        conversationClosed: false
      };
    }

    return { blocked: false, deflection: null, category: null, term: null };
  }

  /**
   * LAYER 2 — Filter AI output BEFORE displaying to the visitor.
   * Returns: { filtered, flagged, flags }
   */
  filterOutput(response) {
    if (!response || typeof response !== 'string') {
      return { filtered: response, flagged: false, flags: [] };
    }

    const flags = [];
    let filtered = response;

    // Check multi-word phrases
    for (const phrase of this.multiWordPhrases) {
      const normResp = normalise(filtered);
      if (normResp.includes(phrase)) {
        const cat = this.categoryMap.get(phrase) || 'unknown';
        flags.push({ term: phrase, category: cat });
        const regex = new RegExp(this._escapeRegex(phrase), 'gi');
        filtered = filtered.replace(regex, '[removed]');
      }
    }

    // Check individual words
    const words = filtered.split(/\s+/);
    const cleanWords = words.map(word => {
      const stripped = word.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
      const normed = normalise(stripped);
      const collapsed = removeSpacing(normed);

      if (this.singleWords.has(stripped) ||
          this.singleWords.has(normed) ||
          this.singleWords.has(collapsed)) {
        const cat = this.categoryMap.get(stripped) ||
                    this.categoryMap.get(normed) || 'unknown';
        flags.push({ term: stripped, category: cat });
        return '[removed]';
      }
      return word;
    });

    if (flags.length > 0) {
      filtered = cleanWords.join(' ');
      if (this.logCallback) {
        this.logCallback({
          type: 'output_filtered',
          flags,
          timestamp: new Date().toISOString()
        });
      }
    }

    return { filtered, flagged: flags.length > 0, flags };
  }

  /**
   * Quick boolean check — does this text contain anything blocked?
   */
  containsBlocked(text) {
    return this._scan(text).found;
  }

  /**
   * Reset abuse counter for a new conversation session.
   */
  resetSession() {
    this.abuseCount = 0;
  }

  /**
   * Get filter stats for debugging.
   */
  getStats() {
    return {
      totalTerms: this.allTerms.length,
      singleWords: this.singleWords.size,
      multiWordPhrases: this.multiWordPhrases.length,
      sessionAbuseCount: this.abuseCount
    };
  }

  // ───── Internal scanning engine ─────

  _scan(text) {
    const normed = normalise(text);
    const collapsed = removeSpacing(normed);

    // Multi-word phrases
    for (const phrase of this.multiWordPhrases) {
      if (normed.includes(phrase) || collapsed.includes(phrase)) {
        return { found: true, category: this.categoryMap.get(phrase) || 'unknown', term: phrase };
      }
    }

    // Single words (word-boundary aware — prevents Scunthorpe problem)
    const words = normed.split(/\s+/);
    for (const word of words) {
      const stripped = word.replace(/[^a-z0-9]/g, '');
      if (this.singleWords.has(stripped)) {
        return { found: true, category: this.categoryMap.get(stripped) || 'unknown', term: stripped };
      }
    }

    // Spaced-out evasion detection (f u c k, f.u.c.k)
    for (const term of this.singleWords) {
      if (term.length >= 4 && collapsed.includes(term)) {
        const spacedPattern = term.split('').join('[^a-z]*');
        const spacedRegex = new RegExp(spacedPattern);
        if (spacedRegex.test(text.toLowerCase())) {
          return { found: true, category: this.categoryMap.get(term) || 'unknown', term: term + ' (evasion)' };
        }
      }
    }

    return { found: false, category: null, term: null };
  }

  _escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}


// ─────────────────────────────────────────────
// EXPORTS — works with both require() and import
// ─────────────────────────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { LunaContentFilter };
} else if (typeof window !== 'undefined') {
  window.LunaContentFilter = LunaContentFilter;
}
