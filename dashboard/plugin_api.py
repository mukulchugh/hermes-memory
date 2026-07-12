"""hermes-memory dashboard plugin — backend API.

Mounted at /api/plugins/hermes-memory/ by the dashboard plugin system.

Read-only proxy to the self-hosted Honcho API (default 127.0.0.1:8000). Keeps
Honcho on localhost — the browser only ever talks to this router, which the
dashboard puts behind its own session auth. Nothing here mutates memory except
the two explicitly user-triggered POSTs (chat, schedule_dream).

Fully dynamic: peers, levels, collections, and counts are all discovered from
Honcho at runtime. No hardcoded peer names, level names, or workspace assumptions
(workspace defaults to the Hermes memory workspace but is overridable per request
or via env).

Aggregation uses a direct read-only Postgres GROUP BY when HONCHO_DB_URL is set
(~90ms), and falls back to paging the Honcho HTTP API and aggregating in Python
when it isn't. Credentials come from env only and are never committed.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Any, Optional

from fastapi import APIRouter, Body, Query

router = APIRouter()

BASE = os.environ.get("HONCHO_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
DEFAULT_WS = os.environ.get("HONCHO_WORKSPACE", "hermes")
# Fast path: aggregate straight from Honcho's Postgres in one GROUP BY (~90ms)
# instead of paging ~123k rows over HTTP (~120s — Honcho caps page size at 100).
# Read-only, localhost only, credentials via env only (never committed). If unset
# or the DB is unreachable, everything falls back to the HTTP paging path below.
_DB_URL = os.environ.get("HONCHO_DB_URL")
_PAGE_SIZE = 100
_CACHE_TTL = 900  # used only by the HTTP paging fallback

# ws -> (fetched_at, [conclusion, ...])
_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}


def _req(method: str, path: str, params: Optional[dict] = None,
         body: Optional[dict] = None, timeout: int = 30) -> Any:
    url = f"{BASE}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json", "Accept": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _all_conclusions(ws: str, force: bool = False) -> list[dict[str, Any]]:
    """Page through every conclusion once and cache it. conclusions/list has no
    server-side filter (only page/size), so we aggregate/filter here."""
    now = time.time()
    hit = _cache.get(ws)
    if hit and not force and now - hit[0] < _CACHE_TTL:
        return hit[1]
    items: list[dict[str, Any]] = []
    page = 1
    while True:
        d = _req("POST", f"/v3/workspaces/{ws}/conclusions/list",
                 params={"page": page, "size": _PAGE_SIZE}, body={})
        batch = d.get("items", []) or []
        items.extend(batch)
        pages = d.get("pages") or 1
        if page >= pages or not batch:
            break
        page += 1
        if page > 5000:  # ponytail: covers ~500k facts; warmer runs this off-request so extra pages are free
            break
    _cache[ws] = (now, items)
    return items


# --- SQL fast path (optional) ------------------------------------------------
# Honcho stores conclusions in the `documents` table; observer/observed/level are
# indexed columns. One GROUP BY replaces ~1,230 sequential paged HTTP calls.

async def _sql(query: str, *args, one: bool = False):
    import asyncpg
    conn = await asyncpg.connect(_DB_URL, timeout=10)
    try:
        return await (conn.fetchval(query, *args) if one else conn.fetch(query, *args))
    finally:
        await conn.close()


def _agg_sql(ws: str):
    """(edges, levels, observed_facts, observer_facts, total) via one GROUP BY."""
    rows = asyncio.run(_sql(
        "SELECT observer, observed, level, count(*) AS n FROM documents "
        "WHERE workspace_name=$1 AND deleted_at IS NULL "
        "GROUP BY observer, observed, level", ws))
    edges: dict[tuple[str, str], dict[str, int]] = {}
    levels: dict[str, int] = {}
    observed_facts: dict[str, int] = {}
    observer_facts: dict[str, int] = {}
    total = 0
    for r in rows:
        o, d, lv, n = r["observer"], r["observed"], (r["level"] or "explicit"), r["n"]
        edges.setdefault((o, d), {})
        edges[(o, d)][lv] = edges[(o, d)].get(lv, 0) + n
        levels[lv] = levels.get(lv, 0) + n
        observed_facts[d] = observed_facts.get(d, 0) + n
        observer_facts[o] = observer_facts.get(o, 0) + n
        total += n
    return edges, levels, observed_facts, observer_facts, total


def _agg_paged(ws: str, refresh: bool):
    """Fallback: page every conclusion over HTTP and aggregate in Python."""
    cons = _all_conclusions(ws, force=refresh)
    edges: dict[tuple[str, str], dict[str, int]] = {}
    levels: dict[str, int] = {}
    observed_facts: dict[str, int] = {}
    observer_facts: dict[str, int] = {}
    for c in cons:
        o = c.get("observer_id")
        d = c.get("observed_id")
        lv = c.get("level") or "explicit"
        edges.setdefault((o, d), {})
        edges[(o, d)][lv] = edges[(o, d)].get(lv, 0) + 1
        levels[lv] = levels.get(lv, 0) + 1
        observed_facts[d] = observed_facts.get(d, 0) + 1
        observer_facts[o] = observer_facts.get(o, 0) + 1
    return edges, levels, observed_facts, observer_facts, len(cons)


def _sids(v):
    # source_ids is jsonb; asyncpg hands it back as a JSON string.
    if v is None:
        return []
    if isinstance(v, str):
        try:
            v = json.loads(v)
        except Exception:
            return []
    return v if isinstance(v, list) else []


def _row_to_item(r):
    return {
        "id": r["id"], "content": r["content"],
        "observer_id": r["observer_id"], "observed_id": r["observed_id"],
        "session_id": r["session_id"], "level": r["level"],
        "created_at": r["created_at"].isoformat() if r["created_at"] else None,
        "source_ids": _sids(r["source_ids"]),
    }


_FACT_COLS = (
    "SELECT id, content, observer AS observer_id, observed AS observed_id, "
    "session_name AS session_id, level, created_at, source_ids FROM documents "
)
_FACTS_WHERE = (
    "WHERE workspace_name=$1 AND deleted_at IS NULL "
    "AND ($2::text IS NULL OR observer=$2) "
    "AND ($3::text IS NULL OR observed=$3) "
    "AND ($4::text IS NULL OR level=$4) "
    "AND ($5::text IS NULL OR content ILIKE '%'||$5||'%')"
)


def _facts_sql(ws, observer, observed, level, q, limit, offset, order="recent"):
    """(total, items) via SQL. order='graph' surfaces higher-order (non-explicit)
    facts first so a graph expand shows the derivation nodes; default is newest."""
    total = asyncio.run(_sql(
        "SELECT count(*) FROM documents " + _FACTS_WHERE,
        ws, observer, observed, level, q, one=True))
    order_by = ("(level = 'explicit'), created_at DESC" if order == "graph"
                else "created_at DESC")
    rows = asyncio.run(_sql(
        _FACT_COLS + _FACTS_WHERE + " ORDER BY " + order_by + " LIMIT $6 OFFSET $7",
        ws, observer, observed, level, q, limit, offset))
    return total, [_row_to_item(r) for r in rows]


def _facts_by_ids(ws, id_list):
    """Fetch specific facts by id — used to pull in derivation sources that fall
    outside a peer's newest-N window so the derivation edges are complete."""
    if not id_list:
        return []
    rows = asyncio.run(_sql(
        _FACT_COLS + "WHERE workspace_name=$1 AND deleted_at IS NULL AND id = ANY($2::text[])",
        ws, id_list))
    return [_row_to_item(r) for r in rows]


@router.get("/overview")
def overview(ws: str = Query(DEFAULT_WS), refresh: bool = Query(False)):
    """Everything the panel needs on load: peers (with fact counts), the
    observer->observed edge set, level distribution, totals, queue status."""
    try:
        peers = _req("POST", f"/v3/workspaces/{ws}/peers/list",
                     params={"size": 200}, body={}).get("items", [])
    except Exception:
        peers = []

    # SQL fast path (~90ms); fall back to HTTP paging (~120s) on any DB trouble.
    try:
        if not _DB_URL:
            raise RuntimeError("no HONCHO_DB_URL")
        edges, levels, observed_facts, observer_facts, total_facts = _agg_sql(ws)
    except Exception:
        edges, levels, observed_facts, observer_facts, total_facts = _agg_paged(ws, refresh)

    peer_ids = [p.get("id") for p in peers]
    # include any peer that shows up in facts but not in peers/list (robustness)
    for pid in set(observed_facts) | set(observer_facts):
        if pid and pid not in peer_ids:
            peer_ids.append(pid)

    try:
        q = _req("GET", f"/v3/workspaces/{ws}/queue/status")
    except Exception:
        q = {}

    return {
        "workspace": ws,
        "peers": [
            {"id": pid,
             "observed_facts": observed_facts.get(pid, 0),
             "observer_facts": observer_facts.get(pid, 0)}
            for pid in peer_ids
        ],
        "levels": levels,
        "edges": [
            {"observer": o, "observed": d, "levels": lv, "total": sum(lv.values())}
            for (o, d), lv in edges.items()
        ],
        "total_facts": total_facts,
        "queue": {
            "total": q.get("total_work_units"),
            "completed": q.get("completed_work_units"),
            "in_progress": q.get("in_progress_work_units"),
            "pending": q.get("pending_work_units"),
            "sessions": len(q.get("sessions", {}) or {}),
        },
    }


@router.get("/facts")
def facts(ws: str = Query(DEFAULT_WS), observer: Optional[str] = Query(None),
          observed: Optional[str] = Query(None), level: Optional[str] = Query(None),
          q: Optional[str] = Query(None), ids: Optional[str] = Query(None),
          order: str = Query("recent"), limit: int = Query(200), offset: int = Query(0)):
    """Filtered slice of the conclusion set. All filters optional. ``ids`` (comma-
    separated) fetches specific facts by id; ``order='graph'`` surfaces higher-
    order facts first for graph expansion."""
    # SQL fast path: filter + paginate server-side.
    try:
        if _DB_URL and ids:
            id_list = [x for x in ids.split(",") if x][:500]
            items = _facts_by_ids(ws, id_list)
            return {"total": len(items), "items": items}
        if _DB_URL:
            total, items = _facts_sql(ws, observer, observed, level, (q or None), limit, offset, order)
            return {"total": total, "items": items}
    except Exception:
        pass

    # Fallback: page everything over HTTP and filter in Python.
    cons = _all_conclusions(ws)
    ql = (q or "").lower().strip()
    out = []
    for c in cons:
        if observer and c.get("observer_id") != observer:
            continue
        if observed and c.get("observed_id") != observed:
            continue
        if level and (c.get("level") or "explicit") != level:
            continue
        if ql and ql not in (c.get("content") or "").lower():
            continue
        out.append(c)
    # newest first if timestamps present
    out.sort(key=lambda c: c.get("created_at") or "", reverse=True)
    return {"total": len(out), "items": out[offset:offset + limit]}


@router.get("/workspaces")
def workspaces():
    try:
        d = _req("POST", "/v3/workspaces/list", params={"size": 200}, body={})
        return {"items": [w.get("id") for w in d.get("items", [])], "default": DEFAULT_WS}
    except Exception:
        return {"items": [DEFAULT_WS], "default": DEFAULT_WS}


@router.post("/chat")
def chat(payload: dict = Body(...)):
    """Dialectic query — ask one peer's memory a question. User-triggered only."""
    ws = payload.get("ws", DEFAULT_WS)
    observer = payload.get("observer")
    body = {
        "query": (payload.get("query") or "")[:10000],
        "stream": False,
        "reasoning_level": payload.get("reasoning_level", "medium"),
    }
    if payload.get("target"):
        body["target"] = payload["target"]
    return _req("POST", f"/v3/workspaces/{ws}/peers/{observer}/chat",
                body=body, timeout=180)


@router.post("/schedule_dream")
def schedule_dream(ws: str = Query(DEFAULT_WS)):
    """Ask Honcho to schedule a consolidation dream. User-triggered only."""
    return _req("POST", f"/v3/workspaces/{ws}/schedule_dream", body={})
