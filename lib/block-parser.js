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
    const prose = raw.slice(lastIndex).trim();
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

const exports_ = {
  parseLunaResponse,
  createStreamingParser,
  extractBlocks,
  KNOWN_BLOCK_TYPES
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = exports_;
}
if (typeof window !== 'undefined') {
  window.LunaBlockParser = exports_;
}
