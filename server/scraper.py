import hashlib
import html as html_lib
import json
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, date
from pathlib import Path
from typing import Dict, List, Optional
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
MAX_LINKS_PER_SOURCE = 200
SCRAPE_WORKERS = 8
TICKET_HOST_HINTS = ("etix.com", "ticketmaster.com", "axs.com", "eventbrite.com", "seetickets.com")
MANUAL_EVENTS_FILE = Path(__file__).parent / "manual_events.json"

KNOWN_VENUES = {
    "harlows": {
        "name": "Harlow's",
        "address": "2708 J St",
        "city": "Sacramento",
        "state": "CA",
        "postalCode": "95816",
    },
    "the_starlet_room": {
        "name": "The Starlet Room",
        "address": "2708 J St",
        "city": "Sacramento",
        "state": "CA",
        "postalCode": "95816",
    },
    "ace_of_spades": {
        "name": "Ace of Spades",
        "address": "1417 R St",
        "city": "Sacramento",
        "state": "CA",
        "postalCode": "95811",
    },
    "cafe_colonial": {
        "name": "Cafe Colonial",
        "address": "3522 Stockton Blvd",
        "city": "Sacramento",
        "state": "CA",
        "postalCode": "95820",
    },
    "channel_24": {
        "name": "Channel 24",
        "address": "1800 24th St",
        "city": "Sacramento",
        "state": "CA",
        "postalCode": "95816",
    },
    "goldfield_trading_post": {
        "name": "Goldfield Trading Post",
        "city": "Sacramento",
        "state": "CA",
    },
    "old_ironsides": {
        "name": "Old Ironsides",
        "city": "Sacramento",
        "state": "CA",
    },
    "the_boardwalk": {
        "name": "The Boardwalk",
        "address": "9426 Greenback Ln",
        "city": "Orangevale",
        "state": "CA",
        "postalCode": "95662",
    },
}

GENERIC_EVENT_TITLES = {
    "events",
    "shows",
    "calendar",
    "the boardwalk",
    "harlow's",
    "harlows",
    "the starlet room",
    "old ironsides",
    "goldfield trading post",
    "ace of spades",
    "channel 24",
    "upcoming events",
    "find the latest shows near you",
}

GENERIC_TITLE_SUBSTRINGS = (
    "find the latest shows near you",
    "discover upcoming events",
)


def _fetch(url: str) -> Optional[str]:
    try:
        response = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20.0, follow_redirects=True)
        response.raise_for_status()
        return response.text
    except Exception:
        return None


def _fetch_json(url: str) -> Optional[Dict]:
    try:
        response = httpx.get(url, headers={"User-Agent": USER_AGENT}, timeout=20.0, follow_redirects=True)
        response.raise_for_status()
        return response.json()
    except Exception:
        return None


def _clean_event_name(value: Optional[str]) -> str:
    text = html_lib.unescape((value or "").strip())
    if not text:
        return ""

    text = re.sub(r"^\s*events?\s*-\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s+", " ", text).strip(" -|")
    if " | " in text:
        text = text.split(" | ", 1)[0].strip()
    if " - " in text:
        left, right = text.split(" - ", 1)
        if right.strip().lower() in GENERIC_EVENT_TITLES:
            text = left.strip()
    return text


def _is_generic_title(value: Optional[str]) -> bool:
    cleaned = _clean_event_name(value).lower().strip()
    if not cleaned:
        return True
    if cleaned in GENERIC_EVENT_TITLES:
        return True
    return any(token in cleaned for token in GENERIC_TITLE_SUBSTRINGS)


def _canonicalize_url(value: Optional[str]) -> Optional[str]:
    if not value:
        return value
    return value.split("#", 1)[0].split("?", 1)[0].rstrip("/")


def _load_manual_events() -> List[Dict]:
    if not MANUAL_EVENTS_FILE.exists():
        return []
    try:
        payload = json.loads(MANUAL_EVENTS_FILE.read_text())
    except Exception:
        return []

    if not isinstance(payload, list):
        return []

    events = []
    for item in payload:
        if not isinstance(item, dict):
            continue
        name = _clean_event_name(item.get("name"))
        if not name:
            continue

        source = item.get("source") or "manual"
        url = _canonicalize_url(item.get("url"))
        local_date = item.get("localDate")
        event_id = item.get("id") or _build_id(source, url, name, local_date)

        events.append({
            "id": event_id,
            "name": name,
            "url": url,
            "localDate": local_date,
            "localTime": item.get("localTime"),
            "dateTBA": not bool(local_date),
            "timeTBA": not bool(item.get("localTime")),
            "status": item.get("status"),
            "image": item.get("image"),
            "priceMin": item.get("priceMin"),
            "priceMax": item.get("priceMax"),
            "currency": item.get("currency"),
            "genre": None,
            "subGenre": None,
            "segment": None,
            "venue": item.get("venue") if isinstance(item.get("venue"), dict) else {},
            "source": source,
        })
    return events


def _title_from_event_url(url: str) -> Optional[str]:
    path = urlparse(url).path.strip("/")
    if not path:
        return None
    segments = path.split("/")
    slug = segments[-1]
    if len(segments) >= 3 and segments[-2].lower() == "event":
        slug = segments[-3]
    if not slug:
        return None

    slug = slug.replace(".html", "")
    slug = re.sub(r"-\d{6,8}(?:-[a-z]+)?$", "", slug, flags=re.IGNORECASE)
    slug = re.sub(r"-(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)$", "", slug, flags=re.IGNORECASE)
    slug = slug.replace("-", " ").strip()
    if not slug:
        return None

    if re.search(r"[A-Za-z]", slug):
        slug = " ".join(word.capitalize() for word in slug.split())
    return _clean_event_name(slug)


def _parse_jsonld(soup: BeautifulSoup) -> List[Dict]:
    results = []
    for script in soup.select('script[type="application/ld+json"]'):
        try:
            data = json.loads(script.string or "")
        except Exception:
            continue

        if isinstance(data, dict):
            data = [data]
        if isinstance(data, list):
            for entry in data:
                if isinstance(entry, dict) and "@graph" in entry and isinstance(entry["@graph"], list):
                    results.extend(entry["@graph"])
                else:
                    results.append(entry)
    return results


def _extract_prices_from_jsonld(items: List[Dict]) -> List[float]:
    prices = []
    for item in items:
        if not isinstance(item, dict):
            continue
        offers = item.get("offers")
        offer_items = offers if isinstance(offers, list) else [offers] if isinstance(offers, dict) else []
        for offer in offer_items:
            if not isinstance(offer, dict):
                continue
            for key in ("price", "lowPrice", "highPrice"):
                value = offer.get(key)
                if isinstance(value, (int, float)):
                    number = float(value)
                    if 0 < number <= 1000:
                        prices.append(number)
                elif isinstance(value, str):
                    for token in re.findall(r"\d+(?:\.\d+)?", value.replace(",", "")):
                        number = float(token)
                        if 0 < number <= 1000:
                            prices.append(number)
    return prices


def _extract_event_from_jsonld(items: List[Dict]) -> Optional[Dict]:
    candidates = []
    for item in items:
        if not isinstance(item, dict):
            continue
        item_type = item.get("@type")
        if isinstance(item_type, list):
            item_type = item_type[0] if item_type else None
        if item_type in {"Event", "MusicEvent"}:
            candidates.append(item)

    if not candidates:
        return None

    def score(candidate: Dict) -> int:
        value = 0
        if candidate.get("startDate"):
            value += 4
        if candidate.get("offers"):
            value += 2
        if candidate.get("location"):
            value += 1
        if candidate.get("url"):
            value += 1
        if candidate.get("image"):
            value += 1
        return value

    return max(candidates, key=score)


def _parse_iso_date(value: Optional[str]) -> Dict[str, Optional[str]]:
    if not value:
        return {"localDate": None, "localTime": None}
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return {"localDate": dt.date().isoformat(), "localTime": dt.time().strftime("%H:%M")}
    except Exception:
        pass

    raw = str(value).strip()
    raw = re.sub(r"\s+[A-Z]{2,5}$", "", raw)
    for fmt in (
        "%Y-%m-%d",
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y/%m/%d",
        "%m/%d/%Y",
        "%m/%d/%Y %I:%M %p",
        "%Y-%m-%dT%H:%M:%S%z",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%dT%H:%M",
    ):
        try:
            dt = datetime.strptime(raw, fmt)
            local_date = dt.date().isoformat()
            local_time = dt.time().strftime("%H:%M") if "H" in fmt or "I" in fmt else None
            return {"localDate": local_date, "localTime": local_time}
        except ValueError:
            continue
    return {"localDate": None, "localTime": None}


def _parse_price(value) -> Dict[str, Optional[float]]:
    if value is None:
        return {"priceMin": None, "priceMax": None}
    if isinstance(value, (int, float)):
        return {"priceMin": float(value), "priceMax": float(value)}
    if isinstance(value, str):
        match = re.findall(r"\d+(?:\.\d+)?", value.replace(",", ""))
        if match:
            numbers = [float(n) for n in match]
            return {"priceMin": min(numbers), "priceMax": max(numbers)}
    return {"priceMin": None, "priceMax": None}


def _extract_prices_from_text(text: str) -> List[float]:
    if not text:
        return []
    matches = re.findall(r"\$\s?(\d+(?:\.\d{1,2})?)", text.replace(",", ""))
    prices = []
    for match in matches:
        try:
            value = float(match)
            if value > 0:
                prices.append(value)
        except Exception:
            continue
    return prices


def _extract_ticket_prices_from_text(text: str) -> List[float]:
    if not text:
        return []
    compact = re.sub(r"\s+", " ", text)
    snippets = re.findall(
        r"([^.]{0,80}\b(?:ticket|tickets|adv|advance|door|presale|on sale)\b[^.]{0,120})",
        compact,
        flags=re.IGNORECASE,
    )
    prices = []
    for snippet in snippets:
        prices.extend(_extract_prices_from_text(snippet))
    return prices


def _looks_like_event_detail_url(href: str) -> bool:
    lowered = href.lower()
    if "/venue/" in lowered:
        return False
    if lowered.endswith("-events"):
        return False
    patterns = (
        r"/event/[^/?#]+",
        r"/events/[^/?#]+",
        r"/shows/[^/?#]+",
        r"/show/[^/?#]+",
        r"/concert/[^/?#]+",
        r"/calendar/[^/?#]+",
        r"/ticket/[pe]/[^/?#]+",
        r"/ticket/\d+",
    )
    return any(re.search(pattern, lowered) for pattern in patterns)


def _extract_best_title(soup: BeautifulSoup) -> Optional[str]:
    candidates = []
    og_title = soup.find("meta", attrs={"property": "og:title"})
    if og_title and og_title.get("content"):
        candidates.append(og_title["content"])
    twitter_title = soup.find("meta", attrs={"name": "twitter:title"})
    if twitter_title and twitter_title.get("content"):
        candidates.append(twitter_title["content"])
    first_h1 = soup.find("h1")
    if first_h1:
        candidates.append(first_h1.get_text(" ", strip=True))
    if soup.title and soup.title.string:
        candidates.append(soup.title.string)

    for candidate in candidates:
        cleaned = _clean_event_name(candidate)
        if cleaned and not _is_generic_title(cleaned):
            return cleaned
    return None


def _extract_best_image_url(soup: BeautifulSoup, event_name: Optional[str]) -> Optional[str]:
    candidates = []
    for attrs in (
        {"property": "og:image"},
        {"name": "twitter:image"},
        {"itemprop": "image"},
    ):
        meta = soup.find("meta", attrs=attrs)
        if meta and meta.get("content"):
            candidates.append(meta.get("content"))

    for image in soup.find_all("img", src=True):
        src = image.get("src", "")
        alt = (image.get("alt") or "").lower()
        width = int(image.get("width") or 0)
        height = int(image.get("height") or 0)
        if width and width < 250:
            continue
        if height and height < 250:
            continue
        if event_name and event_name.lower() in alt:
            candidates.insert(0, src)
        else:
            candidates.append(src)

    for candidate in candidates:
        if not candidate:
            continue
        lowered = candidate.lower()
        if any(token in lowered for token in ("logo", "icon", "favicon", "sprite", "placeholder")):
            continue
        return candidate
    return None


def _find_ticket_links(soup: BeautifulSoup) -> List[str]:
    ranked = []
    seen = set()
    for anchor in soup.find_all("a", href=True):
        text = anchor.get_text(" ", strip=True).lower()
        href = anchor["href"]
        if href in seen:
            continue
        seen.add(href)

        score = 0
        if "buy tickets" in text:
            score += 6
        elif "get tickets" in text:
            score += 5
        elif "tickets" in text:
            score += 4
        elif "buy" in text:
            score += 3

        href_lower = href.lower()
        if any(host in href_lower for host in TICKET_HOST_HINTS):
            score += 4

        if score > 0:
            ranked.append((score, href))

    ranked.sort(key=lambda item: item[0], reverse=True)
    return [href for _, href in ranked]


def _extract_ticket_links_from_html(raw_html: str, base_url: str) -> List[str]:
    if not raw_html:
        return []
    decoded = raw_html.replace("\\/", "/")
    matches = re.findall(
        r"https?://[^\"' <>()\\]+(?:ticketmaster|etix|axs|eventbrite|seetickets)[^\"' <>()\\]*",
        decoded,
        flags=re.IGNORECASE,
    )
    links = []
    seen = set()
    for match in matches:
        normalized = urljoin(base_url, match)
        if normalized not in seen:
            seen.add(normalized)
            links.append(normalized)
    return links


def _looks_free(text: str) -> bool:
    lowered = (text or "").lower()
    return any(
        token in lowered
        for token in ("free admission", "free show", "free event", "no cover", "free entry")
    )


def _extract_datetime_from_text(text: str) -> Dict[str, Optional[str]]:
    compact = re.sub(r"\s+", " ", text or "").strip()
    if not compact:
        return {"localDate": None, "localTime": None}

    local_date = None
    local_time = None

    # ISO-like date first
    iso_match = re.search(r"\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b", compact)
    if iso_match:
        y, m, d = (int(iso_match.group(1)), int(iso_match.group(2)), int(iso_match.group(3)))
        try:
            local_date = date(y, m, d).isoformat()
        except ValueError:
            local_date = None

    date_match = re.search(
        r"\b(?:mon|tue|wed|thu|fri|sat|sun)\w*,?\s+"
        r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\.?\s+\d{1,2},?\s+\d{4}\b"
        r"|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\.?\s+\d{1,2},?\s+\d{4}\b"
        r"|\b(?:mon|tue|wed|thu|fri|sat|sun)\w*,?\s+"
        r"(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\.?\s+\d{1,2}\b"
        r"|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\w*\.?\s+\d{1,2}\b",
        compact,
        flags=re.IGNORECASE,
    )
    if date_match and not local_date:
        raw = date_match.group(0).replace(".", "").replace("Sept", "Sep").replace("sept", "sep")
        for fmt in ("%a, %b %d, %Y", "%a %b %d, %Y", "%A, %B %d, %Y", "%A %B %d, %Y", "%b %d, %Y", "%B %d, %Y"):
            try:
                local_date = datetime.strptime(raw, fmt).date().isoformat()
                break
            except ValueError:
                continue
        if not local_date:
            current_year = date.today().year
            for fmt in ("%a, %b %d", "%a %b %d", "%A, %B %d", "%A %B %d", "%b %d", "%B %d"):
                try:
                    partial = datetime.strptime(raw, fmt)
                    candidate = date(current_year, partial.month, partial.day)
                    if candidate < date.today():
                        candidate = date(current_year + 1, partial.month, partial.day)
                    local_date = candidate.isoformat()
                    break
                except ValueError:
                    continue

    time_match = re.search(r"\b(\d{1,2})(?::(\d{2}))?\s*([ap]m)\b", compact, flags=re.IGNORECASE)
    if time_match:
        hour = int(time_match.group(1))
        minute = int(time_match.group(2) or 0)
        meridiem = time_match.group(3).lower()
        if meridiem == "pm" and hour != 12:
            hour += 12
        if meridiem == "am" and hour == 12:
            hour = 0
        local_time = f"{hour:02d}:{minute:02d}"

    return {"localDate": local_date, "localTime": local_time}


def _build_id(source: str, url: Optional[str], name: str, date: Optional[str]) -> str:
    base = f"{source}|{url or ''}|{name}|{date or ''}"
    return hashlib.md5(base.encode("utf-8")).hexdigest()


def _normalize_event(source: str, event: Dict, fallback_url: Optional[str]) -> Dict:
    name = _clean_event_name(event.get("name") or "Untitled Show")
    url = _canonicalize_url(event.get("url") or fallback_url)
    image = event.get("image")
    if isinstance(image, list):
        image = image[0] if image else None

    start_date = event.get("startDate")
    date_parts = _parse_iso_date(start_date)

    offers = event.get("offers")
    if isinstance(offers, list):
        offers = offers[0] if offers else None

    price_info = _parse_price(offers.get("price") if isinstance(offers, dict) else None)

    location = event.get("location", {}) if isinstance(event.get("location"), dict) else {}
    address = location.get("address", {}) if isinstance(location.get("address"), dict) else {}

    venue_name = html_lib.unescape(location.get("name") or "")
    if source == "harlows" and "starlet" in venue_name.lower():
        venue_key = "the_starlet_room"
    else:
        venue_key = source

    fallback = KNOWN_VENUES.get(venue_key, {})
    venue_name = venue_name or fallback.get("name")
    street = html_lib.unescape(address.get("streetAddress") or fallback.get("address") or "")
    city = html_lib.unescape(address.get("addressLocality") or fallback.get("city") or "")
    state = html_lib.unescape(address.get("addressRegion") or fallback.get("state") or "")
    postal = html_lib.unescape(address.get("postalCode") or fallback.get("postalCode") or "")

    genre = event.get("genre")
    if isinstance(genre, list):
        genre = ", ".join(str(item).strip() for item in genre if item)
    if genre:
        genre = html_lib.unescape(str(genre))

    return {
        "id": _build_id(source, url, name, date_parts["localDate"]),
        "name": name,
        "url": url,
        "localDate": date_parts["localDate"],
        "localTime": date_parts["localTime"],
        "dateTBA": date_parts["localDate"] is None,
        "timeTBA": date_parts["localTime"] is None,
        "status": None,
        "image": image,
        "priceMin": price_info["priceMin"],
        "priceMax": price_info["priceMax"],
        "currency": offers.get("priceCurrency") if isinstance(offers, dict) else None,
        "genre": genre,
        "subGenre": None,
        "segment": None,
        "venue": {
            "name": venue_name,
            "address": street,
            "city": city,
            "state": state,
            "postalCode": postal
        },
        "source": source
    }


def _discover_event_links(listing_url: str, include_patterns: List[str]) -> List[str]:
    html = _fetch(listing_url)
    if not html:
        return []

    soup = BeautifulSoup(html, "lxml")
    decoded_html = html.replace("\\/", "/")
    links = set()
    base_netloc = urlparse(listing_url).netloc

    def allow_url(candidate: str) -> bool:
        parsed = urlparse(candidate)
        host = parsed.netloc.lower()
        same_site = host == base_netloc.lower()
        trusted_ticket_host = any(hint in host for hint in TICKET_HOST_HINTS)
        return same_site or trusted_ticket_host

    for anchor in soup.find_all("a", href=True):
        href = urljoin(listing_url, anchor["href"])
        if not allow_url(href):
            continue
        if any(pattern in href for pattern in include_patterns) and _looks_like_event_detail_url(href):
            links.add(href.split("#")[0].rstrip("/"))

    # Some venues render event URLs in scripts/data attributes rather than anchors.
    for pattern in include_patterns:
        regex = re.compile(rf"(https?://[^\"' <>()]+{re.escape(pattern)}[^\"' <>()]*)", flags=re.IGNORECASE)
        for match in regex.findall(decoded_html):
            href = urljoin(listing_url, match)
            if allow_url(href) and _looks_like_event_detail_url(href):
                links.add(href.split("#")[0].rstrip("/"))

        rel_regex = re.compile(rf"([\"'])(/{re.escape(pattern.lstrip('/'))}[^\"']*)\1", flags=re.IGNORECASE)
        for _, rel in rel_regex.findall(decoded_html):
            href = urljoin(listing_url, rel)
            if allow_url(href) and _looks_like_event_detail_url(href):
                links.add(href.split("#")[0].rstrip("/"))

    # Fallback for Ace/LiveNation pages that only expose Ticketmaster event URLs in embedded JSON.
    for match in re.findall(r"https?://www\.ticketmaster\.com/[^\"' <>()]+/event/[^\"' <>()]+", decoded_html):
        href = urljoin(listing_url, match)
        if _looks_like_event_detail_url(href):
            links.add(href.split("#")[0].rstrip("/"))

    return list(links)


def _scrape_event_page(url: str, source: str) -> Optional[Dict]:
    html = _fetch(url)
    if not html:
        return None

    soup = BeautifulSoup(html, "lxml")
    items = _parse_jsonld(soup)
    event_data = _extract_event_from_jsonld(items)
    if event_data:
        event = _normalize_event(source, event_data, url)
    else:
        page_text = soup.get_text(" ", strip=True)
        parsed_datetime = _extract_datetime_from_text(page_text)
        title = _extract_best_title(soup)
        if not title:
            return None

        image = None
        og_image = soup.find("meta", attrs={"property": "og:image"})
        if og_image and og_image.get("content"):
            image = og_image["content"].strip()

        event = {
            "id": _build_id(source, _canonicalize_url(url), title, parsed_datetime["localDate"]),
            "name": title,
            "url": _canonicalize_url(url),
            "localDate": parsed_datetime["localDate"],
            "localTime": parsed_datetime["localTime"],
            "dateTBA": parsed_datetime["localDate"] is None,
            "timeTBA": parsed_datetime["localTime"] is None,
            "status": None,
            "image": image,
            "priceMin": None,
            "priceMax": None,
            "currency": "USD",
            "genre": None,
            "subGenre": None,
            "segment": None,
            "venue": KNOWN_VENUES.get(source, {"name": None, "city": "Sacramento", "state": "CA"}),
            "source": source
        }

    if _is_generic_title(event.get("name")):
        derived = _title_from_event_url(url)
        if not derived or _is_generic_title(derived):
            return None
        event["name"] = derived
        event["id"] = _build_id(source, event.get("url"), derived, event.get("localDate"))

    page_text = soup.get_text(" ", strip=True)

    if not event.get("image"):
        event["image"] = _extract_best_image_url(soup, event.get("name"))

    if not event.get("localDate") or not event.get("localTime"):
        parsed_datetime = _extract_datetime_from_text(page_text)
        if not event.get("localDate"):
            event["localDate"] = parsed_datetime["localDate"]
            event["dateTBA"] = event["localDate"] is None
        if not event.get("localTime"):
            event["localTime"] = parsed_datetime["localTime"]
            event["timeTBA"] = event["localTime"] is None

    needs_price = (
        event.get("priceMin") in (None, 0)
        and event.get("priceMax") in (None, 0)
    )

    if needs_price:
        jsonld_prices = _extract_prices_from_jsonld(items)
        if jsonld_prices:
            best = min(jsonld_prices)
            event["priceMin"] = best
            event["priceMax"] = best
            event["currency"] = event.get("currency") or "USD"
            needs_price = False

    if needs_price:
        page_prices = _extract_ticket_prices_from_text(page_text)
        if page_prices:
            best = min(page_prices)
            event["priceMin"] = best
            event["priceMax"] = best
            event["currency"] = event.get("currency") or "USD"
            needs_price = False

    if needs_price:
        ticket_links = _find_ticket_links(soup)
        ticket_links.extend(_extract_ticket_links_from_html(html, url))
        seen_ticket = set()
        ticket_links = [link for link in ticket_links if not (link in seen_ticket or seen_ticket.add(link))]
        if ticket_links:
            event["url"] = urljoin(url, ticket_links[0])
        for ticket_href in ticket_links[:5]:
            ticket_url = urljoin(url, ticket_href)
            ticket_html = _fetch(ticket_url)
            if not ticket_html:
                continue

            ticket_soup = BeautifulSoup(ticket_html, "lxml")
            ticket_jsonld = _parse_jsonld(ticket_soup)
            ticket_prices = _extract_prices_from_jsonld(ticket_jsonld)
            ticket_prices.extend(_extract_prices_from_text(ticket_html))
            ticket_prices.extend(_extract_ticket_prices_from_text(ticket_html))
            if ticket_prices:
                best = min(ticket_prices)
                event["priceMin"] = best
                event["priceMax"] = best
                event["currency"] = event.get("currency") or "USD"
                needs_price = False
                break

            nested_links = _find_ticket_links(ticket_soup)
            nested_links.extend(_extract_ticket_links_from_html(ticket_html, ticket_url))
            seen_nested = set()
            nested_links = [link for link in nested_links if not (link in seen_nested or seen_nested.add(link))]
            for nested_href in nested_links[:3]:
                nested_url = urljoin(ticket_url, nested_href)
                nested_html = _fetch(nested_url)
                if not nested_html:
                    continue
                nested_soup = BeautifulSoup(nested_html, "lxml")
                nested_jsonld = _parse_jsonld(nested_soup)
                nested_prices = _extract_prices_from_jsonld(nested_jsonld)
                nested_prices.extend(_extract_prices_from_text(nested_html))
                nested_prices.extend(_extract_ticket_prices_from_text(nested_html))
                if nested_prices:
                    best = min(nested_prices)
                    event["priceMin"] = best
                    event["priceMax"] = best
                    event["currency"] = event.get("currency") or "USD"
                    needs_price = False
                    break
            if not needs_price:
                break

    if event.get("priceMin") == 0 and event.get("priceMax") == 0 and not _looks_free(page_text):
        event["priceMin"] = None
        event["priceMax"] = None

    return event


def _scrape_source(listing_url: str, include_patterns: List[str], source: str) -> List[Dict]:
    links = _discover_event_links(listing_url, include_patterns)
    if not links:
        return []

    events = []
    with ThreadPoolExecutor(max_workers=SCRAPE_WORKERS) as executor:
        futures = [executor.submit(_scrape_event_page, link, source) for link in links[:MAX_LINKS_PER_SOURCE]]
        for future in as_completed(futures):
            try:
                event = future.result()
                if event:
                    events.append(event)
            except Exception:
                continue
    return events


def _scrape_source_multi(listing_urls: List[str], include_patterns: List[str], source: str) -> List[Dict]:
    combined = []
    seen_ids = set()
    for listing_url in listing_urls:
        for event in _scrape_source(listing_url, include_patterns, source):
            event_id = event.get("id")
            if event_id and event_id not in seen_ids:
                seen_ids.add(event_id)
                combined.append(event)
    return combined


def scrape_harlows() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://www.harlows.com/",
            "https://www.harlows.com/events/",
            "https://www.harlows.com/shows/",
            "https://www.harlows.com/calendar/",
            # Etix venue listings often include farther-out dates than venue homepages.
            "https://www.etix.com/ticket/v/26119/harlows",
            "https://www.etix.com/ticket/v/26119/harlows?page=1",
            "https://www.etix.com/ticket/v/26119/harlows?page=2",
            "https://www.etix.com/ticket/v/26119/harlows?page=3",
            "https://www.etix.com/ticket/v/26120/the-starlet-room",
            "https://www.etix.com/ticket/v/26120/the-starlet-room?page=1",
            "https://www.etix.com/ticket/v/26120/the-starlet-room?page=2",
            "https://www.etix.com/ticket/v/26120/the-starlet-room?page=3",
        ],
        ["/event/", "/events/", "/shows/", "/show/", "/ticket/p/", "/ticket/e/", "/ticket/"],
        "harlows",
    )


def scrape_cafe_colonial() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://cafecolonial916.com/",
            "https://cafecolonial916.com/events/",
        ],
        ["/event/", "/events/", "/shows/", "/show/"],
        "cafe_colonial",
    )


def scrape_ace_of_spades() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://www.aceofspadessac.com/",
            "https://www.aceofspadessac.com/shows",
            "https://www.aceofspadessac.com/events/",
            "https://www.aceofspadessac.com/calendar/",
            "https://www.livenation.com/venue/KovZpZAEk6AA/ace-of-spades-events",
            "https://concerts.livenation.com/ace-of-spades-tickets-sacramento/venue/KovZpZAEk6AA",
            "https://www.ticketmaster.com/ace-of-spades-tickets-sacramento/venue/229282",
            "https://www.ticketmaster.com/search?q=ace+of+spades+sacramento",
            "https://www.ticketmaster.com/search?q=ace+of+spades",
        ],
        ["/event/", "/events/", "/shows/", "/show/", "/ticket/", "/concert/"],
        "ace_of_spades",
    )


def scrape_starlet_room_etix() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://www.etix.com/ticket/v/26120/the-starlet-room",
            "https://www.etix.com/ticket/v/26120/the-starlet-room?page=1",
            "https://www.etix.com/ticket/v/26120/the-starlet-room?page=2",
            "https://www.etix.com/ticket/v/26120/the-starlet-room?page=3",
        ],
        ["/ticket/p/", "/ticket/e/", "/ticket/"],
        "the_starlet_room",
    )


def scrape_channel_24() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://channel24sac.com/",
            "https://channel24sac.com/events/",
            "https://channel24sac.com/events/?page=1",
            "https://channel24sac.com/events/?page=2",
            "https://channel24sac.com/events/?page=3",
            "https://channel24sac.com/events/?page=4",
            "https://channel24sac.com/events/?page=5",
            "https://channel24sac.com/events/?page=6",
        ],
        ["/event/", "/events/", "/shows/", "/show/"],
        "channel_24",
    )


def scrape_goldfield_trading_post() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://goldfieldtradingpost.com/",
            "https://goldfieldtradingpost.com/events/",
            "https://goldfieldtradingpost.com/calendar/",
        ],
        ["/event/", "/events/", "/shows/", "/show/", "/calendar/"],
        "goldfield_trading_post",
    )


def scrape_old_ironsides() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://theoldironsides.com/",
            "https://theoldironsides.com/events/",
            "https://theoldironsides.com/calendar/",
        ],
        ["/event/", "/events/", "/shows/", "/show/", "/calendar/"],
        "old_ironsides",
    )


def scrape_the_boardwalk() -> List[Dict]:
    return _scrape_source_multi(
        [
            "https://www.rocktheboardwalk.com/",
            "https://www.rocktheboardwalk.com/events/",
        ],
        ["/event/", "/events/", "/shows/", "/show/"],
        "the_boardwalk",
    )


def scrape_all_sources() -> List[Dict]:
    events = []
    for scraper in (
        scrape_harlows,
        scrape_cafe_colonial,
        scrape_channel_24,
        scrape_goldfield_trading_post,
        scrape_old_ironsides,
    ):
        events.extend(scraper())
    events.extend(_load_manual_events())

    unique = {}
    for event in events:
        canonical_url = _canonicalize_url(event.get("url") or "")
        if canonical_url:
            key = f"{event.get('source','')}|{canonical_url}"
        else:
            key = f"{event.get('source','')}|id:{event.get('id','')}"
        unique[key] = event
    return sorted(unique.values(), key=lambda e: e.get("localDate") or "9999-12-31")


def _scrape_wp_tribe_events(api_url: str, source: str) -> List[Dict]:
    payload = _fetch_json(api_url)
    if not isinstance(payload, dict):
        return []

    events = payload.get("events")
    if not isinstance(events, list):
        return []

    normalized = []
    fallback = KNOWN_VENUES.get(source, {})
    for item in events:
        if not isinstance(item, dict):
            continue
        title_obj = item.get("title")
        title = title_obj.get("rendered") if isinstance(title_obj, dict) else item.get("title")
        title = _clean_event_name(title)
        if not title:
            continue

        event_url = _canonicalize_url(item.get("url"))
        start_date = item.get("start_date") or item.get("start_date_utc") or item.get("start_date_details", {}).get("datetime")
        date_parts = _parse_iso_date(start_date)

        image = None
        image_obj = item.get("image")
        if isinstance(image_obj, dict):
            image = image_obj.get("url")

        venue_list = item.get("venue")
        venue_obj = venue_list[0] if isinstance(venue_list, list) and venue_list else {}
        if not isinstance(venue_obj, dict):
            venue_obj = {}

        venue_name = html_lib.unescape(venue_obj.get("venue") or venue_obj.get("name") or fallback.get("name") or "")
        street = html_lib.unescape(venue_obj.get("address") or fallback.get("address") or "")
        city = html_lib.unescape(venue_obj.get("city") or fallback.get("city") or "")
        state = html_lib.unescape(venue_obj.get("state") or fallback.get("state") or "")
        postal = html_lib.unescape(venue_obj.get("zip") or venue_obj.get("postal_code") or fallback.get("postalCode") or "")

        normalized.append({
            "id": _build_id(source, event_url, title, date_parts["localDate"]),
            "name": title,
            "url": event_url,
            "localDate": date_parts["localDate"],
            "localTime": date_parts["localTime"],
            "dateTBA": date_parts["localDate"] is None,
            "timeTBA": date_parts["localTime"] is None,
            "status": None,
            "image": image,
            "priceMin": None,
            "priceMax": None,
            "currency": "USD",
            "genre": None,
            "subGenre": None,
            "segment": None,
            "venue": {
                "name": venue_name,
                "address": street,
                "city": city,
                "state": state,
                "postalCode": postal,
            },
            "source": source,
        })
    return normalized
