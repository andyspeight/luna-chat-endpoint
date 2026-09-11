// The short "what Luna is doing right now" lines, in the widget's language.
//
// These are SERVER strings: they are chosen from the visitor's message and sent
// down the SSE stream as status events while the model is still thinking. They
// were the last English left in a translated widget — a Romanian visitor read
// "Reading the bookingvacante.ro page for you…" above a Romanian conversation.
//
// The language comes from the widget itself, on the request body, because the
// first status event is emitted BEFORE the client's Airtable record has been
// read. The widget already knows its own language (it was configured with it),
// the value is validated against lib/languages.js, and it decides nothing but
// which of these sentences to show — so trusting it costs nothing.
//
// Adding a language: add a block, keyed by the code in lib/languages.js. A
// missing key falls back to English rather than to a blank line; a test keeps
// every block in step with `en`.

'use strict';

var languages = require('./languages');

var STATUS = {
  en: {
    oneMoment: 'One moment…',
    thinkingAboutQuestion: 'Thinking about your question…',
    lookingThatUp: 'Looking that up for you…',
    readingPage: 'Reading the {page} page…',
    readingPageForYou: 'Reading the {page} page for you…',
    lookingIntoDestination: 'Looking into {destination} for you…',
    puttingIdeasTogether: 'Putting some ideas together…',
    /* booking and policy */
    lookingUpBooking: 'Looking up your booking…',
    pullingUpBooking: 'Pulling up your booking…',
    cancellationPolicy: 'Checking our cancellation policy…',
    insuranceTerms: 'Reading our insurance terms…',
    entryRequirements: 'Checking entry requirements…',
    baggageRules: 'Looking up baggage rules…',
    financialProtection: 'Checking our financial protection…',
    travelAdvice: 'Checking travel advice…',
    /* weather */
    weather: 'Checking the weather…',
    weatherIn: 'Checking the weather in {place}…',
    weatherInForYou: 'Let me look into the weather in {destination} for you…',
    weatherMonthIn: 'Let me look into the {month} weather in {destination} for you…',
    weatherInMonth: 'Checking what the weather is like in {month}…',
    /* timing */
    bestTimeToVisit: 'Looking up the best time to visit…',
    bestTimeToGo: 'Looking up the best time to go…',
    bestTimeFor: 'Let me check when is best for {destination}…',
    /* travel shape */
    airportInfo: 'Looking up airport info…',
    airportDetailsFor: 'Checking airport details for {destination}…',
    familyOptions: 'Finding family-friendly options…',
    familyOptionsFor: 'Finding family options for {destination}…',
    couplesIdeas: 'Finding ideas for couples…',
    romanticIdeasIn: 'Looking up romantic ideas in {destination}…',
    whatsAvailable: "Checking what's available…",
    whatIsAvailable: 'Checking what is available…',
    pricesFor: 'Checking prices for {destination}…',
    luxuryOptions: 'Looking up our luxury options…',
    luxuryStaysIn: 'Looking up luxury stays in {destination}…',
    whatsIncluded: "Checking what's included…",
    whatIsIncluded: 'Checking what is included…',
    allInclusiveFor: 'Checking all-inclusive options for {destination}…',
    safariOptions: 'Looking up our safari options…',
    safariOptionsIn: 'Looking up safari options in {destination}…',
    cruiseOptions: 'Checking our cruise options…',
    cruisesAround: 'Checking cruises around {destination}…',
    destinations: 'Looking up destinations…',
    rightPerson: 'Finding the right person…',
    /* pipeline */
    foundInKnowledge: 'Found something in our knowledge…',
    destinationDetails: 'Looking up destination details…',
    writingAnswer: 'Writing your answer…'
  },

  /* Romanian. Same caveat as the widget's table: translated by us, worth a
     native read-through, a one-line edit to correct. */
  ro: {
    oneMoment: 'O clipă…',
    thinkingAboutQuestion: 'Mă gândesc la întrebarea ta…',
    lookingThatUp: 'Caut informația pentru tine…',
    readingPage: 'Citesc pagina {page}…',
    readingPageForYou: 'Citesc pagina {page} pentru tine…',
    lookingIntoDestination: 'Caut informații despre {destination}…',
    puttingIdeasTogether: 'Pregătesc câteva idei…',
    lookingUpBooking: 'Caut rezervarea ta…',
    pullingUpBooking: 'Deschid rezervarea ta…',
    cancellationPolicy: 'Verific politica de anulare…',
    insuranceTerms: 'Citesc condițiile de asigurare…',
    entryRequirements: 'Verific condițiile de intrare…',
    baggageRules: 'Verific regulile de bagaje…',
    financialProtection: 'Verific protecția financiară…',
    travelAdvice: 'Verific recomandările de călătorie…',
    weather: 'Verific vremea…',
    weatherIn: 'Verific vremea în {place}…',
    weatherInForYou: 'Verific vremea în {destination} pentru tine…',
    weatherMonthIn: 'Verific vremea din {month} în {destination}…',
    weatherInMonth: 'Verific cum este vremea în {month}…',
    bestTimeToVisit: 'Caut cea mai bună perioadă de vizitare…',
    bestTimeToGo: 'Caut cea mai bună perioadă…',
    bestTimeFor: 'Verific când este cel mai bine pentru {destination}…',
    airportInfo: 'Caut informații despre aeroport…',
    airportDetailsFor: 'Verific detaliile aeroportului pentru {destination}…',
    familyOptions: 'Caut variante potrivite pentru familii…',
    familyOptionsFor: 'Caut variante pentru familii în {destination}…',
    couplesIdeas: 'Caut idei pentru cupluri…',
    romanticIdeasIn: 'Caut idei romantice în {destination}…',
    whatsAvailable: 'Verific ce este disponibil…',
    whatIsAvailable: 'Verific ce este disponibil…',
    pricesFor: 'Verific prețurile pentru {destination}…',
    luxuryOptions: 'Caut variantele noastre de lux…',
    luxuryStaysIn: 'Caut cazări de lux în {destination}…',
    whatsIncluded: 'Verific ce este inclus…',
    whatIsIncluded: 'Verific ce este inclus…',
    allInclusiveFor: 'Verific variantele all inclusive pentru {destination}…',
    safariOptions: 'Caut variantele noastre de safari…',
    safariOptionsIn: 'Caut variante de safari în {destination}…',
    cruiseOptions: 'Verific variantele noastre de croazieră…',
    cruisesAround: 'Verific croazierele din zona {destination}…',
    destinations: 'Caut destinații…',
    rightPerson: 'Caut persoana potrivită…',
    foundInKnowledge: 'Am găsit ceva în informațiile noastre…',
    destinationDetails: 'Caut detalii despre destinație…',
    writingAnswer: 'Îți scriu răspunsul…'
  }
};

// Resolve one status line. Falls back key by key to English, then to the key,
// so a gap is readable rather than blank.
function status(lang, key, vars) {
  var table = STATUS[lang] || STATUS.en;
  var s = table[key];
  if (s === undefined) s = STATUS.en[key];
  if (s === undefined) return key;
  if (vars) {
    Object.keys(vars).forEach(function (k) {
      s = s.split('{' + k + '}').join(vars[k] == null ? '' : String(vars[k]));
    });
  }
  return s;
}

// The language to use for status lines on this request. The widget sends its
// own; anything unrecognised (or absent, as on the WhatsApp path) is English.
function langFromRequest(value) {
  return languages.isSupported(value) ? languages.codeFor(value) : 'en';
}

module.exports = { STATUS: STATUS, status: status, langFromRequest: langFromRequest };
