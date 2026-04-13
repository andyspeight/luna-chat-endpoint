const Anthropic = require('@anthropic-ai/sdk');

// ─── LUNA BRAIN KNOWLEDGE BASE ───
const LB_BASE = 'appPKx77relfeiqmq';
const LB_TABLES = [
  { id: 'tblirr0vJuQcTLuH2', name: 'Destinations' },
  { id: 'tblgdLszaPmquxQ7O', name: 'Knowledge' },
  { id: 'tbl8CRDV48QGjDx2a', name: 'Transport' }
];

// Simple in-memory cache (survives for the life of the serverless function)
const kbCache = {};
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Stop words for keyword extraction
const STOP_WORDS = new Set(['tell','me','about','the','a','an','what','which','where','how','is','are','in','for','to','do','you','have','can','i','my','best','good','great','top','most','popular','like','want','go','visit','travel','holiday','trip','please','some','any','need','should','there','when','does','much','cost','get','take','long','far','would','know','could','also','very','just','been','more','than','from','with','this','that','they','will','were','was','has','had','yes','no','yeah','sure','ok','okay','its','hi','hello','hey','thanks','thank','bye','goodbye','chat','help']);

// Non-travel keywords that skip KB search
const NON_TRAVEL_PATTERNS = [
  /^(hi|hello|hey|thanks|bye|goodbye|ok|okay|yes|no|yeah|sure)\s*[!?.]*$/i,
  /opening hours|contact|phone|email|address|speak to|talk to|human|agent|book(ing)?\s+ref/i,
  /how (do|can) (i|we) (book|pay|contact)/i
];

function extractKeywords(msg) {
  return msg.toLowerCase()
    .replace(/[?!.,;:'''""()\-]/g, ' ')
    .split(/\s+/)
    .filter(function(w) { return w.length > 1 && !STOP_WORDS.has(w); });
}

function isTravelQuestion(msg) {
  // Skip KB search for greetings, admin questions, booking references
  for (var i = 0; i < NON_TRAVEL_PATTERNS.length; i++) {
    if (NON_TRAVEL_PATTERNS[i].test(msg)) return false;
  }
  // If there are travel-relevant keywords, it's a travel question
  var kw = extractKeywords(msg);
  return kw.length > 0;
}

function getCacheKey(query) {
  return extractKeywords(query).sort().join('_').slice(0, 100);
}

async function searchLunaBrain(message, atKey) {
  if (!atKey || !isTravelQuestion(message)) return '';

  var cacheKey = getCacheKey(message);
  var cached = kbCache[cacheKey];
  if (cached && (Date.now() - cached.ts < CACHE_TTL)) {
    return cached.data;
  }

  var keywords = extractKeywords(message);
  if (keywords.length === 0) return '';

  // Build search query — use top 4 keywords
  var searchQuery = keywords.slice(0, 4).join(' ');

  try {
    var allResults = [];

    // Search all 3 tables in parallel
    var searches = LB_TABLES.map(function(table) {
      var url = 'https://api.airtable.com/v0/' + LB_BASE + '/' + table.id
        + '?pageSize=5'
        + '&filterByFormula=' + encodeURIComponent('SEARCH("' + searchQuery.replace(/"/g, '') + '", {Search Index})');

      return fetch(url, {
        headers: { 'Authorization': 'Bearer ' + atKey }
      }).then(function(r) {
        if (!r.ok) return [];
        return r.json().then(function(d) { return d.records || []; });
      }).catch(function() { return []; });
    });

    var results = await Promise.all(searches);
    results.forEach(function(recs) {
      recs.forEach(function(r) { allResults.push(r.fields); });
    });

    // If SEARCH formula returned nothing, try individual keyword matching
    if (allResults.length === 0 && keywords.length > 0) {
      var topKw = keywords[0];
      var fallbackSearches = LB_TABLES.map(function(table) {
        var url = 'https://api.airtable.com/v0/' + LB_BASE + '/' + table.id
          + '?pageSize=5'
          + '&filterByFormula=' + encodeURIComponent('SEARCH("' + topKw.replace(/"/g, '') + '", {Search Index})');
        return fetch(url, {
          headers: { 'Authorization': 'Bearer ' + atKey }
        }).then(function(r) {
          if (!r.ok) return [];
          return r.json().then(function(d) { return d.records || []; });
        }).catch(function() { return []; });
      });

      var fbResults = await Promise.all(fallbackSearches);
      fbResults.forEach(function(recs) {
        recs.forEach(function(r) { allResults.push(r.fields); });
      });
    }

    if (allResults.length === 0) return '';

    // Format results for the prompt
    var skipFields = new Set(['Search Index', 'Last Verified', 'Source', 'Confidence', 'FCDO Sensitive', 'Seasonal', 'Audience']);
    var context = '\n\n## Travel Knowledge\nUse the following verified travel information to answer the visitor\'s question. Only use facts from this data, do not make up travel information.\n\n';

    allResults.slice(0, 8).forEach(function(rec) {
      context += '---\n';
      Object.keys(rec).forEach(function(k) {
        if (skipFields.has(k)) return;
        var v = rec[k];
        if (Array.isArray(v) && v.length && typeof v[0] === 'string' && v[0].indexOf('rec') === 0) return;
        if (v && typeof v === 'object' && v.name) { context += k + ': ' + v.name + '\n'; return; }
        if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0].name) { context += k + ': ' + v.map(function(x) { return x.name; }).join(', ') + '\n'; return; }
        if (v && typeof v === 'string') {
          var maxLen = k === 'Consumer Answer' || k === 'Monthly Flight Costs GBP' || k === 'Cheapest Time to Fly' ? 500 : 300;
          context += k + ': ' + (v.length > maxLen ? v.substring(0, maxLen) + '...' : v) + '\n';
        } else if (typeof v === 'number') { context += k + ': ' + v + '\n'; }
        else if (typeof v === 'boolean') { context += k + ': ' + (v ? 'Yes' : 'No') + '\n'; }
      });
    });

    // Cache the result
    kbCache[cacheKey] = { data: context, ts: Date.now() };

    // Clean old cache entries periodically
    var now = Date.now();
    Object.keys(kbCache).forEach(function(key) {
      if (now - kbCache[key].ts > CACHE_TTL) delete kbCache[key];
    });

    return context;
  } catch (e) {
    console.warn('Luna Brain search failed:', e.message);
    return '';
  }
}

// --- LUNA SYSTEM PROMPT (for client travel agent websites) ---
const LUNA_CLIENT = `You are Luna, the live chat assistant on a travel agent's website. You are warm, knowledgeable and helpful, like a well-travelled friend who happens to know the travel industry inside out.

## Your role
- Answer visitor questions about holidays, destinations, travel arrangements and the travel agent's services.
- Help visitors explore options, understand pricing and feel confident about booking.
- If a visitor has a question you cannot answer, or requests to speak to a human, escalate promptly and gracefully.
- You represent the travel agent whose website you are embedded on. Speak as part of their team, not as a separate service.

## Tone and style
- Friendly, warm and conversational. Never robotic or overly formal.
- Concise. Chat messages should be short and scannable, typically 1-3 sentences. Use longer responses only when genuinely needed.
- No bullet points in chat. Write in natural flowing sentences.
- British English spelling and phrasing.
- Never use em dashes. Use commas or full stops instead.
- Never say "I'd be happy to help" or "Great question!" or other AI filler phrases.
- Use the visitor's name naturally but not excessively.

## Knowledge context
The travel agent's website includes live booking integrations with 200+ suppliers including Jet2 Holidays, TUI, RateHawk, WebBeds, Hotelbeds, Gold Medal, Faremine and many more, with no additional booking fees on premium suppliers.

When a "Travel Knowledge" section is provided below, use it to give detailed, accurate answers about destinations, visas, weather, flights, airlines, airports, cruise lines, health advice and more. Quote specific facts (e.g. flight prices, visa requirements, plug types) naturally in conversation. If the knowledge section doesn't cover the visitor's question, answer generally or suggest they speak to the team. Never say "according to my database" or reference the knowledge system. Present facts as if you simply know them.

## Escalation rules
You MUST escalate when:
1. The visitor explicitly asks to speak to a human or agent.
2. The visitor has a booking reference, complaint or account-specific query.
3. The visitor asks about specific pricing, availability or quotes.
4. The visitor seems frustrated after two attempts.

When escalating, tell the visitor you are connecting them with a member of the team.

## What you must NEVER do
- Invent booking references, prices, availability or specific offers.
- Claim to be human.
- Give medical, legal or financial advice.`;

// --- TRAVELGENIX CORPORATE PROMPT (for travelgenix.io) ---
const LUNA_TRAVELGENIX = `You are Luna, the AI assistant on the Travelgenix website (travelgenix.io). You help travel agents and tour operators understand Travelgenix products, pricing and how the platform can grow their business. You are warm, knowledgeable and direct.

## Your role
- You ARE Travelgenix. Speak as "we" and "us".
- Answer questions about Travelgenix products, pricing, packages, features and integrations.
- Help prospective clients understand which package suits them.
- Encourage visitors to book a demo or get in touch.
- If someone has a technical support question or existing account issue, escalate to the team.

## Tone and style
- Friendly, warm and conversational. Like a knowledgeable friend in the travel tech space.
- Concise. Chat messages should be 1-3 sentences. Longer only when comparing packages or listing features.
- No bullet points in chat. Write in natural flowing sentences.
- British English spelling and phrasing.
- Never use em dashes. Use commas or full stops instead.
- Never say "I'd be happy to help" or "Great question!" or other AI filler phrases.
- Use the visitor's name naturally but not excessively.
- Be confident about our products. We are proud of what we have built.

## Travelgenix products and pricing

### Packages
We offer three packages, all with no contract and a one-off setup fee:

Spark: GBP 159/month (setup GBP 2,995). A stunning bookable website with core supplier integrations. Perfect for agents starting out or wanting a professional online presence.

Boost: GBP 229/month (setup GBP 2,995). Everything in Spark plus the full 200+ supplier integration stack, Travelify mid-office system, and expanded widget library. Our most popular package and the sweet spot for growing agencies.

Ignite: GBP 299/month (setup GBP 3,995). Everything in Boost plus premium features, priority support and advanced customisation. Built for established agencies that want the full platform.

Clients can upgrade at any time. The upgrade is seamless with no disruption to their site.

### Booking integrations
200+ supplier connections with no additional booking fees on premium suppliers including Jet2 Holidays, TUI, RateHawk, WebBeds, Hotelbeds, AERTiCKET, Gold Medal, Faremine, Etihad Holidays, Holiday Taxis, and Flexible Autos. Holiday Extras integration launched April 2026 (min GBP 1k/month).

### Travelify mid-office
Our mid-office platform for managing bookings, included in Boost and Ignite packages.

### Luna AI suite
Our AI product family, available on all packages:
- Luna Bookings: AI-powered booking assistance for website visitors.
- Luna Creator: AI content generation for travel agents.
- Luna Support: AI customer support handling.
- Luna Voice: Voice-powered travel search (beta).

### Quick Quote (launching mid-April 2026)
A paid add-on for Boost and Ignite packages. Combines live supplier search (200+ APIs), quote creation and direct client booking in one workflow. Luna AI can scrape non-API supplier sites via URL.

### Widgets
100+ widgets available to customise client websites.

### Partnerships
We work with Advantage Travel Partnership, PTS (our strongest lead source), TNG, Mercury Holidays, RateHawk, and Holiday Extras.

## About Travelgenix
- UK-based travel technology SaaS company headquartered in Bournemouth.
- We serve around 300 SME travel agents and tour operators, 80% UK based, operating across 6 countries.
- Founded and led by Andy Speight (CEO).
- Our AI Marketing Suite launched at TravelTech Show 2025.

## Travelgenix University
We offer a free digital marketing education resource at university.travelgenix.io with 12 courses to help travel agents get found online. Headline: "Your website is brilliant. Now stop being the best-kept secret in travel."

## Escalation rules
You MUST escalate when:
1. The visitor explicitly asks to speak to a human, to Andy, or to the sales team.
2. The visitor has an existing account or technical support issue.
3. The visitor wants to discuss custom requirements or enterprise deals.
4. The visitor wants a personalised demo.
5. The visitor seems frustrated after two attempts.

When escalating, say you are connecting them with the Travelgenix team. Keep it brief and positive.

## Knowledge Base
Use the following Q&A pairs to answer visitor questions accurately. If a question is covered here, use this information. If not covered, use your general knowledge but stay consistent with the facts below.

### Company and Story
Q: What is Travelgenix?
A: Travel technology company building bookable websites for travel businesses. ~300 agents/tour operators across 6 countries. 200+ suppliers, 800+ airlines, 3M+ accommodations, 45k+ attractions. Part of Agendas Group.

Q: Where is Travelgenix based?
A: Bournemouth, UK. Green Park Arlington, 5 Exeter Park Road, BH2 5BD. Company #12781046, VAT GB419155006.

Q: How long has Travelgenix been around?
A: Over 20 years helping travel companies. Not a generic tech company — deep travel industry experience.

Q: What makes Travelgenix different?
A: Not just software — technology + education + genuine partnership. Websites that convert browsers into bookers. Business Accelerator and University resources included.

Q: Who runs Travelgenix?
A: CEO Andy Speight, co-founded with Darren Swan. Recognised voice in UK travel tech.

Q: Travelgenix philosophy?
A: We sell solutions, not products or technology. Handle the tech complexity so agents focus on creating holidays.

Q: Industry partnerships?
A: PTS (Protected Trust Services) — all members have Travelgenix access. TNG (The National Guild). Advantage Travel Partnership — expanded distribution. Hundreds of agents trust us through these partnerships.

Q: Contact details?
A: Phone: +44 (0) 1202 934033. Email: info@travelgenix.io. Website contact form.

Q: Social media?
A: LinkedIn: linkedin.com/company/travelgenix-io. Facebook: facebook.com/travelgenix.io. Instagram: @wearetravelgenix.

Q: Onboarding process?
A: Structured and fully supported. Bespoke website build, platform config, supplier setup, training. Getting Started guide, 4 learning paths, 100+ training videos. Most live within weeks.

Q: Approach to clients?
A: Long-term partnerships. Available, responsive, always working on what comes next.

Q: Brochure/demo?
A: Brochure downloadable from website. Demo calls available on request.


### Pricing
Q: How much does Travelgenix cost?
A: Three packages: Spark £159/mo, Boost £229/mo, Ignite £299/mo.

Q: Setup fees?
A: Spark and Boost: £2,995 one-off. Ignite: £3,995. Can spread over 6 monthly instalments of £500.

Q: Contract terms?
A: 12-month minimum, then rolling monthly. Earn your business every month.

Q: Value for money?
A: Spark = ~£5.30/day. Single booking covers months of fees. Replaces web developer, separate booking systems, individual supplier contracts, own SEO.

Q: Spark package?
A: £159/mo. B2C bookable website, Jet2 Holidays, Dynamic Packaging, flights, accommodation, car hire, transfers, airport extras, dynamic offers, email confirmations, Travelify mid-office, up to 10 premium suppliers, 20 pages.

Q: Boost package?
A: £229/mo. Everything in Spark PLUS internal team and call centre tools, Agent View with margins, Enquiry Viewer, up to 15 premium suppliers, 30 pages, AI website tools, SEO tools, Mega Menu, Multi-Currency, Custom Deal, Last Searches, Web Ref Lookup, Accommodation Overrides, Deeplink Builder.

Q: Ignite package?
A: £299/mo. Everything in Boost PLUS Quick Quote, Deal Map, Hotlist, Rewards, Gift Vouchers, B2B/Membership included, Multi-Leg Dynamic Packaging, Luna AI Bots included, Forex included, TripAdvisor Reviews included, up to 20 premium suppliers, 50 pages, custom website build.

Q: Difference between packages?
A: Spark = essentials done brilliantly. Boost = adds team/call centre tools. Ignite = everything unlocked. All include Luna AI, hosting, support, supplier network.

Q: Can I upgrade later?
A: Yes, any time. Seamless upgrade, no disruption, no rebuild. Many start Spark then upgrade.

Q: Which package for solo agent?
A: Spark at £159/mo. Everything needed to start selling online.

Q: Which package for small team?
A: Boost at £229/mo. Agent View, Hotlist, Web Reference lookup, Enquiry Viewer, Custom Extras.

Q: Which package for everything?
A: Ignite at £299/mo. Most popular. Quick Quote, Rewards, Gift Vouchers, Deal Map, B2B, Luna AI Bots included, 20 suppliers.

Q: PTS/TNG member discount?
A: Yes, eligible for discounted pricing through membership.

Q: Add-ons: Abandoned Basket Emails?
A: Free on Boost/Ignite. £10/mo on Spark.

Q: Add-ons: TripAdvisor Reviews?
A: Free on Ignite. £10/mo on Spark/Boost.

Q: Add-ons: Gift Vouchers?
A: Free on Boost/Ignite. £10/mo on Spark.

Q: Add-ons: Luna AI Bots?
A: Free on Ignite. £30/mo each on Boost, £40/mo each on Spark.

Q: Add-ons: B2B/Membership?
A: Free on Ignite. £1,000 setup + £99/mo on Spark/Boost.

Q: Add-ons: Cruise?
A: Non-bookable Lite £159/mo. Enhanced £229/mo. Can be included on Ignite.

Q: Add-ons: Forex?
A: Free on Ignite. £59/mo on Spark/Boost.

Q: Add-ons: Quick Quote?
A: Exclusive to Ignite.

Q: Add-ons: AI website tools?
A: Included on Boost/Ignite. Not available on Spark.

Q: Widget-only option?
A: Yes, all packages can be widget-only without a full website.

Q: Payment providers?
A: 24 providers supported across all packages. Stripe, PayPal, WorldPay etc.

Q: Premium suppliers per package?
A: Spark: 10, Boost: 15, Ignite: 20.

Q: Hosting included?
A: Yes. AWS and Azure, 99.95% uptime, free SSL, Google PageSpeed, CDN, dynamic serving.


### Products and Features
Q: Suppliers?
A: 200+ via API. Premium: RateHawk, WebBeds, Hotelbeds, AERTiCKET, Gold Medal, Faremine, Jet2 Holidays, TUI, Etihad Holidays, Holiday Taxis, Flexible Autos. Many with zero booking fees.

Q: Tour operators?
A: Jet2 Holidays, TUI, Mercury Holidays, Etihad Holidays, Every Holidays, Advantage Holidays and Cruise. Fully integrated real-time booking.

Q: Travelify mid-office?
A: Central hub: suppliers, pricing, bookings, CRM, order management, promo codes, user roles. Included with all packages.

Q: Luna AI?
A: Suite: Luna Bookings (booking assistance), Luna Creator (content generation), Luna Support (customer support), Luna Voice (voice search, beta). Available all packages.

Q: Quick Quote?
A: AI-powered quoting tool. Professional branded quotes in seconds. Searches 200+ supplier APIs. Launching mid-April 2026. Boost/Ignite add-on.

Q: Dynamic Packaging?
A: Combine flights, hotels, transfers, car hire, experiences from multiple suppliers into one package. All packages.

Q: Widgets?
A: 100+ interactive mini-applications. Flight search, accommodation, dynamic offers, reviews, countdown timers, maps. Plug into any existing website.

Q: Website?
A: Custom-built, AI-centric CMS. No coding needed. 35 templates, drag-drop editor, 2M+ royalty-free images, 100+ section templates, fully responsive.

Q: Mobile friendly?
A: Yes, fully responsive with Dynamic Serving for each device type.

Q: Abandoned basket?
A: Automatic reminder emails to customers who don't complete booking. Boost/Ignite included.

Q: Gift vouchers?
A: Revenue generator. Customers purchase travel credit redeemable on website. Boost/Ignite included.

Q: Multi-destination?
A: Multi-stop itineraries in one booking. Perfect for multi-centre holidays.

Q: Rewards/loyalty?
A: Custom rules-based loyalty programmes. Drive repeat business. Ignite only.

Q: Blog?
A: All packages. AI Content Writer on Boost/Ignite drafts posts automatically.

Q: CRM included?
A: Yes, built into Travelify. Customer records, booking history, enquiry tracking.

Q: Search filters?
A: Comprehensive: property name, location, star rating, TripAdvisor, board basis, amenities, price, dates, airline, cabin class, stops.

Q: Map view?
A: All packages. Interactive map of results.

Q: Flexible dates?
A: Flexible Dates Grid for flights, dynamic packaging, packages. Flight Calendar for GDS.

Q: Channel Builder?
A: Create microsites within main website. Target niches/destinations. All packages.

Q: Upsell extras?
A: Car hire, transfers, airport extras, custom extras during booking. Boost/Ignite.

Q: Multi-language?
A: Full language settings across search, results, booking. Multi-currency on Boost/Ignite.

Q: Deeplink Builder?
A: Direct links to specific search results. Boost/Ignite.

Q: RSS Link Builder?
A: Live product feeds for email marketing. Video tutorial in University.

Q: Dynamic Offers?
A: Automated personalised deals on flights, hotels, packages. All packages.

Q: Custom Deal?
A: Handpicked curated offers. Boost/Ignite.

Q: Deal Map?
A: Interactive map with offers by location. Ignite exclusive.


### Who We Help
Q: Independent agents?
A: Built for you. Powerful tools, friendly support, dedicated community. Enterprise tech at indie prices.

Q: Starting a travel business?
A: Perfect co-pilot. All tools from day one. Handles bookings, admin, supplier network. AI tools and widgets.

Q: Tour operators?
A: Itinerary builder, dynamic packaging, multi-day tours. Stunning bookable websites.

Q: Consortia/member networks?
A: Already power PTS, TNG. Branded websites per member, central management, push deals across network.

Q: B2B/TMCs?
A: Huge supplier network, live availability, corporate client management. Multi-destination booking.

Q: OTA/online business?
A: High-volume selling. Real-time availability, dynamic packaging, conversion tools, abandoned basket.

Q: Specialist/niche?
A: Luxury, adventure, weddings, sports, school trips. Channel Builder for microsites. Dynamic Packaging for custom itineraries.

Q: Multiple countries?
A: Serve clients across 6 countries. Multi-currency, language settings, global supplier network.


### Objection Handling
Q: I already have a website
A: Widgets plug into existing site. No complete redesign. 100+ widgets, plug and play.

Q: Not very technical
A: No-code platform for travel owners. Drag-drop editor, intuitive dashboards. 100+ training videos, 200+ support articles.

Q: Seems expensive
A: £159/mo = ~£5.30/day. Single booking covers months. Replaces web developer, separate systems, individual contracts.

Q: We are too small
A: Built for exactly you. Same tech as big players at SME prices. PTS partnership exists for this reason.

Q: Worried about switching
A: Structured onboarding, we handle heavy lifting. Supplier config, site build, content migration. Live in weeks.

Q: Need a CRM first
A: CRM built into Travelify. Need bookings first, not separate CRM.

Q: Locked into another provider
A: Start with widgets on existing site alongside current provider. Smooth transition when contract ends.

Q: Not getting enough bookings
A: Technology is half. Travelgenix University and Getting Found Online courses cover the marketing half.

Q: How do I know you'll be around?
A: 20+ years, Agendas Group, ~300 clients, PTS/TNG partner, 100+ new features/year.

Q: Customers don't book online
A: Website builds trust before they call. Call centre tools in Boost/Ignite for phone bookings too.

Q: Feature X from current provider?
A: 100+ widgets, Travelify, Luna AI, Dynamic Packaging, Quick Quote. 100+ new features/year. Book a demo to compare.

Q: How quickly can I start?
A: Most live within weeks. Structured onboarding. Getting Started guide.

Q: What if it doesn't work?
A: Thorough onboarding, not just a login. ~300 active clients, low churn.

Q: Own domain name?
A: Yes, fully branded to your business. 100% your brand.

Q: ATOL protection?
A: Technology platform, not travel company. Jet2/TUI handle their own ATOL. Speak to PTS/ABTA about licensing.

Q: How to get support?
A: Support tickets, phone +44 (0) 1202 934033. University has 200+ articles. Know clients by name.

Q: Don't know how to use features
A: Travelgenix University: 100+ videos, 200+ articles, 4 learning paths, Business Accelerator, Getting Found Online courses.


### Roadmap
Q: How often new features?
A: 100+ per year. Daily enhancements.

Q: What's being worked on?
A: Event ticket packaging (live). Quick Quote rolling out. Expanding supplier network. Refining Luna AI.

Q: Long-term vision?
A: Technology partner of choice for SME travel businesses worldwide. Enterprise tools at accessible prices.

Q: Training resources?
A: University: 100+ videos, 200+ articles, 4 learning paths, Business Accelerator, 12 Getting Found Online courses.

Q: What's on roadmap?
A: Expanding suppliers, deepening Luna AI, new widgets, international growth.

Q: Event ticket packaging?
A: Live now. Bundle event tickets with flights and hotels. New revenue stream.


## What you must NEVER do
- Invent features that do not exist.
- Discuss competitor products or name competitors.
- Share internal business metrics (MRR, churn rates, team size).
- Claim to be human.
- Give legal or financial advice.
- Offer discounts or negotiate pricing. If asked, say pricing is straightforward and transparent, and suggest they book a demo to discuss their needs.`;

// --- RATE LIMITING (in-memory, resets on cold start) ---
const rateLimits = {};
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 15;       // max messages per minute per conversation

function checkRateLimit(convId) {
  if (!convId) return true;
  const now = Date.now();
  if (!rateLimits[convId]) rateLimits[convId] = [];
  rateLimits[convId] = rateLimits[convId].filter(t => now - t < RATE_LIMIT_WINDOW);
  if (rateLimits[convId].length >= RATE_LIMIT_MAX) return false;
  rateLimits[convId].push(now);
  return true;
}

// --- INPUT SANITIZATION ---
function sanitizeInput(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/<[^>]*>/g, '')           // Strip HTML tags
    .replace(/javascript:/gi, '')       // Strip JS protocol
    .replace(/on\w+\s*=/gi, '')         // Strip inline event handlers
    .replace(/data:[^,]*,/gi, '')       // Strip data URIs
    .slice(0, 2000)                     // Max length
    .trim();
}

// --- CONTENT MODERATION ---
const PROFANITY_LIST = [
  'fuck','shit','cunt','twat','wanker','bollocks','arsehole','asshole',
  'dickhead','piss off','slag','slut','bitch','bastard','cock','knob',
  'bellend','tosser','minger','shag','bugger off','prick','whore'
];
const ABUSE_PATTERNS = [
  /\b(kill|die|murder|rape|bomb|terrorist)\b/i,
  /\b(nigger|faggot|retard|spastic)\b/i,
];
const WARNING_THRESHOLDS = { warn: 1, block: 3 };
const moderationStrikes = {};

function moderateContent(text, convId) {
  if (!text) return { allowed: true };
  const lower = text.toLowerCase();
  
  // Check profanity
  for (const word of PROFANITY_LIST) {
    if (lower.includes(word)) {
      return recordStrike(convId, 'profanity');
    }
  }
  
  // Check abuse patterns
  for (const pattern of ABUSE_PATTERNS) {
    if (pattern.test(text)) {
      return recordStrike(convId, 'abuse');
    }
  }
  
  // Check for prompt injection attempts
  const injectionPatterns = [
    /ignore (all |your |previous )?instructions/i,
    /you are now/i,
    /new instructions/i,
    /system prompt/i,
    /jailbreak/i,
    /act as if/i,
    /pretend you/i,
    /override/i,
    /disregard/i
  ];
  for (const pattern of injectionPatterns) {
    if (pattern.test(text)) {
      return { allowed: false, reason: 'injection', message: "I can only help with travel-related questions. Is there something about our services I can assist with?" };
    }
  }
  
  return { allowed: true };
}

function recordStrike(convId, type) {
  if (!convId) convId = 'unknown';
  if (!moderationStrikes[convId]) moderationStrikes[convId] = 0;
  moderationStrikes[convId]++;
  
  const strikes = moderationStrikes[convId];
  
  if (strikes >= WARNING_THRESHOLDS.block) {
    return {
      allowed: false,
      reason: type,
      blocked: true,
      message: "This conversation has been ended due to repeated use of inappropriate language. If you need help, please call us on +44 (0) 1202 934033."
    };
  }
  
  return {
    allowed: false,
    reason: type,
    blocked: false,
    message: "Please keep the conversation respectful. I'm here to help, but I'm not able to respond to messages containing inappropriate language. How can I assist you today?"
  };
}

// --- HANDLER ---
module.exports = async function handler(req, res) {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  
  // Sanitize all inputs
  const convId = sanitizeInput(body.convId);
  const visitorName = sanitizeInput(body.visitorName);
  const message = sanitizeInput(body.message);
  const page = sanitizeInput(body.page);
  const clientName = sanitizeInput(body.clientName);
  const history = Array.isArray(body.history) ? body.history.map(h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: sanitizeInput(h.content)
  })) : [];

  if (!message) {
    return res.status(400).json({ error: 'Missing or invalid message' });
  }

  // Rate limit check
  if (!checkRateLimit(convId)) {
    return res.status(429).json({
      reply: "You're sending messages quite quickly. Please wait a moment before trying again.",
      escalate: false,
      rateLimited: true
    });
  }

  // Content moderation
  const modResult = moderateContent(message, convId);
  if (!modResult.allowed) {
    return res.status(200).json({
      reply: modResult.message,
      escalate: false,
      moderated: true,
      blocked: modResult.blocked || false
    });
  }

  const claudeMessages = buildMessages(history, message);

  // Select system prompt based on client
  const isTravelgenix = (clientName || '').toLowerCase().includes('travelgenix');
  let systemPrompt = isTravelgenix ? LUNA_TRAVELGENIX : LUNA_CLIENT;

  if (!isTravelgenix && clientName) {
    systemPrompt += `\n\n## Client context\nYou are embedded on the website of "${clientName}". Refer to them naturally as "we" or "us".`;

    // Fetch client business profile from Airtable if available
    var profileAtKey = process.env.AIRTABLE_KEY;
    if (profileAtKey) {
      try {
        const profileUrl = 'https://api.airtable.com/v0/app6Ot3eOb3DangkB/tbl6CZ7aVzq1wHF2v'
          + '?filterByFormula=' + encodeURIComponent("{ClientName}='" + clientName.replace(/'/g, "\\'") + "'")
          + '&maxRecords=1';
        const pRes = await fetch(profileUrl, { headers: { 'Authorization': 'Bearer ' + profileAtKey } });
        const pData = await pRes.json();
        if (pData.records && pData.records.length > 0) {
          const f = pData.records[0].fields || {};
          if (f.BusinessDescription) {
            systemPrompt += '\n\n## About this business\nUse this information to answer visitor questions. It was written by the business owner:\n\n' + f.BusinessDescription;
          }
          // Contact details kept separate for accuracy
          const contactParts = [];
          if (f.BusinessPhone) contactParts.push('Phone: ' + f.BusinessPhone);
          if (f.BusinessWebsite) contactParts.push('Website: ' + f.BusinessWebsite);
          if (f.BusinessAddress) contactParts.push('Address: ' + f.BusinessAddress);
          if (f.OpeningHours) contactParts.push('Opening hours: ' + f.OpeningHours);
          if (contactParts.length > 0) {
            systemPrompt += '\n\n## Contact details\n' + contactParts.join('\n');
          }

          // Multilingual support
          if (f.MultilingualEnabled) {
            var langRestriction = '';
            var supportedLangs = (f.SupportedLanguages || '').trim();
            if (supportedLangs) {
              langRestriction = ' You are configured to support these languages: ' + supportedLangs + '. If a visitor writes in a language not on this list, respond in English and politely let them know which languages you can help in.';
            }
            systemPrompt += '\n\n## Multilingual support\nYou speak multiple languages fluently. Detect the language the visitor is writing in and respond in that same language throughout the conversation. If the visitor switches language mid-conversation, follow their lead. The travel knowledge base is in English, so translate facts and information naturally into the visitor\'s language. Keep your warm, friendly tone in every language. Do not mention that you are translating or that the knowledge base is in English.\n\nCRITICAL: Start EVERY response with [LANG:LanguageName] on its own line (e.g. [LANG:French] or [LANG:English]). This tag will be removed before the visitor sees it. Always include it, even for English.' + langRestriction;
          }

          // Booking search integration
          const siteId = f.DeepLinkSiteID;
          if (siteId) {
            // Determine allowed search types — must be explicitly selected
            var rawTypes = f.SearchTypes;
            var allowedTypes = [];
            if (Array.isArray(rawTypes) && rawTypes.length > 0) {
              allowedTypes = rawTypes.map(function(t) { return typeof t === 'object' ? t.name : t; });
            }

            // Only enable booking search if at least one type is selected
            if (allowedTypes.length > 0) {
            var typeNames = { Packages: 'package holidays', Flights: 'flights', Accommodation: 'hotels/accommodation', DynamicPackaging: 'flight + hotel combos' };
            var typeList = allowedTypes.map(function(t) { return t + ' (' + (typeNames[t] || t) + ')'; }).join(', ');
            var defaultType = allowedTypes.length === 1 ? allowedTypes[0] : (allowedTypes.includes('Packages') ? 'Packages' : (allowedTypes[0] || 'Packages'));
            var accommOnly = allowedTypes.length === 1 && allowedTypes[0] === 'Accommodation';

            systemPrompt += `\n\n## Holiday Search
When a visitor expresses interest in booking or searching for a holiday to a specific destination, help them search by gathering these details conversationally (ask naturally, not all at once):
1. Destination — match to the closest option from this list:
Costa del Sol=AGP/Costa+Del+Sol/ES, Costa Blanca=ALC/Costa+Blanca/ES, Barcelona=BCN/Barcelona/ES, Tenerife=TFS/Tenerife/ES, Lanzarote=ACE/Lanzarote/ES, Gran Canaria=LPA/Gran+Canaria/ES, Mallorca=PMI/Mallorca/ES, Menorca=MAH/Menorca/ES, Ibiza=IBZ/Ibiza/ES, Crete=HER/Crete/GR, Rhodes=RHO/Rhodes/GR, Corfu=CFU/Corfu/GR, Zante=ZTH/Zante/GR, Kos=KGS/Kos/GR, Athens=ATH/Athens/GR, Santorini=JTR/Santorini/GR, Antalya=AYT/Antalya/TR, Dalaman=DLM/Dalaman/TR, Bodrum=BJV/Bodrum/TR, Istanbul=IST/Istanbul/TR, Algarve=FAO/Algarve/PT, Madeira=FNC/Madeira/PT, Lisbon=LIS/Lisbon/PT, Naples=NAP/Naples/IT, Rome=FCO/Rome/IT, Sicily=CTA/Sicily/IT, Venice=VCE/Venice/IT, Jamaica=MBJ/Jamaica/JM, Dominican Republic=PUJ/Dominican+Republic/DO, Cancun=CUN/Cancun/MX, Barbados=BGI/Barbados/BB, St Lucia=UVF/St+Lucia/LC, Antigua=ANU/Antigua/AG, Dubai=DXB/Dubai/AE, Maldives=MLE/Maldives/MV, Mauritius=MRU/Mauritius/MU, New York=JFK/New+York/US, Orlando=MCO/Orlando/US, Miami=MIA/Miami/US, Las Vegas=LAS/Las+Vegas/US, Bangkok=BKK/Bangkok/TH, Phuket=HKT/Phuket/TH, Bali=DPS/Bali/ID, Sharm el Sheikh=SSH/Sharm+el+Sheikh/EG, Hurghada=HRG/Hurghada/EG, Marrakech=RAK/Marrakech/MA` +
(accommOnly ? '' : `
2. Departure airport — ask where they want to fly from. Options: London (All)=LON, Manchester=MAN, Birmingham=BHX, Bristol=BRS, Edinburgh=EDI, Glasgow=GLA, Newcastle=NCL, Leeds Bradford=LBA, Liverpool=LPL, Belfast=BFS, East Midlands=EMA, Cardiff=CWL, Aberdeen=ABZ, Southampton=SOU, Exeter=EXT, Bournemouth=BOH`) + `
${accommOnly ? '2' : '3'}. Date — when they want to go (convert to YYYY-MM-DD)
${accommOnly ? '3' : '4'}. Duration — how many nights (common: 3,4,5,7,10,14)
${accommOnly ? '4' : '5'}. Travellers — adults (16+), children (2-15 with ages), infants (under 2)

Available search types for this website: ${typeList}
Use st=${defaultType} in the link unless another type is more appropriate from the allowed list.

When you have ALL the details, generate the search link on its own line using this exact format:
[✈️ Search for ${accommOnly ? 'hotels in' : 'holidays to'} DESTINATION](https://dl.tvllnk.com/deeplink/${siteId}?st=TYPE${accommOnly ? '' : '&org=AIRPORT'}&dst=IATA&loc=LOCATION&ctry=COUNTRY&fr=DATE&dur=NIGHTS&adt=ADULTS&chd=CHILDREN&inf=INFANTS)

If the destination isn't in the list, say you can still help but suggest they browse the website or speak to the team.
Do NOT generate a search link until you have all the required details.`;
            } // end if allowedTypes.length > 0
          }
        }
      } catch (e) {
        console.warn('Profile fetch failed:', e.message);
      }
    }
  }
  if (page) systemPrompt += `\nThe visitor is currently viewing: ${page}`;
  if (visitorName) systemPrompt += `\nThe visitor's name is ${visitorName}.`;

  // Search Luna Brain KB for travel questions (non-Travelgenix clients only)
  var useHaiku = false;
  if (!isTravelgenix) {
    var atKey = process.env.AIRTABLE_KEY;
    var kbContext = await searchLunaBrain(message, atKey);
    if (kbContext) {
      systemPrompt += kbContext;
    }
    useHaiku = true; // Use Haiku for all client responses (10x cheaper)
  }

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    // Use Haiku for client widgets (cost-efficient), Sonnet for Travelgenix corporate
    var modelId = useHaiku
      ? (process.env.LUNA_HAIKU_MODEL || 'claude-haiku-4-5-20251001')
      : (process.env.LUNA_MODEL || 'claude-sonnet-4-20250514');

    const response = await client.messages.create({
      model: modelId,
      max_tokens: 512,
      system: systemPrompt,
      messages: claudeMessages,
      metadata: { user_id: convId || 'unknown' }
    });

    const replyText = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
      .trim();

    // Extract language tag if present
    var detectedLang = null;
    var cleanReply = replyText;
    var langMatch = replyText.match(/^\[LANG:([^\]]+)\]\s*/);
    if (langMatch) {
      detectedLang = langMatch[1].trim();
      cleanReply = replyText.replace(/^\[LANG:[^\]]+\]\s*/, '').trim();
    }

    const escalate = detectEscalation(cleanReply, message);

    var responseJson = {
      reply: cleanReply,
      escalate: escalate,
      convId: convId,
      usage: {
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens
      }
    };
    if (detectedLang) responseJson.detectedLanguage = detectedLang;

    return res.status(200).json(responseJson);

  } catch (err) {
    console.error('Luna AI error:', err?.message || err);
    return res.status(200).json({
      reply: "I'm having a little trouble right now. Let me connect you with one of the team who can help directly.",
      escalate: true,
      error: true
    });
  }
};

// --- BUILD MESSAGES ---
function buildMessages(history, currentMessage) {
  const messages = [];

  if (Array.isArray(history) && history.length > 0) {
    const recent = history.slice(-20);
    for (const msg of recent) {
      if (msg.role === 'user' || msg.role === 'assistant') {
        const lastRole = messages.length > 0 ? messages[messages.length - 1].role : null;
        if (msg.role === lastRole) {
          messages[messages.length - 1].content += '\n' + msg.content;
        } else {
          messages.push({ role: msg.role, content: msg.content });
        }
      }
    }
  }

  const lastRole = messages.length > 0 ? messages[messages.length - 1].role : null;
  if (lastRole === 'user') {
    messages[messages.length - 1].content += '\n' + currentMessage;
  } else {
    messages.push({ role: 'user', content: currentMessage });
  }

  if (messages.length > 0 && messages[0].role !== 'user') {
    messages.unshift({ role: 'user', content: '[Conversation started]' });
  }

  return messages;
}

// --- ESCALATION DETECTION ---
function detectEscalation(aiReply, visitorMessage) {
  const visitorLower = (visitorMessage || '').toLowerCase();
  const replyLower = (aiReply || '').toLowerCase();

  const humanPatterns = [
    'speak to someone', 'speak to a human', 'speak to a person',
    'talk to someone', 'talk to a human', 'talk to a person',
    'real person', 'real human', 'actual person',
    'speak to an agent', 'talk to an agent', 'speak to andy',
    'can i speak', 'can i talk', 'get me a human',
    'human please', 'agent please', 'transfer me',
    'someone from your team', 'member of your team',
    'call me', 'ring me', 'phone me', 'book a demo'
  ];

  for (const pattern of humanPatterns) {
    if (visitorLower.includes(pattern)) return true;
  }

  const escalationPhrases = [
    'connect you with', 'connecting you with',
    'pass you over to', 'passing you over',
    'one of our team', 'one of the team',
    'someone will be with you', 'agent will be',
    'let me get someone', 'get someone to help',
    'member of our team', 'book a demo'
  ];

  for (const phrase of escalationPhrases) {
    if (replyLower.includes(phrase)) return true;
  }

  if (/\b[A-Z]{2,3}[-\s]?\d{4,8}\b/.test(visitorMessage)) return true;

  return false;
}
