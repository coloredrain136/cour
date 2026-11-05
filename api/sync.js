// Cour — nightly Crunchyroll sync endpoint (Muse today, Claude later).
//
// The agent reads Joe's Crunchyroll watch history and posts what it found here.
// Cour does the thinking: match each item to the library, move progress forward,
// add new shows as Watching, and send anything it isn't sure about to the inbox.
// Safe to send the same items again: progress only ever moves forward.
//
// Env var: COUR_SYNC_KEY — its own secret (not the app passcode). Sent as the
//   header  x-cour-sync-key: <key>   (or  Authorization: Bearer <key>).
//
// GET  /api/sync  → { ok, version, last_run, since, cleanup }   (what to check from + dropped shows to clear off Crunchyroll)
// POST /api/sync  → body:
//   { "source": "muse", "dry_run": false, "needs_login": false,
//     "items": [ { "series": "Frieren: Beyond Journey's End", "season": 2, "season_title": null,
//                  "episode": 5, "episode_title": "…", "watched_at": "2026-11-04T23:10:00-05:00",
//                  "audio": "dub", "finished": true, "url": "https://www.crunchyroll.com/series/GG5H5XQ7D/…" } ],
//     "cleanup_done": [12345], "cleanup_failed": [{ "id": 678, "reason": "not in history" }] }

const { VERSION, same, sb, readBody, configured } = require('./_lib/cour');

const MAX_ITEMS = 150;
const ANI = 'https://graphql.anilist.co';
const MF = 'id idMal title{english romaji native} synonyms coverImage{medium large color} format episodes status seasonYear startDate{year month day} nextAiringEpisode{episode airingAt} relations{edges{relationType node{id type format startDate{year month day}}}} externalLinks{site url}';
const SERIES_FORMATS = new Set(['TV', 'TV_SHORT', 'ONA']);

/* ───────── text matching ───────── */
function norm(t) {
  return String(t || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\((english|japanese|spanish|portuguese|french|german|hindi)?\s*(dub|sub|subtitled|dubbed)\)/g, ' ')
    .replace(/\b(english|japanese)\s+(dub|sub)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
// "Show Season 2" / "Show 2nd Season" / "Show Part 2" → "Show"
function baseTitle(t) {
  return norm(t)
    .replace(/\b(season|part|cour)\s*\d+\b/g, ' ')
    .replace(/\b\d+(st|nd|rd|th)\s+(season|part|cour)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
const titlesOf = (s) => [s.title_en, s.title_romaji, ...(s.synonyms || [])].filter(Boolean);
function titleHit(s, series) {
  const n = norm(series), b = baseTitle(series), c = n.replace(/ /g, '');
  if (!n) return 0;
  let best = 0;
  for (const t of titlesOf(s)) {
    const tn = norm(t), tb = baseTitle(t);
    if (tn === n || tn.replace(/ /g, '') === c) return 2;               // exact ("DAN DA DAN" = "Dandadan")
    if (b && (tb === b || tn === b)) best = 2;                           // same once "Season N" is stripped
    else if (b && norm(String(t).split(':')[0]) === b) best = 2;         // "Show: Subtitle" on AniList, "Show" on CR
    else if (best < 1 && b.length >= 6 && (tn.startsWith(b + ' ') || (tn.length >= 6 && b.startsWith(tn + ' ')))) best = 1;  // looser: inbox only
  }
  return best;
}
const seriesId = (url) => { const m = String(url || '').match(/crunchyroll\.com\/(?:[a-z-]+\/)?series\/([A-Z0-9]+)/i); return m ? m[1].toUpperCase() : null; };
const pad = (n) => String(n).padStart(2, '0');
const startKey = (s) => s.start_date || '9999';
const byStart = (a, b) => startKey(a).localeCompare(startKey(b)) || a.anilist_id - b.anilist_id;
const toISO = (v) => { const d = new Date(v || Date.now()); return isNaN(d) ? new Date().toISOString() : d.toISOString(); };
const isSeries = (s) => !s.format || SERIES_FORMATS.has(s.format);

/* ───────── AniList (server side) ───────── */
async function ani(query, variables, tries = 0) {
  const r = await fetch(ANI, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ query, variables }) });
  if (r.status === 429 && tries < 2) { await new Promise((ok) => setTimeout(ok, 2500)); return ani(query, variables, tries + 1); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || (j.errors && !j.data)) throw new Error((j.errors && j.errors[0] && j.errors[0].message) || 'AniList ' + r.status);
  return j.data;
}
const aniSearch = async (q) => (await ani(`query($q:String){Page(perPage:10){media(search:$q,type:ANIME,sort:SEARCH_MATCH,isAdult:false){${MF}}}}`, { q })).Page.media;
const aniGet = async (id) => (await ani(`query($id:Int){Media(id:$id,type:ANIME){${MF}}}`, { id })).Media;

function metaFrom(m) {
  const sd = m.startDate || {};
  const cr = (m.externalLinks || []).find((l) => /crunchyroll/i.test(l.site));
  return {
    anilist_id: m.id,
    mal_id: m.idMal || null,
    title_en: m.title.english || null,
    title_romaji: m.title.romaji || null,
    title_native: m.title.native || null,
    synonyms: (m.synonyms || []).slice(0, 8),
    cover: (m.coverImage && m.coverImage.medium) || null,
    cover_lg: (m.coverImage && m.coverImage.large) || null,
    cover_color: (m.coverImage && m.coverImage.color) || null,
    format: m.format || null,
    total_eps: m.episodes || null,
    airing_status: m.status || null,
    season_year: m.seasonYear || sd.year || null,
    start_date: sd.year ? `${sd.year}-${pad(sd.month || 1)}-${pad(sd.day || 1)}` : null,
    relations: ((m.relations && m.relations.edges) || []).filter((e) => e.node.type === 'ANIME' && (e.relationType === 'PREQUEL' || e.relationType === 'SEQUEL')).map((e) => e.node.id),
    sub_next_ep: (m.nextAiringEpisode && m.nextAiringEpisode.episode) || null,
    sub_next_at: m.nextAiringEpisode ? new Date(m.nextAiringEpisode.airingAt * 1000).toISOString() : null,
    cr_url: cr ? cr.url : null,
    meta_updated_at: new Date().toISOString(),
  };
}
// Next SEQUEL in series format (skips movies/OVAs/recaps).
const sequelOf = (m) => {
  const e = ((m.relations && m.relations.edges) || []).filter((x) => x.relationType === 'SEQUEL' && x.node.type === 'ANIME' && SERIES_FORMATS.has(x.node.format));
  return e.length ? e[0].node.id : null;
};

/* ───────── the engine (pure-ish: all I/O goes through `io`, so tests can fake it) ───────── */
async function plan(items, lib, io) {
  const shows = new Map(lib.map((s) => [s.anilist_id, { ...s }]));
  const fr = (s) => s.franchise_key ?? s.anilist_id;
  const groupOf = (key) => [...shows.values()].filter((x) => fr(x) === key).sort(byStart);

  const out = { updated: [], added: [], inbox: [], skipped: [], notes: [] };
  const patches = new Map();   // anilist_id → fields
  const inserts = new Map();   // anilist_id → full row
  const suggs = [];            // { show_id, kind, payload }
  const crSeries = new Map();  // CR series id → franchise key (learned from cr_url)
  for (const s of shows.values()) { const id = seriesId(s.cr_url); if (id && !crSeries.has(id)) crSeries.set(id, fr(s)); }

  // 1) Group the history by series + season, keep the furthest episode.
  const byKey = new Map();
  for (const raw of items.slice(0, MAX_ITEMS)) {
    const it = {
      series: String(raw.series || raw.title || '').trim(),
      season: Number.isFinite(+raw.season) && +raw.season > 0 ? Math.floor(+raw.season) : null,
      season_title: raw.season_title ? String(raw.season_title) : null,
      episode: Number.isFinite(+raw.episode) ? Math.floor(+raw.episode) : null,
      at: toISO(raw.watched_at),
      audio: /dub/i.test(raw.audio || '') ? 'dub' : /sub|jap/i.test(raw.audio || '') ? 'sub' : null,
      finished: raw.finished !== false,
      url: raw.url ? String(raw.url) : null,
    };
    if (!it.series || !it.episode) { out.skipped.push({ series: it.series || '?', reason: 'missing series or episode' }); continue; }
    if (!it.finished) { out.skipped.push({ series: it.series, episode: it.episode, reason: 'not finished yet' }); continue; }
    const k = norm(it.series) + '|' + (it.season || '') + '|' + norm(it.season_title || '');
    const cur = byKey.get(k);
    if (!cur) byKey.set(k, { ...it, from: it.episode });
    else {
      cur.from = Math.min(cur.from, it.episode);
      if (it.episode > cur.episode) { cur.episode = it.episode; cur.at = it.at; }
      else if (it.at > cur.at) cur.at = it.at;
      cur.audio = cur.audio || it.audio; cur.url = cur.url || it.url;
    }
  }

  const label = (s) => s.title_en || s.title_romaji || ('#' + s.anilist_id);

  // Pick the season inside a franchise; may walk AniList sequels for seasons not in the library.
  async function pickSeason(key, it) {
    const all = groupOf(key);
    const tv = all.filter(isSeries);
    const list = tv.length ? tv : all;
    // a) season title given ("Mushoku Tensei II") — match it directly
    if (it.season_title) {
      const hit = list.filter((s) => titleHit(s, it.season_title) === 2 && titlesOf(s).some((t) => norm(t) === norm(it.season_title)));
      if (hit.length === 1) return { show: hit[0], sure: true };
    }
    // b) exactly one season in progress and this episode is the next thing in it → that one.
    //    (Beats season numbers: Crunchyroll "Season 2" often isn't AniList's 2nd entry because of split cours.)
    const open = list.filter((s) => s.status === 'watching');
    const fitsIn = (s) => it.episode > (s.eps_watched || 0) && (!s.total_eps || it.episode <= s.total_eps);
    if (open.length === 1 && fitsIn(open[0])) return { show: open[0], sure: true };
    // c) season number given
    if (it.season) {
      if (it.season <= list.length) {
        const s = list[it.season - 1];
        const done = s.total_eps && (s.eps_watched || 0) >= s.total_eps;
        // Pointing at a season that's already finished, with an episode inside it, means the numbering doesn't line up.
        if (done && it.episode <= s.total_eps) return { show: s, sure: false, mismatch: true };
        return { show: s, sure: true };
      }
      // Walk sequels from the last season we have — only trusted if the library starts at season 1.
      const first = await io.get(list[0].anilist_id);
      const hasPrequel = first && ((first.relations && first.relations.edges) || []).some((x) => x.relationType === 'PREQUEL' && x.node.type === 'ANIME' && SERIES_FORMATS.has(x.node.format));
      let m = null, last = list[list.length - 1];
      for (let step = list.length; step < it.season && last; step++) {
        const base = m || (await io.get(last.anilist_id));
        const next = base && sequelOf(base);
        if (!next) return null;
        m = await io.get(next);
        last = { anilist_id: next };
      }
      return m ? { media: m, sure: !hasPrequel } : null;
    }
    // d) no season info: one series entry → that one
    if (list.length === 1) return { show: list[0], sure: true };
    if (open.length === 1) return { show: open[0], sure: true };
    const fits = list.filter((s) => s.status !== 'completed' && (!s.total_eps || it.episode <= s.total_eps) && it.episode > (s.eps_watched || 0));
    if (fits.length === 1) return { show: fits[0], sure: true };
    const guess = open[open.length - 1] || fits[0] || list.find((s) => s.status !== 'completed') || list[list.length - 1];
    return { show: guess, sure: false };
  }

  // Crunchyroll sometimes numbers episodes straight through (S2 starts at ep 13).
  function overflow(show, ep) {
    if (!show.total_eps || ep <= show.total_eps) return { show, ep };
    const tv = groupOf(fr(show)).filter(isSeries);
    let i = tv.findIndex((x) => x.anilist_id === show.anilist_id), e = ep;
    while (i >= 0 && tv[i] && tv[i].total_eps && e > tv[i].total_eps && tv[i + 1]) { e -= tv[i].total_eps; i++; }
    return { show: tv[i] || show, ep: e };
  }

  function bump(show, it, sure) {
    const { show: s, ep } = overflow(show, it.episode);
    const cur = s.eps_watched || 0;
    if (ep <= cur) { out.skipped.push({ series: it.series, episode: it.episode, reason: `already at ep ${cur}` }); return; }
    if (!sure) {
      suggs.push({ show_id: s.anilist_id, kind: 'progress', payload: { from: Math.max(cur + 1, Math.min(it.from, ep)), to: ep, at: it.at, title: label(s) } });
      out.inbox.push({ title: label(s), episode: ep, why: 'not sure which season' });
      return;
    }
    const f = { eps_watched: ep, last_watched_at: it.at, snooze_until: null };
    if (s.status !== 'watching') { f.status = 'watching'; if (!s.started_at) f.started_at = it.at.slice(0, 10); }
    if (s.cr_cleanup === 'queued') f.cr_cleanup = null; // he picked it back up
    const done = s.total_eps && ep >= s.total_eps && s.airing_status !== 'RELEASING' && s.airing_status !== 'NOT_YET_RELEASED';
    if (done) {
      f.status = 'completed'; f.completed_at = it.at.slice(0, 10); f.eps_watched = s.total_eps;
      if (!s.rating) suggs.push({ show_id: s.anilist_id, kind: 'note', payload: { rate: true, text: `You finished ${label(s)}. Rate it?` } });
    }
    if (!s.cr_url && seriesId(it.url)) f.cr_url = it.url;
    Object.assign(s, f);
    patches.set(s.anilist_id, { ...(patches.get(s.anilist_id) || {}), ...f });
    out.updated.push({ id: s.anilist_id, title: label(s), from: cur, to: f.eps_watched, completed: !!done });
  }

  function addNew(m, it, sure) {
    if (shows.has(m.id)) return bump(shows.get(m.id), it, sure);
    if (!sure) {
      suggs.push({ show_id: m.id, kind: 'new_show', payload: { title: m.title.english || m.title.romaji, to: it.episode, at: it.at } });
      out.inbox.push({ title: m.title.english || m.title.romaji, episode: it.episode, why: 'new show, unsure match' });
      return;
    }
    const meta = metaFrom(m);
    const ep = meta.total_eps ? Math.min(it.episode, meta.total_eps) : it.episode;
    const done = meta.total_eps && ep >= meta.total_eps && meta.airing_status !== 'RELEASING';
    const row = {
      ...meta,
      status: done ? 'completed' : 'watching',
      eps_watched: ep, rating: null, lang: it.audio || io.defaultLang || 'dub', never_nag: false,
      last_watched_at: it.at, started_at: it.at.slice(0, 10), completed_at: done ? it.at.slice(0, 10) : null,
      cr_url: seriesId(it.url) ? it.url : meta.cr_url,
    };
    shows.set(row.anilist_id, row); inserts.set(row.anilist_id, row);
    const sid = seriesId(it.url); if (sid) crSeries.set(sid, row.anilist_id);
    if (done) suggs.push({ show_id: row.anilist_id, kind: 'note', payload: { rate: true, text: `You finished ${label(row)}. Rate it?` } });
    out.added.push({ id: row.anilist_id, title: label(row), episode: ep, completed: !!done });
  }

  // 2) Resolve each series.
  for (const it of byKey.values()) {
    try {
      // a) same Crunchyroll series page as a show we already have
      let key = null;
      const sid = seriesId(it.url);
      if (sid && crSeries.has(sid)) key = crSeries.get(sid);
      // b) title match against the library
      let strength = key != null ? 2 : 0;
      if (key == null) {
        let best = 0, keys = new Set();
        for (const s of shows.values()) {
          const h = Math.max(titleHit(s, it.series), it.season_title ? titleHit(s, it.season_title) : 0);
          if (h > best) { best = h; keys = new Set([fr(s)]); } else if (h && h === best) keys.add(fr(s));
        }
        if (keys.size === 1) { key = [...keys][0]; strength = best; }
        else if (keys.size > 1) strength = -1; // two different franchises match — don't guess
      }
      if (key != null) {
        const pick = await pickSeason(key, it);
        if (!pick) { suggs.push({ show_id: null, kind: 'note', payload: { text: `Watched ${it.series}${it.season ? ' S' + it.season : ''} ep ${it.episode}, but Cour couldn't find that season.` } }); out.inbox.push({ title: it.series, episode: it.episode, why: 'season not found' }); continue; }
        const sure = pick.sure && strength === 2;
        if (pick.mismatch) {
          suggs.push({ show_id: null, kind: 'note', payload: { text: `Watched ${it.series} S${it.season} ep ${it.episode} on Crunchyroll, but Cour couldn't tell which season that is. Update it by hand.` } });
          out.inbox.push({ title: it.series, episode: it.episode, why: 'season numbers don\'t line up' });
          continue;
        }
        if (pick.media) addNew(pick.media, it, sure); else bump(pick.show, it, sure);
        continue;
      }
      if (strength === -1) {
        suggs.push({ show_id: null, kind: 'note', payload: { text: `Watched "${it.series}" ep ${it.episode}: it matches more than one show in your list. Update it by hand.` } });
        out.inbox.push({ title: it.series, episode: it.episode, why: 'matches two shows' });
        continue;
      }
      // c) not in the library → AniList
      const found = await io.search(it.series);
      const exact = found.filter((m) => titleHit({ title_en: m.title.english, title_romaji: m.title.romaji, synonyms: m.synonyms }, it.series) === 2);
      const seriesHits = exact.filter((m) => SERIES_FORMATS.has(m.format));
      let root = (seriesHits.length ? seriesHits : exact).sort((a, b) => ((a.startDate && a.startDate.year) || 9999) - ((b.startDate && b.startDate.year) || 9999))[0];
      if (!root) {
        if (found[0]) addNew(found[0], it, false);
        else { suggs.push({ show_id: null, kind: 'note', payload: { text: `Watched "${it.series}" ep ${it.episode} on Crunchyroll, but couldn't find it on AniList.` } }); out.inbox.push({ title: it.series, episode: it.episode, why: 'not on AniList' }); }
        continue;
      }
      // walk to the right season
      let m = root, ok = true;
      for (let n = 1; it.season && n < it.season; n++) {
        const full = n === 1 && m.relations ? m : await io.get(m.id);
        const next = sequelOf(full);
        if (!next) { ok = false; break; }
        m = await io.get(next);
      }
      if (!ok) { addNew(root, it, false); continue; }
      // no season given but the episode is past season 1 → probably absolute numbering; let Joe confirm
      const sure = !(!it.season && m.episodes && it.episode > m.episodes);
      addNew(m, it, sure);
    } catch (e) {
      out.notes.push(`${it.series}: ${e.message}`);
    }
  }
  return { out, patches, inserts, suggs };
}

/* ───────── writes ───────── */
async function upsertSugg(g) {
  if (g.show_id != null) {
    const ex = await sb('suggestions', { query: `select=id,payload&status=eq.pending&kind=eq.${g.kind}&show_id=eq.${g.show_id}` });
    if (ex && ex[0]) {
      const p = { ...(ex[0].payload || {}), ...g.payload };
      if (g.kind === 'progress' && ex[0].payload) p.from = Math.min(ex[0].payload.from || p.from, p.from);
      return sb('suggestions', { method: 'PATCH', query: 'id=eq.' + ex[0].id, body: { payload: p }, prefer: 'return=minimal' });
    }
  } else {
    const ex = await sb('suggestions', { query: `select=id,payload&status=eq.pending&kind=eq.${g.kind}&show_id=is.null` });
    if ((ex || []).some((x) => x.payload && x.payload.text === g.payload.text)) return;
  }
  return sb('suggestions', { method: 'POST', body: [{ ...g, source: 'muse' }], prefer: 'return=minimal' });
}

async function getSync() {
  const r = await sb('settings', { query: 'select=value&key=eq.sync' });
  return (r && r[0] && r[0].value) || {};
}
const putSync = (value) => sb('settings', { method: 'POST', body: [{ key: 'sync', value }], prefer: 'resolution=merge-duplicates,return=minimal' });

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured() || !process.env.COUR_SYNC_KEY) {
    return res.status(500).json({ error: 'Sync not configured — add COUR_SYNC_KEY in Vercel, then redeploy.' });
  }
  const auth = req.headers['x-cour-sync-key'] || String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!same(auth, process.env.COUR_SYNC_KEY)) return res.status(401).json({ error: 'Wrong sync key' });

  try {
    if (req.method === 'GET') {
      const s = await getSync();
      // Check from a day before the newest thing we've already seen (duplicates are harmless).
      const since = s.newest_watch ? new Date(new Date(s.newest_watch).getTime() - 864e5).toISOString() : null;
      const q = await sb('shows', { query: 'select=anilist_id,title_en,title_romaji,cr_url&cr_cleanup=eq.queued&limit=50' });
      const cleanup = (q || []).map((x) => ({ id: x.anilist_id, series: x.title_en || x.title_romaji, also_called: x.title_en && x.title_romaji && x.title_romaji !== x.title_en ? x.title_romaji : null, url: x.cr_url || null }));
      return res.json({ ok: true, version: VERSION, last_run: s.last_run || null, needs_login: !!s.needs_login, since, cleanup });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'GET or POST' });

    const b = await readBody(req);
    const items = Array.isArray(b.items) ? b.items : [];
    const dry = !!b.dry_run;
    const prev = await getSync();
    const now = new Date().toISOString();

    if (b.needs_login) {
      if (!dry) {
        await upsertSugg({ show_id: null, kind: 'relogin', payload: { text: 'relogin' } });
        await putSync({ ...prev, last_run: now, needs_login: true, source: b.source || 'muse', last_result: { at: now, login: false } });
      }
      return res.json({ ok: true, dry_run: dry, needs_login: true });
    }

    // Drop cleanup results from the agent.
    const cleaned = [];
    const doneIds = (Array.isArray(b.cleanup_done) ? b.cleanup_done : []).map(Number).filter(Number.isFinite).slice(0, 50);
    const failed = (Array.isArray(b.cleanup_failed) ? b.cleanup_failed : []).filter((x) => x && Number.isFinite(+x.id)).slice(0, 50);
    if (!dry) {
      for (const id of doneIds) {
        const r = await sb('shows', { method: 'PATCH', query: `anilist_id=eq.${id}&cr_cleanup=eq.queued`, body: { cr_cleanup: 'done', cr_cleanup_at: now, cr_cleanup_note: null }, prefer: 'return=representation' });
        if (r && r[0]) cleaned.push(r[0].title_en || r[0].title_romaji || '#' + id);
      }
      for (const x of failed) await sb('shows', { method: 'PATCH', query: `anilist_id=eq.${+x.id}&cr_cleanup=eq.queued`, body: { cr_cleanup: 'failed', cr_cleanup_at: now, cr_cleanup_note: String(x.reason || '').slice(0, 120) || null }, prefer: 'return=minimal' });
    }

    const [lib, settings] = await Promise.all([
      sb('shows', { query: 'select=*&limit=5000' }),
      sb('settings', { query: 'select=key,value&key=eq.default_lang' }),
    ]);
    const cache = new Map();
    const io = {
      defaultLang: (settings && settings[0] && settings[0].value) || 'dub',
      search: aniSearch,
      get: async (id) => { if (!cache.has(id)) cache.set(id, await aniGet(id)); return cache.get(id); },
    };
    const { out, patches, inserts, suggs } = await plan(items, lib || [], io);

    if (!dry) {
      if (inserts.size) await sb('shows', { method: 'POST', body: [...inserts.values()], prefer: 'resolution=merge-duplicates,return=minimal' });
      for (const [id, f] of patches) await sb('shows', { method: 'PATCH', query: 'anilist_id=eq.' + id, body: f, prefer: 'return=minimal' });
      for (const g of suggs) await upsertSugg(g);
      // A good run clears any old "log back in" card.
      if (prev.needs_login) await sb('suggestions', { method: 'PATCH', query: 'status=eq.pending&kind=eq.relogin', body: { status: 'accepted', resolved_at: now }, prefer: 'return=minimal' });
      const newest = items.map((i) => toISO(i.watched_at)).sort().pop();
      await putSync({
        last_run: now, needs_login: false, source: b.source || 'muse',
        newest_watch: [prev.newest_watch, newest].filter(Boolean).sort().pop() || null,
        last_result: {
          at: now, seen: items.length,
          updated: out.updated.slice(0, 20).map((u) => ({ title: u.title, to: u.to, completed: u.completed })),
          added: out.added.slice(0, 20).map((a) => ({ title: a.title, to: a.episode })),
          inbox: out.inbox.length,
          cleaned,
        },
      });
    }
    return res.json({ ok: true, dry_run: dry, ...out, cleaned: dry ? doneIds : cleaned, cleanup_failed: failed.length });
  } catch (e) {
    return res.status(e.status && e.status < 500 ? e.status : 500).json({ error: e.message });
  }
};
module.exports.plan = plan;           // for tests
module.exports._t = { norm, baseTitle, titleHit, seriesId };
