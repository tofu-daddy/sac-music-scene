import json
import time
from pathlib import Path
from typing import Dict

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware

from server.scraper import scrape_all_sources

CACHE_FILE = Path(__file__).parent / "cache.json"
CACHE_TTL_SECONDS = 60 * 60 * 6

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_cache() -> Dict:
    if not CACHE_FILE.exists():
        return {"fetched_at": 0, "events": []}
    try:
        return json.loads(CACHE_FILE.read_text())
    except Exception:
        return {"fetched_at": 0, "events": []}


def _save_cache(events):
    payload = {"fetched_at": int(time.time()), "events": events}
    CACHE_FILE.write_text(json.dumps(payload))


def _cache_is_fresh(payload: Dict) -> bool:
    fetched_at = payload.get("fetched_at", 0)
    return (time.time() - fetched_at) < CACHE_TTL_SECONDS


@app.get("/api/shows")
def get_shows(refresh: int = Query(default=0, ge=0, le=1)):
    cache = _load_cache()
    if refresh or not _cache_is_fresh(cache):
        try:
            events = scrape_all_sources()
            _save_cache(events)
            cache = _load_cache()
        except Exception as exc:
            return {"events": cache.get("events", []), "error": str(exc)}

    return {"events": cache.get("events", []), "error": None}
