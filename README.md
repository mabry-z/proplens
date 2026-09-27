# PropLens

NFL player-prop trends for PrizePicks, Underdog and DraftKings Pick6: a phone web app that shows hit rates, game logs, splits, matchups and line movement for the current slate.

- **App:** static site in `docs/`, served by GitHub Pages. Reads Supabase with the public, read-only key.
- **Stats:** `sync/sync_stats.py` loads schedules, player game logs (last two seasons) and injury reports from [nflverse](https://nflverse.nflverse.com/) every day.
- **Lines:** `sync/sync_lines.py` pulls prop lines from [The Odds API](https://the-odds-api.com/) Thursday, Sunday morning and Monday, sized to fit the free 500-credit monthly plan.
- **Database:** Supabase project `PropLens`. Everyone can read; only the sync jobs (using the secret key) can write.

## One-time setup

1. **Repository secrets** (Settings → Secrets and variables → Actions → New repository secret):
   - `SUPABASE_URL`: `https://yxdhnmvksbwfdhrmtvpf.supabase.co`
   - `SUPABASE_SERVICE_KEY`: Supabase dashboard → PropLens → Project Settings → API Keys → **secret** key (or the legacy `service_role` key)
   - `ODDS_API_KEY`: from your The Odds API account
2. **GitHub Pages** (Settings → Pages): Source "Deploy from a branch", branch `main`, folder `/docs`.
3. **First data load** (Actions tab): run **Sync NFL stats**, then **Sync prop lines**.

The app will be at `https://mabry-z.github.io/proplens/`. On iPhone, open it in Safari → Share → Add to Home Screen.

## Home-screen app

The site installs like an app (Safari → Share → Add to Home Screen, or Chrome → Install app). It has its own icon and startup screen, opens without the browser bar, works offline with the last data it loaded, and refreshes by pulling down from the top.

When you change anything in `docs/`, bump `VERSION` in `docs/sw.js` so installed copies pick up the update.

## Credit budget

Each game costs about 1 credit per prop type returned (5 types by default); listing games is free. The three scheduled runs use roughly 350–400 of the 500 monthly credits. The job stops early if fewer than 25 credits remain. To pull more often, add a cron line to `.github/workflows/sync-lines.yml` or move to a paid plan. The About tab shows credits left.

## Keeping it running

- GitHub turns off scheduled workflows after 60 days with no commits. In the offseason, re-enable them from the Actions tab.
- Free Supabase projects pause after a week without activity. The daily stats job keeps it active; if it pauses in the offseason, restore it from the Supabase dashboard.

## How the numbers work

- **Hit rate:** share of the last 5/10/20 games where the player cleared the line on the suggested side.
- **Projection:** recency-weighted average of the last 16 games (each older game counts 85% as much as the one after it).
- **Edge:** projection minus line. The board ranks by edge relative to the player's game-to-game spread, trusting small samples less.
- **Matchup:** what the opponent allows per game to that position this season, ranked 1 (least) to 32 (most).

These describe past games. They aren't predictions or betting advice.

## Local testing

```sh
cd sync
pip install -r requirements.txt
DRY_RUN=1 python sync_stats.py   # writes JSON to sync/dry_run instead of Supabase
```
