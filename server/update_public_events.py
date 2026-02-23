import json
import time
from pathlib import Path

from server.scraper import scrape_all_sources


def main():
    events = scrape_all_sources()
    payload = {"fetched_at": int(time.time()), "events": events}
    output_path = Path(__file__).resolve().parent.parent / "public" / "events.json"
    output_path.write_text(json.dumps(payload), encoding="utf-8")
    print(f"Updated {output_path} with {len(events)} events")


if __name__ == "__main__":
    main()
