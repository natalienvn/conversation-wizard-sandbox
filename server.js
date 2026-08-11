// Conversation Wizard Sandbox — local dev server (zero dependencies).
// Serves public/ and the same API the Vercel functions in api/ expose.
// All model logic lives in lib/coach.js, shared with the serverless deploy.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadPromptTemplate, loadProjects, recommend, agentChat } = require('./lib/coach');

const PORT = process.env.PORT || 4477;
const ROOT = __dirname;

function loadEnv() {
  const candidates = [path.join(ROOT, '.env'), path.join(ROOT, '..', '.env')];
  for (const p of candidates) {
    try {
      const text = fs.readFileSync(p, 'utf8');
      for (const line of text.split('\n')) {
        const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
        if (m && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch (_) { /* no .env at this path */ }
  }
}
loadEnv();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function send(res, status, body, type) {
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/api/projects') {
    return send(res, 200, JSON.stringify({ projects: loadProjects() }));
  }

  if (req.method === 'GET' && url.pathname === '/api/prompt') {
    return send(res, 200, JSON.stringify({ template: loadPromptTemplate() }));
  }

  if (req.method === 'POST' && (url.pathname === '/api/recommend' || url.pathname === '/api/agent-chat')) {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20e6) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch (_) {
        return send(res, 400, JSON.stringify({ ok: false, error: 'Bad JSON body' }));
      }
      const handler = url.pathname === '/api/recommend' ? recommend : agentChat;
      const result = await handler(payload);
      send(res, result.status, JSON.stringify(result.body));
    });
    return;
  }

  // static files
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(ROOT, 'public', file);
  if (!full.startsWith(path.join(ROOT, 'public'))) return send(res, 403, 'Forbidden', 'text/plain');
  fs.readFile(full, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, MIME[path.extname(full)] || 'application/octet-stream');
  });
});

server.listen(PORT, () => {
  console.log(`Conversation Wizard Sandbox running at http://localhost:${PORT}`);
  console.log(process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY loaded.' : 'WARNING: ANTHROPIC_API_KEY missing (mock model still works).');
});
