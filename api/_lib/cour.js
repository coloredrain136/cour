// Cour — shared server helpers (not a route: files in api/_lib are private).
const crypto = require('crypto');

const VERSION = 'cour-4';

// App-facing names → real Supabase tables (Builds project, cour_ prefix).
const TABLES = {
  shows: 'cour_shows',
  suggestions: 'cour_suggestions',
  settings: 'cour_settings',
  lists: 'cour_lists',
  list_items: 'cour_list_items',
};

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

const sbKey = () => process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const configured = () => !!(process.env.SUPABASE_URL && sbKey());

function sbHeaders(extra) {
  const key = sbKey();
  const h = { apikey: key, 'Content-Type': 'application/json', ...extra };
  // Legacy JWT keys also go in Authorization; new sb_secret_ keys must not.
  if (!key.startsWith('sb_')) h.Authorization = 'Bearer ' + key;
  return h;
}

// table = app-facing name ('shows') or a real cour_ name.
async function sb(table, { method = 'GET', query = '', body, prefer } = {}) {
  const real = TABLES[table] || table;
  if (!Object.values(TABLES).includes(real)) throw Object.assign(new Error('Unknown table'), { status: 400 });
  const base = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
  const url = `${base}/rest/v1/${real}${query ? '?' + query : ''}`;
  const r = await fetch(url, {
    method,
    headers: sbHeaders(prefer ? { Prefer: prefer } : {}),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error((data && data.message) || `Supabase ${r.status}`);
    err.status = r.status; err.detail = data;
    throw err;
  }
  return data;
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : {};
}

module.exports = { VERSION, TABLES, same, sb, readBody, configured };
