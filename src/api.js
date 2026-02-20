const DEFAULT_API_URL = import.meta.env.VITE_API_URL || '/api/shows';
const STATIC_EVENTS_PATH = `${import.meta.env.BASE_URL}events.json`;

async function fetchJson(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`Network response was not ok (${response.status})`);
  return response.json();
}

export async function fetchMusicEvents({ refresh = false } = {}) {
  const url = new URL(DEFAULT_API_URL, window.location.origin);
  if (refresh) url.searchParams.set('refresh', '1');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const data = await fetchJson(url.toString(), controller.signal);
    return { events: data.events || [], error: data.error || null };
  } catch (error) {
    try {
      const fallback = await fetchJson(STATIC_EVENTS_PATH, controller.signal);
      return { events: fallback.events || [], error: null };
    } catch (_fallbackError) {
      // Keep existing error handling for local dev issues when neither source is available.
    }
    const isTimeout = error?.name === 'AbortError';
    console.error('Error fetching scraped events:', error);
    return {
      events: [],
      error: isTimeout
        ? 'Request timed out. Check that the Python backend is running and responsive.'
        : 'Unable to reach the local scraper API. Start the Python backend and try again.'
    };
  } finally {
    clearTimeout(timeout);
  }
}
