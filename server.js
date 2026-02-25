import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const CEREBRAS_KEY = process.env.CEREBRAS_API_KEY || '';

// Load .env manually (no dotenv dependency needed)
try {
  const env = readFileSync(path.join(__dirname, '.env'), 'utf8');
  env.split('\n').forEach(line => {
    line = line.trim();
    if (!line || line.startsWith('#')) return;
    const [key, ...val] = line.split('=');
    if (key && !process.env[key]) process.env[key] = val.join('=').trim();
  });
} catch (_) { /* .env optional */ }

const CEREBRAS_KEY_RESOLVED = process.env.CEREBRAS_API_KEY || CEREBRAS_KEY;

const ALLOWED_MODELS = new Set(['gpt-oss-120b', 'llama3.1-8b']);
const DEFAULT_MODEL  = 'gpt-oss-120b';

const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(__dirname));

// ── SearXNG search (local instance, no API key needed) ──
const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

app.get('/ping', (req, res) => res.json({ ok: true }));

app.get('/api/search-health', async (_req, res) => {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(`${SEARXNG_URL}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    res.json({ ok: resp.ok, searxng: SEARXNG_URL });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message, searxng: SEARXNG_URL });
  }
});

async function searxngSearch(query, count = 3) {
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      safesearch: '0',
    });

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const resp = await fetch(`${SEARXNG_URL}/search?${params}`, {
      signal: ctrl.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'MacAGI/1.0',
      },
    });
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`SearXNG HTTP ${resp.status}`);
    const data = await resp.json();

    const hits = (data.results || []).slice(0, count).map(r => ({
      title: r.title   || '',
      url:   r.url     || '',
      desc:  r.content || '',
    }));

    return { results: hits };
  } catch (err) {
    console.warn('SearXNG search error:', err.message);
    if (err.name === 'AbortError') {
      console.warn('  → Request timed out. Is SearXNG running? Check: docker compose up -d');
    } else if (err.cause?.code === 'ECONNREFUSED') {
      console.warn(`  → Connection refused at ${SEARXNG_URL}. Start SearXNG: docker compose up -d`);
    }
    return { results: [], error: err.message };
  }
}

app.post('/api/chat', async (req, res) => {
  const { messages, model, search: doSearch, think: doThink, existingSources } = req.body;

  if (!Array.isArray(messages) || !messages.length)
    return res.status(400).json({ error: 'messages array required' });

  if (!CEREBRAS_KEY_RESOLVED)
    return res.status(500).json({ error: 'CEREBRAS_API_KEY not set' });

  const chosenModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  let sources = [];
  let finalMessages = [...messages];

  // If existingSources provided (follow-up prompt), reuse them; otherwise search
  if (Array.isArray(existingSources) && existingSources.length) {
    sources = existingSources;
    console.log(`⌕ reusing ${sources.length} existing sources (follow-up detected)`);
    const ctx = sources.map((r, i) =>
      `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.desc}`
    ).join('\n\n');
    const insertAt = finalMessages.length - 1;
    finalMessages.splice(insertAt, 0, {
      role: 'user',
      content: `Web search results for context:\n\n${ctx}\n\n---\nAnswer the user\'s question using the above sources where relevant. Cite inline as [1], [2] etc.`,
    });
  } else {
    // Determine result count: think=55, search=45, default=3
    const resultCount = doThink ? 55 : doSearch ? 45 : 3;
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    const query = lastUser?.content?.slice(0, 200) || '';
    console.log(`⌕ searxng (${resultCount} results): "${query.slice(0, 80)}"`);
    const { results, error } = await searxngSearch(query, resultCount);
    sources = results;

    if (results.length) {
      const ctx = results.map((r, i) =>
        `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.desc}`
      ).join('\n\n');
      const insertAt = finalMessages.length - 1;
      finalMessages.splice(insertAt, 0, {
        role: 'user',
        content: `Web search results for context:\n\n${ctx}\n\n---\nAnswer the user\'s question using the above sources where relevant. Cite inline as [1], [2] etc.`,
      });
    } else if (error) {
      console.warn('Search failed:', error);
    }
  }

  console.log(`→ model:${chosenModel} search:${!!doSearch} think:${!!doThink} sources:${sources.length} msgs:${finalMessages.length}`);

  try {
    const cr = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CEREBRAS_KEY_RESOLVED}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ model: chosenModel, messages: finalMessages, max_tokens: 4096 }),
    });

    const data = await cr.json();
    if (!cr.ok) {
      const msg = data?.error?.message || `HTTP ${cr.status}`;
      console.error('✗', msg);
      return res.status(cr.status).json({ error: msg });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    console.log(`✓ reply ${reply.length} chars`);
    res.json({ reply, sources });
  } catch (err) {
    console.error('✗', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✓ http://localhost:${PORT}`);
  if (!CEREBRAS_KEY_RESOLVED) console.warn('⚠  CEREBRAS_API_KEY not set');

  // Check SearXNG connectivity on startup
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    const resp = await fetch(`${SEARXNG_URL}/healthz`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (resp.ok) console.log(`✓ SearXNG reachable at ${SEARXNG_URL}`);
    else console.warn(`⚠  SearXNG returned HTTP ${resp.status} at ${SEARXNG_URL}`);
  } catch (_) {
    console.warn(`⚠  SearXNG not reachable at ${SEARXNG_URL} — run: docker compose up -d`);
  }
});
