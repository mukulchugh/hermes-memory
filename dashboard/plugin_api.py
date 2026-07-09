"""hermes-memory dashboard plugin — backend API.

Mounted at /api/plugins/hermes-memory/ by the dashboard plugin system.

Read-only proxy to the self-hosted Honcho API (default 127.0.0.1:8000). Keeps
Honcho on localhost — the browser only ever talks to this router, which the
dashboard puts behind its own session auth. Nothing here mutates memory except
the two explicitly user-triggered POSTs (chat, schedule_dream).

Fully dynamic: peers, levels, collections, and counts are all discovered from
Honcho at runtime by paging conclusions and aggregating in Python. No hardcoded
peer names, level names, or workspace assumptions (workspace defaults to the
Hermes memory workspace but is overridable per request or via env).
"""
from __future__ import annotations

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
_PAGE_SIZE = 100
_CACHE_TTL = 45  # seconds — reflects a live-growing seed without hammering the API

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
        if page > 1000:  # ponytail: safety cap ~100k facts; lift if memory ever exceeds it
            break
    _cache[ws] = (now, items)
    return items


@router.get("/overview")
def overview(ws: str = Query(DEFAULT_WS), refresh: bool = Query(False)):
    """Everything the panel needs on load: peers (with fact counts), the
    observer->observed edge set, level distribution, totals, queue status."""
    try:
        peers = _req("POST", f"/v3/workspaces/{ws}/peers/list",
                     params={"size": 200}, body={}).get("items", [])
    except Exception:
        peers = []
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
        "total_facts": len(cons),
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
          q: Optional[str] = Query(None), limit: int = Query(200), offset: int = Query(0)):
    """Filtered slice of the cached conclusion set. All filters optional."""
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
