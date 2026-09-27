"""Daily job: load NFL schedules, player game logs and injury reports from nflverse into Supabase.

Env: SUPABASE_URL, SUPABASE_SERVICE_KEY
Optional: SEASONS="2025,2026" (defaults to last season + current season)
"""
import math
import os
from datetime import date, datetime
from zoneinfo import ZoneInfo

import nflreadpy as nfl
import polars as pl

from common import DRY_RUN, POSITIONS, name_key, patch, record_status, select, upsert

ET = ZoneInfo("America/New_York")


def current_season(today=None) -> int:
    today = today or date.today()
    # NFL seasons start in September and run into February of the next year.
    return today.year if today.month >= 9 else today.year - 1


def clean(v):
    if v is None:
        return None
    if isinstance(v, float) and math.isnan(v):
        return None
    return v


def to_int(v):
    v = clean(v)
    return None if v is None else int(round(v))


def kickoff_utc(gameday, gametime):
    if not gameday:
        return None
    t = gametime or "13:00"
    dt = datetime.strptime(f"{gameday} {t}", "%Y-%m-%d %H:%M").replace(tzinfo=ET)
    return dt.astimezone(ZoneInfo("UTC")).isoformat()


def main():
    cur = current_season()
    seasons = [int(s) for s in os.environ.get("SEASONS", f"{cur - 1},{cur}").split(",")]
    detail = {"seasons": seasons}

    # 1. Schedule
    sched = nfl.load_schedules(seasons).to_dicts()
    games = [{
        "game_id": g["game_id"], "season": g["season"], "week": g["week"], "game_type": g["game_type"],
        "kickoff": kickoff_utc(g["gameday"], g["gametime"]), "gameday": g["gameday"], "gametime": g["gametime"],
        "away_team": g["away_team"], "home_team": g["home_team"],
        "away_score": to_int(g["away_score"]), "home_score": to_int(g["home_score"]),
        "spread_line": clean(g["spread_line"]), "total_line": clean(g["total_line"]),
    } for g in sched]
    upsert("games", games, "game_id")
    home_of = {g["game_id"]: g["home_team"] for g in games}
    detail["games"] = len(games)

    # 2. Player game logs (offensive skill positions only)
    stats = nfl.load_player_stats(seasons)
    # Offensive players (incl. fullbacks), plus two-way players like a CB who also plays WR:
    # anyone else with at least 10 targets + carries across the loaded seasons. All of their games are kept.
    usage = (stats.group_by("player_id")
             .agg((pl.col("targets").fill_null(0) + pl.col("carries").fill_null(0)).sum().alias("touches")))
    two_way = usage.filter(pl.col("touches") >= 10)["player_id"].to_list()
    stats = stats.filter(pl.col("position").is_in(list(POSITIONS)) | pl.col("player_id").is_in(two_way))
    stats = stats.sort(["season", "week"]).to_dicts()

    players = {}
    logs = []
    for s in stats:
        pid = s["player_id"]
        if not pid or not s["game_id"]:
            continue
        name = s["player_display_name"] or s["player_name"]
        # Later rows overwrite earlier ones, so each player keeps their latest team and position.
        players[pid] = {
            "player_id": pid, "name": name, "name_key": name_key(name), "position": s["position"],
            "team": s["team"], "headshot_url": s["headshot_url"],
            "last_season": s["season"], "last_week": s["week"],
        }
        logs.append({
            "player_id": pid, "game_id": s["game_id"], "season": s["season"], "week": s["week"],
            "season_type": s["season_type"], "position": s["position"], "team": s["team"],
            "opponent": s["opponent_team"], "is_home": home_of.get(s["game_id"]) == s["team"],
            "pass_att": to_int(s["attempts"]), "pass_cmp": to_int(s["completions"]),
            "pass_yds": clean(s["passing_yards"]), "pass_tds": to_int(s["passing_tds"]),
            "rush_att": to_int(s["carries"]), "rush_yds": clean(s["rushing_yards"]),
            "rush_tds": to_int(s["rushing_tds"]),
            "targets": to_int(s["targets"]), "rec": to_int(s["receptions"]),
            "rec_yds": clean(s["receiving_yards"]), "rec_tds": to_int(s["receiving_tds"]),
            "target_share": clean(s["target_share"]),
        })
    upsert("players", list(players.values()), "player_id")
    upsert("player_games", logs, "player_id,game_id")
    detail["players"] = len(players)
    detail["player_games"] = len(logs)

    # 3. Injury reports for the current season (may be empty before week 1)
    try:
        inj = nfl.load_injuries([cur]).to_dicts()
        rows = {}
        for i in inj:
            if not i["gsis_id"] or i["gsis_id"] not in players:
                continue
            rows[(i["gsis_id"], i["season"], i["week"])] = {
                "player_id": i["gsis_id"], "season": i["season"], "week": i["week"], "team": i["team"],
                "report_status": i["report_status"],
                "injury": i["report_primary_injury"] or i["practice_primary_injury"],
                "practice_status": i["practice_status"],
            }
        upsert("injuries", list(rows.values()), "player_id,season,week")
        detail["injuries"] = len(rows)
    except Exception as e:  # injuries are nice-to-have; don't fail the whole job
        detail["injuries_error"] = str(e)[:200]

    # 4. Link props already on the board to players who were just added (e.g. a fullback).
    if not DRY_RUN:
        by_key = {}
        for p in players.values():
            by_key.setdefault(p["name_key"], []).append(p["player_id"])
        linked = 0
        for row in select("current_lines", {"select": "player_name", "player_id": "is.null"}):
            ids = by_key.get(name_key(row["player_name"]), [])
            if len(ids) == 1:
                patch("current_lines", {"player_name": f"eq.{row['player_name']}", "player_id": "is.null"},
                      {"player_id": ids[0]})
                linked += 1
        detail["props_linked"] = linked

    record_status("stats", True, detail)
    print(detail)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        try:
            record_status("stats", False, {"error": str(e)[:500]})
        finally:
            raise
