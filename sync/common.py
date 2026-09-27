"""Shared helpers for the PropLens sync jobs: Supabase REST access and name matching."""
import json
import os
import re
import unicodedata
from datetime import datetime, timezone

import requests

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SUPABASE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")

POSITIONS = ("QB", "RB", "FB", "WR", "TE")

# The Odds API uses full team names; nflverse uses these abbreviations.
TEAM_ABBR = {
    "Arizona Cardinals": "ARI", "Atlanta Falcons": "ATL", "Baltimore Ravens": "BAL",
    "Buffalo Bills": "BUF", "Carolina Panthers": "CAR", "Chicago Bears": "CHI",
    "Cincinnati Bengals": "CIN", "Cleveland Browns": "CLE", "Dallas Cowboys": "DAL",
    "Denver Broncos": "DEN", "Detroit Lions": "DET", "Green Bay Packers": "GB",
    "Houston Texans": "HOU", "Indianapolis Colts": "IND", "Jacksonville Jaguars": "JAX",
    "Kansas City Chiefs": "KC", "Las Vegas Raiders": "LV", "Los Angeles Chargers": "LAC",
    "Los Angeles Rams": "LA", "Miami Dolphins": "MIA", "Minnesota Vikings": "MIN",
    "New England Patriots": "NE", "New Orleans Saints": "NO", "New York Giants": "NYG",
    "New York Jets": "NYJ", "Philadelphia Eagles": "PHI", "Pittsburgh Steelers": "PIT",
    "San Francisco 49ers": "SF", "Seattle Seahawks": "SEA", "Tampa Bay Buccaneers": "TB",
    "Tennessee Titans": "TEN", "Washington Commanders": "WAS",
}

_SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")


def name_key(name: str) -> str:
    """'Kenneth Walker III' -> 'kenneth walker'; 'D.J. Moore' -> 'dj moore'."""
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode()
    s = s.lower().replace(".", "").replace("'", "").replace("-", " ")
    s = _SUFFIX.sub("", s)
    s = re.sub(r"[^a-z ]", "", s)
    return re.sub(r"\s+", " ", s).strip()


def _headers(extra=None):
    if not SUPABASE_URL or not SUPABASE_KEY:
        raise SystemExit("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
    h = {"apikey": SUPABASE_KEY, "Content-Type": "application/json"}
    if SUPABASE_KEY.startswith("eyJ"):  # legacy service_role JWT; new sb_secret_ keys go in apikey only
        h["Authorization"] = f"Bearer {SUPABASE_KEY}"
    if extra:
        h.update(extra)
    return h


DRY_RUN = os.environ.get("DRY_RUN") == "1"


def _dry(table, rows):
    os.makedirs("dry_run", exist_ok=True)
    with open(f"dry_run/{table}.json", "w") as f:
        json.dump(rows, f, default=str)
    print(f"[dry run] {table}: {len(rows)} rows")


def upsert(table: str, rows: list, on_conflict: str, batch: int = 500):
    """Insert or update rows in batches."""
    if DRY_RUN:
        return _dry(table, rows)
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            params={"on_conflict": on_conflict},
            headers=_headers({"Prefer": "resolution=merge-duplicates,return=minimal"}),
            data=json.dumps(chunk, default=str),
            timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"upsert {table} failed: {r.status_code} {r.text[:500]}")


def insert(table: str, rows: list, batch: int = 500):
    for i in range(0, len(rows), batch):
        r = requests.post(
            f"{SUPABASE_URL}/rest/v1/{table}",
            headers=_headers({"Prefer": "return=minimal"}),
            data=json.dumps(rows[i:i + batch], default=str),
            timeout=60,
        )
        if r.status_code >= 300:
            raise RuntimeError(f"insert {table} failed: {r.status_code} {r.text[:500]}")


def select(table: str, params: dict) -> list:
    """Read every matching row, paging past the 1,000-row API limit."""
    out, offset, page = [], 0, 1000
    while True:
        p = dict(params, limit=page, offset=offset)
        r = requests.get(f"{SUPABASE_URL}/rest/v1/{table}", params=p, headers=_headers(), timeout=60)
        if r.status_code >= 300:
            raise RuntimeError(f"select {table} failed: {r.status_code} {r.text[:500]}")
        rows = r.json()
        out.extend(rows)
        if len(rows) < page:
            return out
        offset += page


def delete(table: str, params: dict):
    r = requests.delete(f"{SUPABASE_URL}/rest/v1/{table}", params=params, headers=_headers(), timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"delete {table} failed: {r.status_code} {r.text[:500]}")


def patch(table: str, params: dict, values: dict):
    if DRY_RUN:
        return print(f"[dry run] patch {table} {params} -> {values}")
    r = requests.patch(f"{SUPABASE_URL}/rest/v1/{table}", params=params,
                       headers=_headers({"Prefer": "return=minimal"}), data=json.dumps(values), timeout=60)
    if r.status_code >= 300:
        raise RuntimeError(f"patch {table} failed: {r.status_code} {r.text[:500]}")


def record_status(job: str, ok: bool, detail: dict):
    now = datetime.now(timezone.utc).isoformat()
    upsert("sync_status", [{"job": job, "ok": ok, "detail": detail, "ran_at": now}], "job")
