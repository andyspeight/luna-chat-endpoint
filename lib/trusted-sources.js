// lib/trusted-sources.js
// Decides whether a source URL is authoritative enough to trust a fact WITHOUT
// human review. This is what makes re-verification scalable: a fact confirmed by
// a government site, a health authority, or an entity's own official website is
// auto-applied; anything else needs corroboration or a human.
//
// Two ways to clear the bar (see lib/reverify usage):
//   1. ONE authoritative source (government / recognised authority / the
//      official site of the thing the fact is about), or
//   2. TWO independent sources agreeing (handled by the caller, needs search).
//
// The authoritative set is: built-in patterns for governments and recognised
// travel/health authorities, PLUS a caller-supplied allowlist of specific
// official domains (e.g. heathrow.com, britishairways.com) that can be extended
// without code changes.

'use strict';

// Hostname patterns that are inherently authoritative (governments + the EU).
var AUTHORITY_PATTERNS = [
  /(^|\.)gov\.uk$/i,
  /\.gov$/i,                 // e.g. usa .gov
  /\.gov\.[a-z]{2,3}$/i,     // gov.au, gov.sg, gov.za ...
  /\.gouv\.[a-z]{2}$/i,      // gouv.fr
  /\.gob\.[a-z]{2}$/i,       // gob.es, gob.mx
  /(^|\.)govt\.nz$/i,
  /(^|\.)europa\.eu$/i
];

// Recognised travel/health authorities (suffix match on hostname).
var AUTHORITY_DOMAINS = [
  'nhs.uk', 'fitfortravel.nhs.uk', 'travelhealthpro.org.uk', 'who.int',
  'atol.org', 'abta.com', 'caa.co.uk', 'iata.org'
];

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

function suffixMatch(host, domain) {
  domain = String(domain).toLowerCase().replace(/^\.+/, '');
  return host === domain || host.endsWith('.' + domain);
}

// Returns { trusted, reason }. extraDomains is a caller-supplied allowlist of
// specific official domains (the "airport's own website" case).
function isTrusted(url, extraDomains) {
  var host = hostOf(url);
  if (!host) return { trusted: false, reason: '' };

  for (var i = 0; i < AUTHORITY_PATTERNS.length; i++) {
    if (AUTHORITY_PATTERNS[i].test(host)) return { trusted: true, reason: 'government' };
  }
  for (var j = 0; j < AUTHORITY_DOMAINS.length; j++) {
    if (suffixMatch(host, AUTHORITY_DOMAINS[j])) return { trusted: true, reason: 'authority' };
  }
  var extra = Array.isArray(extraDomains) ? extraDomains : [];
  for (var k = 0; k < extra.length; k++) {
    if (extra[k] && suffixMatch(host, extra[k])) return { trusted: true, reason: 'official-site' };
  }
  return { trusted: false, reason: '' };
}

// Parse a comma/newline separated env value into a clean domain allowlist.
function parseDomainList(raw) {
  if (!raw) return [];
  return String(raw).split(/[\n,]/).map(function (s) {
    return s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\.+/, '');
  }).filter(Boolean);
}

module.exports = {
  AUTHORITY_PATTERNS: AUTHORITY_PATTERNS,
  AUTHORITY_DOMAINS: AUTHORITY_DOMAINS,
  hostOf: hostOf,
  isTrusted: isTrusted,
  parseDomainList: parseDomainList
};
