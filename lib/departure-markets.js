// Where this agency's customers fly FROM.
//
// The search prompt used to open with "ORIGIN_IATA — always a UK airport code"
// and a list of 24 British airports. For a Romanian agency that is not a
// default, it is an instruction to ignore the visitor: someone who said they
// wanted to fly from Cluj-Napoca was offered London and Manchester, and when
// she insisted, told that the live system is "optimised for direct routes from
// the UK". None of that was true of the supplier. It was true of our prompt.
//
// Travelify searches from and to anywhere, so the rule is now simply: use the
// airport the visitor named. This list exists only for the other case — the
// visitor has not said yet, and Luna needs somewhere sensible to suggest. That
// is a per-client fact, because it is their customers who are flying.
//
// DEFAULT IS THE UNITED KINGDOM. Every client predates this setting and every
// one of them is British or Irish, so an unset field must keep behaving exactly
// as it does today.
//
// Adding a market: add a row. The airports want their city names attached —
// the model picks a sensible code far more reliably from "CLJ (Cluj-Napoca)"
// than from "CLJ", and the names are what a visitor actually says.

'use strict';

var MARKETS = [
  {
    code: 'GB',
    name: 'United Kingdom',
    // The original list, unchanged, so nothing moves for existing clients.
    airports: 'LON (all London), LHR (Heathrow), LGW (Gatwick), STN (Stansted), LTN (Luton), '
      + 'LCY (London City), MAN (Manchester), BHX (Birmingham), EDI (Edinburgh), GLA (Glasgow), '
      + 'LBA (Leeds Bradford), NCL (Newcastle), LPL (Liverpool), BRS (Bristol), EMA (East Midlands), '
      + 'BFS (Belfast International), BHD (Belfast City), SOU (Southampton), CWL (Cardiff), '
      + 'ABZ (Aberdeen), EXT (Exeter), BOH (Bournemouth), NWI (Norwich), INV (Inverness)',
    note: 'If the visitor says "London" use LON. If they name a specific London airport, use that code.'
  },
  {
    code: 'IE',
    name: 'Ireland',
    airports: 'DUB (Dublin), ORK (Cork), SNN (Shannon), NOC (Ireland West Knock), KIR (Kerry)',
    note: ''
  },
  {
    code: 'RO',
    name: 'Romania',
    airports: 'OTP (Bucharest Otopeni), CLJ (Cluj-Napoca), TSR (Timisoara), IAS (Iasi), '
      + 'SBZ (Sibiu), CRA (Craiova), BCM (Bacau), SCV (Suceava), OMR (Oradea), TGM (Targu Mures), '
      + 'CND (Constanta), BAY (Baia Mare), SUJ (Satu Mare), ARW (Arad)',
    note: 'If the visitor says "Bucharest" use OTP.'
  }
];

var DEFAULT = MARKETS[0];

var byCode = new Map();
var byName = new Map();
MARKETS.forEach(function (m) {
  byCode.set(m.code.toLowerCase(), m);
  byName.set(m.name.toLowerCase(), m);
});

// Accepts whatever Airtable hands back: a plain string, a singleSelect object,
// a two-letter code, or nothing. Never throws; an unrecognised value is the
// default rather than an empty list, because a prompt with no airports in it
// is worse than a prompt with the wrong country's.
function resolve(value) {
  var raw = value;
  if (Array.isArray(raw)) raw = raw[0];
  if (raw && typeof raw === 'object') raw = raw.name;
  var key = String(raw == null ? '' : raw).trim().toLowerCase();
  if (!key) return DEFAULT;
  return byCode.get(key) || byName.get(key) || DEFAULT;
}

function isSupported(value) {
  if (value === null || value === undefined || value === '') return false;
  var raw = value && typeof value === 'object' ? value.name : value;
  var key = String(raw).trim().toLowerCase();
  return byCode.has(key) || byName.has(key);
}

// The ORIGIN_IATA section of the search prompt, written for one market.
// The first sentence is the part that matters: the visitor's own airport wins,
// wherever in the world it is. The list is only for suggesting.
function originPromptFor(value) {
  var m = resolve(value);
  return '**ORIGIN_IATA** — the IATA code of the airport the visitor is flying FROM.\n'
    + 'Use whatever airport they name, anywhere in the world. If they say Cluj-Napoca, use CLJ. '
    + 'If they say Milan, use MXP. Never substitute a different country\'s airport for the one they gave you, '
    + 'and never tell a visitor their own airport cannot be searched — it can.\n'
    + 'When they have NOT said where they are flying from, ask, and suggest from this agency\'s home market ('
    + m.name + '):\n' + m.airports + '.\n'
    + (m.note ? m.note + '\n' : '')
    + 'A connecting flight is a normal result, not a special case. If there is no direct service, '
    + 'the search still runs and still returns options with a connection — so never say a route is unsearchable.';
}

module.exports = {
  MARKETS: MARKETS,
  DEFAULT: DEFAULT,
  resolve: resolve,
  isSupported: isSupported,
  originPromptFor: originPromptFor,
  names: function () { return MARKETS.map(function (m) { return m.name; }); }
};
