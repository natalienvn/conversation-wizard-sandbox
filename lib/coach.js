// Shared logic for the Conversation Wizard Sandbox — used by both the local
// server (server.js) and the Vercel serverless functions (api/*.js).
// Model calls go through the official Anthropic SDK (Claude API).

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic(); // resolves ANTHROPIC_API_KEY from env
  return _client;
}

function loadPromptTemplate() {
  const candidates = [
    path.join(__dirname, '..', 'prompt.txt'),
    path.join(process.cwd(), 'prompt.txt'),
    path.join(process.cwd(), 'care-coach-tester', 'prompt.txt'),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, 'utf8'); } catch (_) { /* try next */ }
  }
  throw new Error('prompt.txt not found');
}

function fillTemplate(template, vars) {
  return template
    .replaceAll('{{conversation_so_far}}', vars.conversation_so_far || '(no prior messages)')
    .replaceAll('{{new_lead_message}}', vars.new_lead_message || '(none)')
    .replaceAll('{{issue_summary}}', vars.issue_summary || '(no intake summary provided)');
}

// Pull the first JSON object out of a model reply, tolerating code fences / preamble.
function extractJson(text) {
  if (!text) return null;
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  for (let end = cleaned.length; end > start; end--) {
    if (cleaned[end - 1] !== '}') continue;
    try { return JSON.parse(cleaned.slice(start, end)); } catch (_) {}
  }
  return null;
}

// Structured-output schema matching the prompt's OUTPUT FORMAT section.
const RECOMMENDATION_SCHEMA = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'Emergency exception',
        'Request information',
        'Live Consultation (phone or video)',
        'Extended/Beyond-Scope Support',
        'Document Review',
      ],
    },
    reason: { type: 'string' },
    issue_label: { type: 'string' },
    suggested_price: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    message: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'low'] },
  },
  required: ['action', 'reason', 'issue_label', 'suggested_price', 'message', 'confidence'],
  additionalProperties: false,
};

function textOf(response) {
  return response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
}

function usageOf(response) {
  const u = response.usage || {};
  return { prompt_tokens: u.input_tokens ?? null, completion_tokens: u.output_tokens ?? null };
}

function errorResult(err) {
  if (/could not resolve authentication/i.test(String(err.message || ''))) {
    return { status: 401, body: { ok: false, error: 'No Anthropic API key configured. Set ANTHROPIC_API_KEY (in .env locally, or in Vercel project settings), or use the mock model.' } };
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return { status: 401, body: { ok: false, error: 'Anthropic API key is missing or invalid. Set ANTHROPIC_API_KEY.' } };
  }
  if (err instanceof Anthropic.RateLimitError) {
    return { status: 429, body: { ok: false, error: 'Rate limited by the Claude API. Wait a moment and try again.' } };
  }
  if (err instanceof Anthropic.APIError) {
    return { status: err.status || 502, body: { ok: false, error: String(err.message || err) } };
  }
  return { status: 502, body: { ok: false, error: String(err.message || err) } };
}

/* ---------------- mock model (no API key needed) ---------------- */

function mockRecommend(payload) {
  const text = `${payload.conversation_so_far || ''} ${payload.new_lead_message || ''}`.toLowerCase();
  let out;
  if (/chest pain|chest pressure|short(ness)? of breath|faint|suicid|one-sided|facial droop|heavy bleeding|left arm/.test(text)) {
    out = {
      action: 'Emergency exception',
      reason: 'MOCK OUTPUT, not real analysis. Red-flag keywords detected. Add a valid ANTHROPIC_API_KEY and pick a real model.',
      issue_label: 'We recommend urgent care (mock output, not real analysis)',
      suggested_price: null,
      message: 'Chest pressure with arm heaviness needs to be checked right away. Please call 911 or go to the nearest ER now. We can talk after you are seen.',
      confidence: 'high',
    };
  } else if (/upload|lab result|panels|records|report|workup/.test(text)) {
    out = {
      action: 'Document Review',
      reason: 'MOCK OUTPUT, not real analysis. Document keywords detected. Add a valid ANTHROPIC_API_KEY and pick a real model.',
      issue_label: 'We recommend a document review (mock output)',
      suggested_price: '$40',
      message: 'I can go through all your panels and write up a clear summary of the trend with my recommendations ($40). Want me to take a closer look?',
      confidence: 'high',
    };
  } else {
    out = {
      action: 'Live Consultation (phone or video)',
      reason: 'MOCK OUTPUT, not real analysis. Canned fallback action. Add a valid ANTHROPIC_API_KEY and pick a real model.',
      issue_label: 'We recommend a live consultation (mock output)',
      suggested_price: 'phone $25 / video $30',
      message: 'This might be easier to sort out live. I can do a phone call ($25) or a video call ($30), whichever you prefer. Chat works too if that is more comfortable.',
      confidence: 'low',
    };
  }
  return {
    ok: true,
    parsed: out,
    raw: JSON.stringify(out, null, 2),
    usage: { prompt_tokens: 0, completion_tokens: 0 },
    model: 'mock',
    latency_ms: 400,
  };
}

function mockAgentChat(payload) {
  const last = (payload.history || []).filter(m => m.role === 'user').pop();
  const text = last ? String(last.content).toLowerCase() : '';
  if (/rewrite|redo|re-write|shorter|softer|warmer|different|change|revise/.test(text)) {
    const rec = payload.last_recommendation || {};
    const out = Object.assign({}, rec, {
      message: 'No rush at all, and chat stays open either way. If it helps, I can hop on a phone call ($25) or video call ($30), your pick.',
      confidence: rec.confidence || 'low',
    });
    return { ok: true, reply: JSON.stringify(out, null, 2), parsed: out, model: 'mock', usage: null, latency_ms: 350 };
  }
  return {
    ok: true,
    reply: 'I picked that step because the thread gave enough context to assess but text was slowing things down. You can accept the draft as is, or ask me to rewrite it (for example: "make it warmer" or "make it shorter").',
    parsed: null, model: 'mock', usage: null, latency_ms: 350,
  };
}

/* ---------------- Claude API calls ---------------- */

// Both return { status, body } so any HTTP layer can send them.
async function recommend(payload) {
  if (payload.model === 'mock') {
    await new Promise((r) => setTimeout(r, 400));
    return { status: 200, body: mockRecommend(payload) };
  }

  const template = (payload.prompt_template && payload.prompt_template.trim())
    ? payload.prompt_template
    : loadPromptTemplate();
  const prompt = fillTemplate(template, payload);
  const model = payload.model || DEFAULT_MODEL;

  try {
    const started = Date.now();
    const response = await getClient().messages.create({
      model,
      max_tokens: 16000,
      output_config: { format: { type: 'json_schema', schema: RECOMMENDATION_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    });
    if (response.stop_reason === 'refusal') {
      return { status: 200, body: { ok: false, error: 'The model declined this request (safety refusal). Adjust the conversation and try again.' } };
    }
    const raw = textOf(response);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = extractJson(raw); }
    return {
      status: 200,
      body: {
        ok: true,
        parsed,
        raw,
        usage: usageOf(response),
        model: response.model || model,
        latency_ms: Date.now() - started,
      },
    };
  } catch (err) {
    return errorResult(err);
  }
}

async function agentChat(payload) {
  if (payload.model === 'mock') {
    await new Promise((r) => setTimeout(r, 350));
    return { status: 200, body: mockAgentChat(payload) };
  }

  const template = (payload.prompt_template && payload.prompt_template.trim())
    ? payload.prompt_template
    : loadPromptTemplate();
  const basePrompt = fillTemplate(template, payload);
  const system = [
    'You are the care-coaching assistant described below. You already produced a recommendation for this conversation, and the EXPERT is now chatting with you about it: they may ask why you chose it, ask you to rewrite the draft message, or discuss alternatives.',
    '',
    '=== YOUR ORIGINAL INSTRUCTIONS AND INPUTS ===',
    basePrompt,
    '',
    '=== YOUR CURRENT RECOMMENDATION ===',
    JSON.stringify(payload.last_recommendation || {}, null, 2),
    '',
    '=== HOW TO REPLY IN THIS CHAT ===',
    '- You are talking to the expert, not the customer. Be brief, direct, and collegial.',
    '- If the expert asks you to revise, rewrite, or change the recommendation or its draft message, reply with ONLY the full updated JSON object in the exact same schema as your original output, nothing else. All the original rules (safety override, membership exclusions, character limits, pricing) still apply.',
    '- Otherwise reply in plain conversational text (no JSON).',
  ].join('\n');

  const messages = (payload.history || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
  }));

  try {
    const started = Date.now();
    const response = await getClient().messages.create({
      model: payload.model || DEFAULT_MODEL,
      max_tokens: 16000,
      system,
      messages,
    });
    if (response.stop_reason === 'refusal') {
      return { status: 200, body: { ok: false, error: 'The model declined this request (safety refusal).' } };
    }
    const reply = textOf(response);
    const parsed = extractJson(reply);
    const isRec = parsed && parsed.action && parsed.message;
    return {
      status: 200,
      body: {
        ok: true,
        reply,
        parsed: isRec ? parsed : null,
        usage: usageOf(response),
        model: response.model || payload.model,
        latency_ms: Date.now() - started,
      },
    };
  } catch (err) {
    return errorResult(err);
  }
}

module.exports = { loadPromptTemplate, fillTemplate, extractJson, recommend, agentChat };
