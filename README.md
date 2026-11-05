# Cour (cour-4)

Personal anime tracker. Single `index.html`, no build step. Supabase (Builds project, `cour_` tables) + Vercel.

## Files
- `index.html` — the whole app (`APP_VERSION` must match `version.json` and `api/_lib/cour.js`)
- `api/db.js` — passcode-gated Supabase proxy (secret key never reaches the browser)
- `api/sync.js` — nightly Crunchyroll sync endpoint (Muse now, Claude later)
- `api/schedule.js` — AnimeSchedule.net proxy for dub release times
- `api/_lib/cour.js` — shared server helpers + table map
- `supabase/schema.sql` lives outside the repo in the build zip; run it once in the Builds SQL editor
- `manifest.webmanifest`, icons, `vercel.json`, `version.json`

## Env vars (Vercel → Settings → Environment Variables) — values live in 1Password "Cour — env"
| Name | What |
|---|---|
| `SUPABASE_URL` | Builds project URL |
| `SUPABASE_SECRET_KEY` | Builds secret key (`sb_secret_…`) |
| `COUR_PASSCODE` | typed once per device |
| `COUR_SYNC_KEY` | Muse's key for `/api/sync` |
| `ANIMESCHEDULE_TOKEN` | optional, dub times |

Env var changes need a manual **Redeploy** in Vercel.

## /api/sync
Header `x-cour-sync-key: <COUR_SYNC_KEY>`.
- `GET` → `{ last_run, since }`: check Crunchyroll history newer than `since` (null = last 7 days).
- `POST` → `{ source, dry_run?, needs_login?, items: [{ series, season?, season_title?, episode, episode_title?, watched_at, audio?, finished?, url? }] }`
Progress only moves forward, so re-sending is harmless. Sure matches update the show or add it as Watching;
anything unsure goes to the in-app Suggestions inbox. `dry_run: true` reports without saving.
