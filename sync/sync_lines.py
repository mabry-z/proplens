"""Pull NFL player-prop lines for PrizePicks, Underdog and DraftKings Pick6 from The Odds API.

Built to live on the free plan (500 credits a month):
  - listing upcoming games is free;
  - each game costs 1 credit per prop market returned (all three sites count as one region);
  - only games kicking off in the next HOURS_AHEAD hours are fetched;
  - the job stops early if fewer than MIN_CREDITS credits remain.

Env: ODDS_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY
Optional: HOURS_AHEAD (36), MIN_CREDITS (25), MARKETS (comma list), BOOKS (comma list)
"""
import os
from datetime import datetime, timedelta, timezone

import requests

from common import (TEAM_ABBR, delete, insert, name_key, record_status, select, upsert)

API = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl"
KEY = os.environ.get("ODDS_API_KEY", "")
HOURS_AHEAD = float(os.environ.get("HOURS_AHEAD") or 36)
MIN_CREDITS = int(os.environ.get("MIN_CREDITS") or 25)
MARKETS = os.environ.get("MARKETS") or (
    "player_pass_yds,player_rush_yds,player_reception_yds,player_receptions,player_rush_reception_yds")
BOOKS = os.environ.get("BOOKS") or "prizepicks,underdog,pick6"


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def main():
    if not KEY:
        raise SystemExit("ODDS_API_KEY is not set")
    now = datetime.now(timezone.utc)
    detail = {"hours_ahead": HOURS_AHEAD, "books": BOOKS.split(","), "markets": MARKETS.split(",")}

    # 1. Upcoming games (free)
    r = requests.get(f"{API}/events", params={
        "apiKey": KEY, "commenceTimeFrom": iso(now - timedelta(hours=1)),
        "commenceTimeTo": iso(now + timedelta(hours=HOURS_AHEAD))}, timeout=30)
    r.raise_for_status()
    events = r.json()
    remaining = int(float(r.headers["x-requests-remaining"])) if r.headers.get("x-requests-remaining") else None
    detail["events_found"] = len(events)

    # Match each Odds API game to an nflverse game_id, and names to player_ids.
    games = select("games", {"select": "game_id,home_team,away_team,kickoff",
                             "kickoff": f"gte.{iso(now - timedelta(days=2))}", "order": "kickoff"})
    players = select("players", {"select": "player_id,name_key,team,last_season"})
    by_name = {}
    for p in players:
        by_name.setdefault(p["name_key"], []).append(p)

    def find_game(ev):
        home, away = TEAM_ABBR.get(ev["home_team"]), TEAM_ABBR.get(ev["away_team"])
        for g in games:
            if g["home_team"] == home and g["away_team"] == away:
                return g
        return None

    def find_player(name, teams):
        cands = by_name.get(name_key(name), [])
        if len(cands) > 1:
            on_team = [c for c in cands if c["team"] in teams]
            cands = on_team or sorted(cands, key=lambda c: c["last_season"] or 0, reverse=True)
        return cands[0]["player_id"] if cands else None

    fetched, new_rows, unmatched = [], [], set()
    for ev in events:
        if remaining is not None and remaining < MIN_CREDITS:
            detail["stopped_early"] = f"only {remaining} credits left"
            break
        r = requests.get(f"{API}/events/{ev['id']}/odds", params={
            "apiKey": KEY, "bookmakers": BOOKS, "markets": MARKETS, "oddsFormat": "american"}, timeout=30)
        if r.status_code == 422:  # no props posted for this game yet
            continue
        r.raise_for_status()
        remaining = int(float(r.headers.get("x-requests-remaining") or 0))
        data = r.json()
        fetched.append(ev["id"])
        game = find_game(ev)
        teams = {TEAM_ABBR.get(ev["home_team"]), TEAM_ABBR.get(ev["away_team"])}

        for bm in data.get("bookmakers", []):
            for mk in bm.get("markets", []):
                props = {}
                for o in mk.get("outcomes", []):
                    player, point = o.get("description"), o.get("point")
                    if not player or point is None:
                        continue
                    p = props.setdefault(player, {"line": point})
                    if o.get("name") == "Over":
                        p["over"], p["line"] = o.get("price"), point
                    elif o.get("name") == "Under":
                        p["under"] = o.get("price")
                for player, p in props.items():
                    pid = find_player(player, teams)
                    if not pid:
                        unmatched.add(player)
                    new_rows.append({
                        "event_id": ev["id"], "book": bm["key"], "market": mk["key"], "player_name": player,
                        "player_id": pid, "game_id": game["game_id"] if game else None,
                        "kickoff": ev["commence_time"], "line": p["line"],
                        "over_price": p.get("over"), "under_price": p.get("under"),
                    })

    # 2. Merge with what we already have, keeping opening lines and logging changes.
    stamp = now.isoformat()
    history = []
    if fetched:
        existing = select("current_lines", {"select": "event_id,book,market,player_name,line,first_line,first_seen,line_changed_at",
                                            "event_id": f"in.({','.join(fetched)})"})
        old = {(e["event_id"], e["book"], e["market"], e["player_name"]): e for e in existing}
        for row in new_rows:
            prev = old.pop((row["event_id"], row["book"], row["market"], row["player_name"]), None)
            if prev:
                row["first_line"], row["first_seen"] = prev["first_line"], prev["first_seen"]
                changed = float(prev["line"]) != float(row["line"])
                row["line_changed_at"] = stamp if changed else prev["line_changed_at"]
            else:
                row["first_line"], row["first_seen"], row["line_changed_at"] = row["line"], stamp, stamp
                changed = True
            row["fetched_at"] = stamp
            if changed:
                history.append({k: row[k] for k in ("event_id", "book", "market", "player_name", "line")})
        upsert("current_lines", new_rows, "event_id,book,market,player_name")
        insert("line_history", history)
        # Props that were pulled from the board (e.g. player ruled out) disappear for fetched games.
        for (ev_id, book, market, player) in old:
            delete("current_lines", {"event_id": f"eq.{ev_id}", "book": f"eq.{book}",
                                     "market": f"eq.{market}", "player_name": f"eq.{player}"})

    # 3. Clear finished games from the board.
    delete("current_lines", {"kickoff": f"lt.{iso(now - timedelta(hours=8))}"})

    detail.update({"games_fetched": len(fetched), "props": len(new_rows), "line_changes": len(history),
                   "credits_remaining": remaining, "unmatched_players": sorted(unmatched)[:40]})
    record_status("lines", True, detail)
    print(detail)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        try:
            msg = str(e).replace(KEY, "***") if KEY else str(e)
            record_status("lines", False, {"error": msg[:500]})
        finally:
            raise
