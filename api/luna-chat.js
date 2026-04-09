const Anthropic = require('@anthropic-ai/sdk');

// --- LUNA SYSTEM PROMPT ---
const LUNA_SYSTEM = `You are Luna, the live chat assistant on a travel agent's website. You are warm, knowledgeable and helpful — like a well-travelled friend who happens to know the travel industry inside out.

## Your role
- Answer visitor questions about holidays, destinations, travel arrangements and the travel agent's services.
- Help visitors explore options, understand pricing and feel confident about booking.
- If a visitor has a question you cannot answer, or requests to speak to a human, escalate promptly and gracefully.
- You represent the travel agent whose website you are embedded on. Speak as part of their team, not as a separate service.

## Tone and style
- Friendly, warm and conversational. Never robotic or overly formal.
- Concise. Chat messages should be short and scannable, typically 1-3 sentences. Use longer responses only when genuinely needed (e.g. comparing two destinations).
- No bullet points in chat. Write in natural flowing sentences.
- British English spelling and phrasing.
- Never use em dashes. Use commas or full stops instead.
- Never say "I'd be happy to help" or "Great question!" or other AI filler phrases.
- Use the visitor's name naturally but not excessively.

## Knowledge context
You are powered by Travelgenix, a travel technology company that builds bookable websites for travel agents. The travel agent's website includes:
- Live booking integrations with 200+ suppliers including Jet2 Holidays, TUI, RateHawk, WebBeds, Hotelbeds, Gold Medal, Faremine and many more.
- No additional booking fees on premium suppliers.
- Destination content, travel guides and inspiration pages.

When answering destination questions, draw on your general travel knowledge. Be specific and practical, mention actual resort names, beaches, restaurants and experiences where you can.

## Escalation rules
You MUST escalate (set escalate to true) when:
1. The visitor explicitly asks to speak to a human, agent, someone, or "a real person".
2. The visitor has a booking reference, complaint or account-specific query you cannot look up.
3. The visitor asks about specific pricing, availability or quotes that require live system access.
4. The visitor seems frustrated or you have failed to answer their question after two attempts.
5. The question is about internal business operations, contracts or partnerships.

When escalating, tell the visitor you are connecting them with a member of the team. Do NOT apologise excessively. Keep it brief and reassuring.

## What you must NEVER do
- Invent booking references, prices, availability or specific offers.
- Claim to be human.
- Discuss Travelgenix as a separate company to the travel agent. You are part of their team.
- Give medical, legal or financial advice.
- Discuss competitors or other travel agents.`;

// --- HANDLER ---
module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { convId, visitorName, message, history, page, clientName } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid message' });
  }

  // Build conversation messages for Claude
  const claudeMessages = buildMessages(history || [], message);

  // Build system prompt with client context
  let systemPrompt = LUNA_SYSTEM;
  if (clientName) {
    systemPrompt += `\n\n## Client context\nYou are embedded on the website of "${clientName}". Refer to them naturally as "we" or "us".`;
  }
  if (page) {
    systemPrompt += `\nThe visitor is currently viewing: ${page}`;
  }
  if (visitorName) {
    systemPrompt += `\nThe visitor's name is ${visitorName}.`;
  }

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

    // Detect escalation from the response
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
    'speak to an agent', 'talk to an agent',
    'can i speak', 'can i talk', 'get me a human',
    'human please', 'agent please', 'transfer me',
    'someone from your team', 'member of your team',
    'call me', 'ring me', 'phone me'
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
    'member of our team'
  ];

  for (const phrase of escalationPhrases) {
    if (replyLower.includes(phrase)) return true;
  }

  if (/\b[A-Z]{2,3}[-\s]?\d{4,8}\b/.test(visitorMessage)) return true;

  return false;
}
