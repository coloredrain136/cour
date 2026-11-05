// Cour — AnimeSchedule.net proxy (sub + DUB release times).
// Keeps the AnimeSchedule token server-side and caches at Vercel's edge.
//
// Env var: ANIMESCHEDULE_TOKEN  (animeschedule.net → Settings → API → create an app → copy the token)
// Without it, the app still works; dub tracking just falls back to "all episodes out once the show finishes".

const crypto = require('crypto');
const BASE = 'https://animeschedule.net/api/v3';

function same(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const g = (o, k) => (o ? (o[k] ?? o[k[0].toUpperCase() + k.slice(1)]) : undefined);

async function as(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: 'Bearer ' + process.env.ANIMESCHEDULE_TOKEN } });
  if (!r.ok) throw Object.assign(new Error('AnimeSchedule ' + r.status), { status: r.status });
  return r.json();
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t - y0) / 864e5 + 1) / 7) };
}

function slimEntry(e) {
  const streams = g(e, 'streams') || {};
  return {
    route: g(e, 'route'),
    title: g(e, 'title'),
    english: g(e, 'english') || null,
    romaji: g(e, 'romaji') || null,
    ep: g(e, 'episodeNumber'),
    sub: g(e, 'subtractedEpisodeNumber') || null,
    eps: g(e, 'episodes') || null,
    at: g(e, 'episodeDate'),
    delayedUntil: g(e, 'delayedUntil') || null,
    status: g(e, 'airingStatus') || g(e, 'status') || null,
    cr: streams.crunchyroll || streams.Crunchyroll || null,
  };
}

function anilistIdFrom(show) {
  const w = g(show, 'websites') || {};
  const s = w.aniList || w.anilist || w.AniList || '';
  const m = String(s).match(/anime\/(\d+)/);
  return m ? Number(m[1]) : null;
}

module.exports = async (req, res) => {
  if (!same(req.headers['x-cour-key'], process.env.COUR_PASSCODE)) return res.status(401).json({ error: 'Wrong passcode' });
  if (!process.env.ANIMESCHEDULE_TOKEN) return res.json({ disabled: true });

  const op = req.query.op || 'timetable';
  try {
    if (op === 'timetable') {
      // Dub timetable for this week + last week (covers anything released in the last ~7–14 days).
      const now = new Date();
      const prev = isoWeek(new Date(now.getTime() - 7 * 864e5));
      const [cur, last] = await Promise.all([
        as('/timetables/dub?tz=UTC'),
        as(`/timetables/dub?tz=UTC&week=${prev.week}&year=${prev.year}`).catch(() => []),
      ]);
      const all = [...(Array.isArray(last) ? last : []), ...(Array.isArray(cur) ? cur : [])].map(slimEntry);
      res.setHeader('Cache-Control', 'private, max-age=0');
      res.setHeader('CDN-Cache-Control', 's-maxage=1800, stale-while-revalidate=3600');
      return res.json({ dub: all, at: now.toISOString() });
    }

    if (op === 'lookup') {
      // Map AniList ids → AnimeSchedule route + Crunchyroll link.
      const ids = String(req.query.anilist || '').split(',').map(Number).filter(Boolean).slice(0, 25);
      if (!ids.length) return res.json({ map: {} });
      const qs = ids.map((i) => 'anilist-ids=' + i).join('&');
      const data = await as('/anime?' + qs).catch(() => null);
      const list = (data && (data.anime || data.Anime)) || [];
      const map = {};
      for (const a of list) {
        const id = anilistIdFrom(a);
        if (!id || !ids.includes(id)) continue;
        const w = g(a, 'websites') || {};
        const streams = g(a, 'streams') || {};
        const cr = w.crunchyroll || w.Crunchyroll || streams.crunchyroll || null;
        map[id] = {
          route: g(a, 'route'),
          cr: cr ? (cr.startsWith('http') ? cr : 'https://' + cr) : null,
          dubPremier: g(a, 'dubPremier') || null,
          dubTime: g(a, 'dubTime') || null,
        };
      }
      res.setHeader('CDN-Cache-Control', 's-maxage=86400');
      return res.json({ map });
    }

    return res.status(400).json({ error: 'Unknown op' });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
};
