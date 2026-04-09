const Anthropic = require('@anthropic-ai/sdk');

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

## What you must NEVER do
- Invent features that do not exist.
- Discuss competitor products or name competitors.
- Share internal business metrics (MRR, churn rates, team size).
- Claim to be human.
- Give legal or financial advice.
- Offer discounts or negotiate pricing. If asked, say pricing is straightforward and transparent, and suggest they book a demo to discuss their needs.`;

// --- HANDLER ---
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { convId, visitorName, message, history, page, clientName } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid message' });
  }

  const claudeMessages = buildMessages(history || [], message);

  // Select system prompt based on client
  const isTravelgenix = (clientName || '').toLowerCase().includes('travelgenix');
  let systemPrompt = isTravelgenix ? LUNA_TRAVELGENIX : LUNA_CLIENT;

  if (!isTravelgenix && clientName) {
    systemPrompt += `\n\n## Client context\nYou are embedded on the website of "${clientName}". Refer to them naturally as "we" or "us".`;
  }
  if (page) systemPrompt += `\nThe visitor is currently viewing: ${page}`;
  if (visitorName) systemPrompt += `\nThe visitor's name is ${visitorName}.`;

  try {
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

    const response = await client.messages.create({
      model: process.env.LUNA_MODEL || 'claude-sonnet-4-20250514',
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

    const escalate = detectEscalation(replyText, message);

    return res.status(200).json({
      reply: replyText,
      escalate: escalate,
      convId: convId,
      usage: {
        input_tokens: response.usage?.input_tokens,
        output_tokens: response.usage?.output_tokens
      }
    });

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
