// Shared logic for the Conversation Wizard Sandbox — used by both the local
// server (server.js) and the Vercel serverless functions (api/*.js).
// Model calls go through the official Anthropic SDK (Claude API).
//
// PROJECTS
// Each project is one file in prompts/<id>.md:
//     { ...JSON config... }
//     ---
//     <prompt text>
// The JSON header is optional; a file that is only prompt text still works.

const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const DEFAULT_MODEL = 'claude-opus-5';

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic(); // resolves ANTHROPIC_API_KEY from env
  return _client;
}

/* ---------------- project loading ---------------- */

function promptsDir() {
  const candidates = [
    path.join(__dirname, '..', 'prompts'),
    path.join(process.cwd(), 'prompts'),
    path.join(process.cwd(), 'care-coach-tester', 'prompts'),
  ];
  for (const p of candidates) {
    try { if (fs.statSync(p).isDirectory()) return p; } catch (_) { /* try next */ }
  }
  return null;
}

// Split "{json}\n---\n<text>" into a config object and the prompt body.
function parseProjectFile(id, raw) {
  let config = {};
  let template = raw;
  const trimmed = raw.replace(/^﻿/, '').trimStart();
  if (trimmed.startsWith('{')) {
    const marker = trimmed.search(/\n-{3,}[ \t]*\n/);
    if (marker !== -1) {
      const head = trimmed.slice(0, marker);
      const body = trimmed.slice(marker).replace(/^\n-{3,}[ \t]*\n/, '');
      try {
        config = JSON.parse(head);
        template = body;
      } catch (_) {
        // Malformed header: treat the whole file as prompt text rather than failing.
        config = {};
        template = raw;
      }
    }
  }
  return {
    id,
    name: config.name || id,
    description: config.description || '',
    default: !!config.default,
    roles: config.roles || null,
    schema: config.schema || null,
    display: config.display || null,
    template: template.trim() + '\n',
  };
}

let _projectCache = null;
function loadProjects() {
  if (_projectCache) return _projectCache;
  const dir = promptsDir();
  let projects = [];
  if (dir) {
    for (const file of fs.readdirSync(dir).sort()) {
      if (!/\.(md|txt)$/i.test(file) || /^readme\./i.test(file)) continue;
      const id = file.replace(/\.(md|txt)$/i, '');
      try {
        projects.push(parseProjectFile(id, fs.readFileSync(path.join(dir, file), 'utf8')));
      } catch (_) { /* skip unreadable file */ }
    }
  }
  // Legacy fallback: a bare prompt.txt at the root still works as one project.
  if (!projects.length) {
    for (const p of [path.join(__dirname, '..', 'prompt.txt'), path.join(process.cwd(), 'prompt.txt')]) {
      try {
        projects = [parseProjectFile('default', fs.readFileSync(p, 'utf8'))];
        break;
      } catch (_) { /* try next */ }
    }
  }
  // Default project sorts first so the picker opens on it.
  projects.sort((a, b) => (b.default ? 1 : 0) - (a.default ? 1 : 0) || a.name.localeCompare(b.name));
  _projectCache = projects;
  return projects;
}

function getProject(id) {
  const projects = loadProjects();
  return (id && projects.find((p) => p.id === id)) || projects[0] || null;
}

// Resolve the prompt/schema/display for one request. A client-supplied
// template (an unsaved edit, or a browser-only project) always wins.
function resolveRequest(payload) {
  const projects = loadProjects();
  // An id we do not recognise means a browser-only project: keep `project`
  // null so we never fall back to another project's schema or mock output.
  const project = payload.project_id
    ? (projects.find((p) => p.id === payload.project_id) || null)
    : (projects[0] || null);
  const template = (payload.prompt_template && payload.prompt_template.trim())
    ? payload.prompt_template
    : (project ? project.template : '');
  if (!template) throw new Error('No prompt found. Add a file to the prompts/ folder.');
  const schema = payload.schema !== undefined ? payload.schema : (project ? project.schema : null);
  return { project, template, schema };
}

/* ---------------- template filling ---------------- */

// Every placeholder name below maps to the same value, so a new project can
// call it {{transcript}} or {{conversation}} without changing any code.
const VAR_ALIASES = {
  conversation_so_far: ['conversation_so_far', 'conversation', 'transcript', 'chat_history', 'history', 'thread', 'messages'],
  new_lead_message: ['new_lead_message', 'latest_message', 'last_message', 'new_message', 'customer_message', 'user_message', 'input'],
  issue_summary: ['issue_summary', 'summary', 'intake', 'intake_summary', 'context', 'background'],
};
const VAR_FALLBACK = {
  conversation_so_far: '(no prior messages)',
  new_lead_message: '(none)',
  issue_summary: '(no intake summary provided)',
};

function fillTemplate(template, vars) {
  let out = template;
  for (const [canonical, names] of Object.entries(VAR_ALIASES)) {
    const value = vars[canonical] || VAR_FALLBACK[canonical];
    for (const name of names) out = out.replaceAll(`{{${name}}}`, value);
  }
  return out;
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

// Occasionally a run comes back schema-valid but with required strings blank.
// One clean retry turns that dead end into a usable result.
const FILLER = /^(placeholder|n\/a|na|tbd|todo|none|null|string|text|\.\.\.|<.*>)$/i;
function hasEmptyRequired(parsed, schema) {
  if (!parsed || !schema || !Array.isArray(schema.required)) return false;
  return schema.required.some((k) => {
    const v = parsed[k];
    return typeof v === 'string' && (!v.trim() || FILLER.test(v.trim()));
  });
}

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

function careCoachMock(text) {
  if (/chest pain|chest pressure|short(ness)? of breath|faint|suicid|one-sided|facial droop|heavy bleeding|left arm/.test(text)) {
    return {
      action: 'Emergency exception',
      reason: 'MOCK OUTPUT, not real analysis. Red-flag keywords detected. Add a valid ANTHROPIC_API_KEY and pick a real model.',
      issue_label: 'We recommend urgent care (mock output, not real analysis)',
      suggested_price: null,
      message: 'Chest pressure with arm heaviness needs to be checked right away. Please call 911 or go to the nearest ER now. We can talk after you are seen.',
      confidence: 'high',
    };
  }
  if (/upload|lab result|panels|records|report|workup/.test(text)) {
    return {
      action: 'Document Review',
      reason: 'MOCK OUTPUT, not real analysis. Document keywords detected. Add a valid ANTHROPIC_API_KEY and pick a real model.',
      issue_label: 'We recommend a document review (mock output)',
      suggested_price: '$40',
      message: 'I can go through all your panels and write up a clear summary of the trend with my recommendations ($40). Want me to take a closer look?',
      confidence: 'high',
    };
  }
  return {
    action: 'Live Consultation (phone or video)',
    reason: 'MOCK OUTPUT, not real analysis. Canned fallback action. Add a valid ANTHROPIC_API_KEY and pick a real model.',
    issue_label: 'We recommend a live consultation (mock output)',
    suggested_price: 'phone $25 / video $30',
    message: 'This might be easier to sort out live. I can do a phone call ($25) or a video call ($30), whichever you prefer. Chat works too if that is more comfortable.',
    confidence: 'low',
  };
}

// For any project other than care-coach, build a placeholder object that
// matches whatever schema/display the project declares.
function genericMock(schema, display) {
  const out = {};
  const props = (schema && schema.properties) || {};
  for (const [key, def] of Object.entries(props)) {
    if (Array.isArray(def.enum) && def.enum.length) out[key] = def.enum[0];
    else if (def.type === 'number' || def.type === 'integer') out[key] = 0;
    else if (def.type === 'boolean') out[key] = false;
    else if (def.type === 'array') out[key] = [];
    else out[key] = `MOCK OUTPUT for "${key}" — not real analysis. Pick a real model to run this prompt.`;
  }
  if (!Object.keys(out).length) {
    const d = display || {};
    out[d.headline || 'result'] = 'Mock result';
    out[d.reason || 'reason'] = 'MOCK OUTPUT, not real analysis. Pick a real model to run this prompt.';
    out[d.message || 'message'] = 'This is placeholder text from the mock model, not a real response.';
  }
  return out;
}

function mockRecommend(payload, resolved) {
  const isCareCoach = resolved.project && resolved.project.id === 'care-coach';
  const text = `${payload.conversation_so_far || ''} ${payload.new_lead_message || ''}`.toLowerCase();
  const out = isCareCoach
    ? careCoachMock(text)
    : genericMock(resolved.schema, resolved.project && resolved.project.display);
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
  const last = (payload.history || []).filter((m) => m.role === 'user').pop();
  const text = last ? String(last.content).toLowerCase() : '';
  if (/rewrite|redo|re-write|shorter|softer|warmer|different|change|revise/.test(text)) {
    const rec = payload.last_recommendation || {};
    const out = Object.assign({}, rec);
    const msgKey = Object.keys(out).find((k) => /message|draft|reply/i.test(k));
    if (msgKey) out[msgKey] = 'MOCK REWRITE, not real analysis. Pick a real model to get a genuine rewrite.';
    return { ok: true, reply: JSON.stringify(out, null, 2), parsed: out, model: 'mock', usage: null, latency_ms: 350 };
  }
  return {
    ok: true,
    reply: 'MOCK REPLY, not real analysis. Pick a real model to actually discuss this recommendation. You can still accept the draft or ask for a rewrite to exercise the UI.',
    parsed: null, model: 'mock', usage: null, latency_ms: 350,
  };
}

/* ---------------- Claude API calls ---------------- */

// Both return { status, body } so any HTTP layer can send them.
async function recommend(payload) {
  let resolved;
  try { resolved = resolveRequest(payload); }
  catch (err) { return { status: 400, body: { ok: false, error: String(err.message || err) } }; }

  if (payload.model === 'mock') {
    await new Promise((r) => setTimeout(r, 400));
    return { status: 200, body: mockRecommend(payload, resolved) };
  }

  const prompt = fillTemplate(resolved.template, payload);
  const model = payload.model || DEFAULT_MODEL;

  const request = {
    model,
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  };
  // A project without a schema still gets JSON back — the prompt asks for it
  // and extractJson() parses it — it just is not schema-enforced.
  if (resolved.schema) {
    request.output_config = { format: { type: 'json_schema', schema: resolved.schema } };
  }

  try {
    const started = Date.now();
    const response = await getClient().messages.create(request);
    if (response.stop_reason === 'refusal') {
      return { status: 200, body: { ok: false, error: 'The model declined this request (safety refusal). Adjust the conversation and try again.' } };
    }
    let raw = textOf(response);
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = extractJson(raw); }

    let retried = false;
    if (hasEmptyRequired(parsed, resolved.schema)) {
      retried = true;
      const second = await getClient().messages.create(request);
      if (second.stop_reason !== 'refusal') {
        const raw2 = textOf(second);
        let parsed2 = null;
        try { parsed2 = JSON.parse(raw2); } catch (_) { parsed2 = extractJson(raw2); }
        if (parsed2 && !hasEmptyRequired(parsed2, resolved.schema)) { parsed = parsed2; raw = raw2; }
      }
    }

    return {
      status: 200,
      body: {
        ok: true,
        parsed,
        raw,
        retried,
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

  let resolved;
  try { resolved = resolveRequest(payload); }
  catch (err) { return { status: 400, body: { ok: false, error: String(err.message || err) } }; }

  const basePrompt = fillTemplate(resolved.template, payload);
  const system = [
    'You are the assistant described below. You already produced a recommendation for this conversation, and the OPERATOR who reviews your output is now chatting with you about it: they may ask why you chose it, ask you to rewrite the drafted text, or discuss alternatives.',
    '',
    '=== YOUR ORIGINAL INSTRUCTIONS AND INPUTS ===',
    basePrompt,
    '',
    '=== YOUR CURRENT RECOMMENDATION ===',
    JSON.stringify(payload.last_recommendation || {}, null, 2),
    '',
    '=== HOW TO REPLY IN THIS CHAT ===',
    '- You are talking to the operator reviewing your work, not the end customer. Be brief, direct, and collegial.',
    '- If they ask you to revise, rewrite, or change the recommendation or its drafted text, reply with ONLY the full updated JSON object in the exact same shape as your original output, nothing else. All the original rules still apply.',
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
    // Treat it as a revised recommendation only if it looks like the same shape.
    const keys = parsed ? Object.keys(parsed) : [];
    const isRec = !!parsed && keys.length > 1
      && keys.some((k) => /action|message|draft|recommend|reply/i.test(k));
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

// Back-compat: the original single-prompt endpoint.
function loadPromptTemplate() {
  const p = getProject(null);
  if (!p) throw new Error('prompt not found');
  return p.template;
}

module.exports = {
  loadProjects, getProject, loadPromptTemplate,
  fillTemplate, extractJson, recommend, agentChat,
};
