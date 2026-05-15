// lib/photos.js
// Travelgenix Luna Chat — hero photo resolver for highlights cards.
//
// Resolution order:
//   1. Curated registry (hand-picked Unsplash URLs for demo destinations)
//   2. Pexels API search (if PEXELS_API_KEY set)
//   3. Unsplash API search (if UNSPLASH_ACCESS_KEY set)
//   4. Generic travel fallback
//
// All curated URLs are Unsplash free-license photos served via Unsplash CDN
// with size params (?w=720&q=80&fit=crop). No download, no caching of bytes.
// We only store URLs; the visitor's browser fetches the image directly.

'use strict';

// ─── Curated registry ──────────────────────────────────────────────────────
// Keys are lowercased destination slugs that may appear in page URLs or titles.
// Values are Unsplash photo URLs (free to use, no attribution required for our
// use case but we credit anyway in the alt text — see PHOTO_CREDITS below).
//
// To add a new curated photo:
//   1. Visit https://unsplash.com and find a landscape photo
//   2. Use the photo's direct URL with ?w=1200&q=80&fit=crop appended
//   3. Add the destination slug + URL here
//   4. Add credit to PHOTO_CREDITS below
const CURATED_PHOTOS = {
  // Africa — Serengeti sunset, the classic safari image
  'africa': 'https://images.unsplash.com/photo-1516426122078-c23e76319801?w=1200&q=80&fit=crop',
  // Greece — Santorini blue domes
  'greece': 'https://images.unsplash.com/photo-1570077188672-e3a8d769bdca?w=1200&q=80&fit=crop',
  // Spain — Alhambra / Andalusian feel
  'spain': 'https://images.unsplash.com/photo-1543783207-ec64e4d95325?w=1200&q=80&fit=crop',
  // Caribbean — turquoise water, sandy beach
  'caribbean': 'https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1200&q=80&fit=crop',
  // Generic travel fallback — global, evocative
  'fallback': 'https://images.unsplash.com/photo-1488646953014-85cb44e25828?w=1200&q=80&fit=crop'
};

const PHOTO_CREDITS = {
  'africa': { photographer: 'Hu Chen', source: 'Unsplash' },
  'greece': { photographer: 'Heidi Kaden', source: 'Unsplash' },
  'spain': { photographer: 'Henrique Ferreira', source: 'Unsplash' },
  'caribbean': { photographer: 'Aaron Burden', source: 'Unsplash' },
  'fallback': { photographer: 'Mantas Hesthaven', source: 'Unsplash' }
};

// ─── Destination detection ─────────────────────────────────────────────────
// Given page context, work out which curated slug (if any) matches.
function detectDestinationSlug(pageContext) {
  if (!pageContext) return null;
  var haystack = (
    (pageContext.title || '') + ' ' +
    (pageContext.path || '') + ' ' +
    (pageContext.url || '')
  ).toLowerCase();

  // Order matters — most specific first
  var candidates = ['africa', 'greece', 'spain', 'caribbean'];
  for (var i = 0; i < candidates.length; i++) {
    if (haystack.indexOf(candidates[i]) !== -1) {
      return candidates[i];
    }
  }
  return null;
}

// ─── Pexels API search ─────────────────────────────────────────────────────
// Free tier: 200 requests/hour. https://www.pexels.com/api/
async function searchPexels(query) {
  var key = process.env.PEXELS_API_KEY;
  if (!key) return null;
  try {
    var url = 'https://api.pexels.com/v1/search?per_page=3&orientation=landscape&query=' +
              encodeURIComponent(query);
    var res = await fetch(url, {
      headers: { 'Authorization': key },
      signal: AbortSignal.timeout(3500)
    });
    if (!res.ok) {
      console.warn('[photos] Pexels API non-OK:', res.status);
      return null;
    }
    var data = await res.json();
    if (data && data.photos && data.photos.length > 0) {
      // Prefer large size (~1200px wide)
      var photo = data.photos[0];
      var url720 = photo.src && (photo.src.large || photo.src.large2x || photo.src.original);
      if (url720) {
        return {
          url: url720,
          photographer: photo.photographer || null,
          source: 'Pexels',
          sourceUrl: photo.url || null
        };
      }
    }
    return null;
  } catch (err) {
    console.warn('[photos] Pexels search failed:', err.message);
    return null;
  }
}

// ─── Unsplash API search ───────────────────────────────────────────────────
// Free tier: 50 requests/hour. https://unsplash.com/developers
async function searchUnsplash(query) {
  var key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return null;
  try {
    var url = 'https://api.unsplash.com/search/photos?per_page=3&orientation=landscape&query=' +
              encodeURIComponent(query);
    var res = await fetch(url, {
      headers: { 'Authorization': 'Client-ID ' + key },
      signal: AbortSignal.timeout(3500)
    });
    if (!res.ok) {
      console.warn('[photos] Unsplash API non-OK:', res.status);
      return null;
    }
    var data = await res.json();
    if (data && data.results && data.results.length > 0) {
      var photo = data.results[0];
      var urls = photo.urls || {};
      // Prefer 'regular' (~1080px), fallback to 'small' or 'full'
      var photoUrl = urls.regular || urls.small || urls.full;
      if (photoUrl) {
        // Append our own sizing for consistency with curated photos
        if (photoUrl.indexOf('?') === -1) {
          photoUrl += '?w=1200&q=80&fit=crop';
        }
        return {
          url: photoUrl,
          photographer: (photo.user && photo.user.name) || null,
          source: 'Unsplash',
          sourceUrl: (photo.links && photo.links.html) || null
        };
      }
    }
    return null;
  } catch (err) {
    console.warn('[photos] Unsplash search failed:', err.message);
    return null;
  }
}

// ─── Main resolver ─────────────────────────────────────────────────────────
// Returns: { url, photographer, source, sourceUrl, resolvedFrom }
// resolvedFrom: 'curated' | 'pexels' | 'unsplash' | 'fallback'
async function resolveHeroPhoto(pageContext, opts) {
  opts = opts || {};
  var slug = detectDestinationSlug(pageContext);

  // 1. Curated — instant, zero-risk
  if (slug && CURATED_PHOTOS[slug]) {
    var credit = PHOTO_CREDITS[slug] || {};
    return {
      url: CURATED_PHOTOS[slug],
      photographer: credit.photographer || null,
      source: credit.source || 'Unsplash',
      sourceUrl: null,
      resolvedFrom: 'curated'
    };
  }

  // Build a search query from the page context
  var query = '';
  if (pageContext && pageContext.title) {
    query = pageContext.title;
  } else if (pageContext && pageContext.path) {
    query = pageContext.path.replace(/[\/_-]+/g, ' ').trim();
  }
  // Add "travel landscape" for better results
  if (query) query += ' travel landscape';

  // 2. Pexels
  if (query) {
    var pexels = await searchPexels(query);
    if (pexels && pexels.url) {
      return Object.assign(pexels, { resolvedFrom: 'pexels' });
    }
  }

  // 3. Unsplash
  if (query) {
    var unsplash = await searchUnsplash(query);
    if (unsplash && unsplash.url) {
      return Object.assign(unsplash, { resolvedFrom: 'unsplash' });
    }
  }

  // 4. Fallback — generic travel image
  var fbCredit = PHOTO_CREDITS['fallback'];
  return {
    url: CURATED_PHOTOS['fallback'],
    photographer: fbCredit.photographer,
    source: fbCredit.source,
    sourceUrl: null,
    resolvedFrom: 'fallback'
  };
}

module.exports = {
  resolveHeroPhoto: resolveHeroPhoto,
  detectDestinationSlug: detectDestinationSlug,
  // Exported for testing
  CURATED_PHOTOS: CURATED_PHOTOS,
  PHOTO_CREDITS: PHOTO_CREDITS
};
