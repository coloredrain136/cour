// Cour — passcode-gated proxy to Supabase (PostgREST).
// The browser never sees the Supabase secret key; it only sends the passcode.
//
// Env vars (Vercel → Settings → Environment Variables):
//   SUPABASE_URL          https://xxxx.supabase.co
//   SUPABASE_SECRET_KEY   sb_secret_... (or the legacy service_role key)
//   COUR_PASSCODE         whatever you want to type once per device

const { VERSION, TABLES, same, sb, readBody, configured } = require('./_lib/cour');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured() || !process.env.COUR_PASSCODE) {
    return res.status(500).json({ error: 'Server not configured — add SUPABASE_URL, SUPABASE_SECRET_KEY and COUR_PASSCODE in Vercel, then redeploy.' });
  }
  if (!same(req.headers['x-cour-key'], process.env.COUR_PASSCODE)) {
    return res.status(401).json({ error: 'Wrong passcode' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const b = await readBody(req);

    // One round trip for app start: whole library + pending inbox + settings.
    if (b.op === 'ping') return res.json({ ok: true, version: VERSION });
    if (b.op === 'load') {
      const [shows, suggestions, settings] = await Promise.all([
        sb('shows', { query: 'select=*&order=updated_at.desc&limit=5000' }),
        sb('suggestions', { query: 'select=*&status=eq.pending&order=created_at.asc' }),
        sb('settings', { query: 'select=key,value' }),
      ]);
      return res.json({ shows, suggestions, settings, version: VERSION, at: new Date().toISOString() });
    }

    // Generic, whitelisted table call (app uses short names; server maps to cour_ tables).
    if (!TABLES[b.table]) return res.status(400).json({ error: 'Unknown table' });
    const method = String(b.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(method)) return res.status(400).json({ error: 'Bad method' });
    if ((method === 'PATCH' || method === 'DELETE') && !b.query) {
      return res.status(400).json({ error: 'PATCH/DELETE need a filter' }); // never touch every row by accident
    }
    const data = await sb(b.table, { method, query: b.query || '', body: b.body, prefer: b.prefer });
    return res.json({ data });
  } catch (e) {
    return res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message, detail: e.detail || null });
  }
};
