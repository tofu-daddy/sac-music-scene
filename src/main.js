import './style.css';
import { fetchMusicEvents } from './api.js';
import { renderGrid, renderModal } from './ui.js';
import { debounce } from './utils.js';
import { trackEvent, trackPageView } from './analytics.js';

const STATE = {
  allEvents: [],
  filteredEvents: [],
  sources: [],
  filters: {
    search: '',
    selectedSources: new Set()
  }
};

const AVAILABLE_SOURCES = [
  'harlows',
  'cafe_colonial',
  'channel_24',
  'goldfield_trading_post',
  'old_ironsides'
];

const SOURCE_LABELS = {
  harlows: "Harlow's",
  ace_of_spades: 'Ace of Spades',
  cafe_colonial: 'Cafe Colonial',
  channel_24: 'Channel 24',
  goldfield_trading_post: 'Goldfield Trading Post',
  old_ironsides: 'Old Ironsides'
};

const DOM = {
  app: document.getElementById('app'),
  grid: null,
  search: null,
  sourceFilterBtn: null,
  sourceDropdown: null,
  clearFilters: null,
  activeFilters: null,
  resultsCount: null
};

let lastTrackedSearch = '';

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const LANDMARK_SKETCHES = [
  `${import.meta.env.BASE_URL}landmarks/sac-01.png`,
  `${import.meta.env.BASE_URL}landmarks/sac-02.png`,
  `${import.meta.env.BASE_URL}landmarks/sac-03.png`,
  `${import.meta.env.BASE_URL}landmarks/sac-04.png`,
  `${import.meta.env.BASE_URL}landmarks/sac-05.png`,
  `${import.meta.env.BASE_URL}landmarks/sac-06.png`,
  `${import.meta.env.BASE_URL}landmarks/sac-07.png`
];

function buildLandmarkLayer() {
  const placed = [];
  return LANDMARK_SKETCHES.map((src, index) => {
    let top = Math.round(6 + Math.random() * 68);
    let left = Math.round(4 + Math.random() * 84);
    let attempts = 0;
    while (
      attempts < 40 &&
      placed.some((point) => {
        const dx = point.left - left;
        const dy = point.top - top;
        return Math.sqrt(dx * dx + dy * dy) < 18;
      })
    ) {
      top = Math.round(6 + Math.random() * 68);
      left = Math.round(4 + Math.random() * 84);
      attempts += 1;
    }
    placed.push({ top, left });
    const width = Math.round(88 + Math.random() * 96);
    const rotation = Math.round(-22 + Math.random() * 44);
    const opacity = (0.1 + Math.random() * 0.17).toFixed(2);
    const z = 1 + (index % 3);
    return `
      <img
        src="${src}"
        alt=""
        aria-hidden="true"
        class="landmark-sketch"
        style="top:${top}%;left:${left}%;width:${width}px;transform:translate(-50%, -50%) rotate(${rotation}deg);opacity:${opacity};z-index:${z};"
      >
    `;
  }).join('');
}

function getInitialSearchTerm() {
  const params = new URLSearchParams(window.location.search);
  return (params.get('q') || '').trim();
}

function syncSearchToUrl() {
  const url = new URL(window.location.href);
  if (STATE.filters.search) {
    url.searchParams.set('q', STATE.filters.search);
  } else {
    url.searchParams.delete('q');
  }
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

async function init() {
  renderAppStructure();
  trackPageView();

  DOM.grid = document.getElementById('event-grid');
  DOM.search = document.getElementById('search-input');
  DOM.sourceFilterBtn = document.getElementById('source-filter-btn');
  DOM.sourceDropdown = document.getElementById('source-filter-dropdown');
  DOM.clearFilters = document.getElementById('clear-filters');
  DOM.activeFilters = document.getElementById('active-filters');
  DOM.resultsCount = document.getElementById('results-count');

  const initialSearch = getInitialSearchTerm();
  if (initialSearch) {
    STATE.filters.search = initialSearch.toLowerCase();
    lastTrackedSearch = initialSearch;
    DOM.search.value = initialSearch;
  }

  setupEventListeners();

  DOM.grid.innerHTML = `
    <div class="col-span-full text-center py-20">
      <div class="inline-block w-8 h-8 border-4 border-accent border-r-transparent rounded-full animate-spin"></div>
      <p class="mt-4 text-secondary animate-pulse">Loading Sacramento shows...</p>
    </div>
  `;

  const { events, error } = await fetchMusicEvents();
  if (error) {
    const safeError = escapeHtml(error);
    DOM.grid.innerHTML = `
      <div class="col-span-full text-center py-16">
        <p class="text-lg font-semibold">Unable to load shows.</p>
        <p class="text-secondary text-sm mt-2">${safeError}</p>
      </div>
    `;
    return;
  }

  STATE.allEvents = events;
  STATE.filteredEvents = events;
  STATE.sources = buildSources(events);
  trackEvent('shows_loaded', {
    count: events.length
  });
  renderSourceFilters();
  updateDisplay();
}

function buildSources(events) {
  const sourceSet = new Set(AVAILABLE_SOURCES);
  events.forEach(event => {
    if (event.source) sourceSet.add(event.source);
  });
  return Array.from(sourceSet).sort((a, b) => {
    const labelA = SOURCE_LABELS[a] || a;
    const labelB = SOURCE_LABELS[b] || b;
    return labelA.localeCompare(labelB);
  });
}

function renderAppStructure() {
  DOM.app.innerHTML = `
    <div class="ambient-bg"></div>
    <header id="site-header" class="sticky top-0 z-30 bg-background/90 backdrop-blur border-b border-border">
      <div class="header-inner max-w-6xl mx-auto px-4 py-6">
        <div class="landmark-collage" aria-hidden="true">
          ${buildLandmarkLayer()}
        </div>
        <div class="flex flex-col gap-6">
          <div class="hero-shell flex flex-col gap-5">
            <div>
              <p class="eyebrow">Sacramento, CA</p>
              <div class="hero-title-wrap">
                <h1 class="hero-title mt-3 font-semibold">SAC MUSIC SCENE</h1>
                <div class="hero-orbit hero-orbit-collage" aria-hidden="true">
                  <svg viewBox="0 0 160 160" class="hero-orbit-svg">
                    <defs>
                      <path id="hero-orbit-path" d="M80,80 m-57,0 a57,57 0 1,1 114,0 a57,57 0 1,1 -114,0" />
                    </defs>
                    <text class="hero-orbit-text">
                      <textPath href="#hero-orbit-path" startOffset="0%" textLength="358" lengthAdjust="spacing">
                        LIVE WEEKLY • SACRAMENTO.CA • LIVE WEEKLY • SACRAMENTO.CA •
                      </textPath>
                    </text>
                  </svg>
                </div>
              </div>
              <p class="hero-sub mt-4">
                The city after dark. One feed for club nights, touring acts, and local lineups.
              </p>
            </div>
            <div class="hero-right">
              <div class="stat-card">
                <div class="text-xs uppercase tracking-[0.2em] text-secondary">Shows found</div>
                <div class="text-3xl font-semibold mt-2" id="results-count">--</div>
              </div>
            </div>
          </div>

          <div class="filter-panel">
            <div class="flex flex-col lg:flex-row gap-3 lg:items-center">
              <div class="relative flex-1">
                <input type="text" id="search-input" placeholder="Search by artist, venue, or keyword"
                  class="w-full bg-surface border border-border rounded-lg pl-10 pr-4 py-3 text-sm focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all placeholder:text-secondary/60">
                <svg class="absolute left-3 top-3.5 text-secondary w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
              </div>

              <div class="grid grid-cols-2 gap-3 lg:flex lg:gap-3">
                <div class="relative">
                  <button id="source-filter-btn" class="w-full lg:w-auto flex items-center justify-between gap-2 bg-surface border border-border px-4 py-3 rounded-lg text-sm hover:border-accent transition-colors min-w-0 lg:min-w-[180px]">
                    <span>Filter Venues</span>
                    <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                  </button>
                  <div class="absolute right-0 top-full mt-2 w-72 bg-surface border border-border rounded-lg shadow-xl p-3 hidden z-40" id="source-filter-dropdown">
                    <div class="grid grid-cols-1 gap-2" id="source-filter-options"></div>
                  </div>
                </div>

                <button id="clear-filters" class="w-full text-sm px-4 py-3 border border-border rounded-lg text-secondary hover:text-white hover:border-accent transition-colors">
                  Clear filters
                </button>
              </div>
            </div>

            <div id="active-filters" class="flex gap-2 flex-wrap mt-3 hidden text-sm"></div>
          </div>
        </div>
      </div>
    </header>

    <main class="max-w-6xl mx-auto px-4 py-8 min-h-[calc(100vh-120px)]">
      <div id="event-grid" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
        <!-- Cards injected -->
      </div>
    </main>

    <footer class="max-w-6xl mx-auto px-4 pb-10 text-xs text-secondary">
      Data scraped from venue sites. Always confirm details on the ticketing page. Project by
      <a href="https://www.instagram.com/tofu.daddy/" target="_blank" rel="noopener noreferrer" class="underline text-secondary hover:text-secondary">TofuDaddy</a>.
      <a href="https://buymeacoffee.com/tofudaddy" target="_blank" rel="noopener noreferrer" class="underline text-secondary hover:text-secondary">Buy him Coffee</a>.
    </footer>

    <div id="modal-container"></div>
  `;
}

function renderSourceFilters() {
  const container = document.getElementById('source-filter-options');
  container.innerHTML = STATE.sources.map(source => `
    <label class="flex items-center gap-2 cursor-pointer p-1 hover:bg-white/5 rounded">
      <input type="checkbox" value="${escapeHtml(source)}" class="source-checkbox rounded border-gray-600 text-accent focus:ring-accent bg-transparent">
      <span class="text-secondary text-sm">${escapeHtml(SOURCE_LABELS[source] || source.replace(/_/g, ' '))}</span>
    </label>
  `).join('');

  document.querySelectorAll('.source-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const sourceValue = e.target.value;
      if (e.target.checked) {
        STATE.filters.selectedSources.add(sourceValue);
      } else {
        STATE.filters.selectedSources.delete(sourceValue);
      }
      trackEvent('venue_filter_change', {
        venue: SOURCE_LABELS[sourceValue] || sourceValue,
        selected: e.target.checked,
        selected_count: STATE.filters.selectedSources.size
      });
      applyFilters();
    });
  });
}

function setupEventListeners() {
  const header = document.getElementById('site-header');
  let condensed = false;
  let rafId = null;
  const syncHeaderState = () => {
    if (!header) return;
    const y = window.scrollY;
    // Hysteresis avoids rapid state flipping around one threshold.
    if (!condensed && y > 84) {
      condensed = true;
      header.classList.add('is-condensed');
    } else if (condensed && y < 40) {
      condensed = false;
      header.classList.remove('is-condensed');
    }
  };
  syncHeaderState();
  window.addEventListener('scroll', () => {
    if (rafId) return;
    rafId = window.requestAnimationFrame(() => {
      syncHeaderState();
      rafId = null;
    });
  }, { passive: true });

  DOM.search.addEventListener('input', debounce((e) => {
    const rawValue = e.target.value.trim();
    STATE.filters.search = rawValue.toLowerCase();
    if (rawValue !== lastTrackedSearch) {
      lastTrackedSearch = rawValue;
      trackEvent('search', {
        search_term: rawValue,
        search_length: rawValue.length
      });
    }
    applyFilters();
  }, 300));

  DOM.sourceFilterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    DOM.sourceDropdown.classList.toggle('hidden');
    trackEvent('venue_filter_dropdown_toggle', {
      opened: !DOM.sourceDropdown.classList.contains('hidden')
    });
  });

  document.addEventListener('click', (e) => {
    if (DOM.sourceDropdown) {
      const clickedSource = e.target.closest('#source-filter-btn') || e.target.closest('#source-filter-dropdown');
      if (!clickedSource) DOM.sourceDropdown.classList.add('hidden');
    }
  });

  DOM.clearFilters.addEventListener('click', () => {
    const hadSearch = Boolean(STATE.filters.search);
    const hadSelectedVenues = STATE.filters.selectedSources.size > 0;
    STATE.filters.search = '';
    STATE.filters.selectedSources.clear();

    DOM.search.value = '';
    lastTrackedSearch = '';
    document.querySelectorAll('.source-checkbox').forEach(cb => {
      cb.checked = false;
    });
    trackEvent('clear_filters', {
      had_search: hadSearch,
      had_selected_venues: hadSelectedVenues
    });
    applyFilters();
  });

  DOM.grid.addEventListener('click', (e) => {
    const card = e.target.closest('.event-card');
    if (!card) return;
    const event = STATE.allEvents.find(item => item.id === card.dataset.id);
    if (event) openModal(event);
  });
}

function applyFilters() {
  const { search, selectedSources } = STATE.filters;

  STATE.filteredEvents = STATE.allEvents.filter(event => {
    const matchesSearch = !search || [
      event.name,
      event.venue?.name,
      event.venue?.city,
      event.venue?.state
    ].filter(Boolean).some(value => value.toLowerCase().includes(search));

    const matchesSource = selectedSources.size === 0 || (event.source && selectedSources.has(event.source));
    return matchesSearch && matchesSource;
  });

  syncSearchToUrl();
  updateDisplay();
}

function updateActiveFilters() {
  const active = [];
  if (STATE.filters.search) active.push(`Search: "${STATE.filters.search}"`);
  if (STATE.filters.selectedSources.size) {
    active.push(...Array.from(STATE.filters.selectedSources).map(s => SOURCE_LABELS[s] || s.replace(/_/g, ' ')));
  }

  if (!active.length) {
    DOM.activeFilters.classList.add('hidden');
    DOM.activeFilters.innerHTML = '';
    return;
  }

  DOM.activeFilters.classList.remove('hidden');
  DOM.activeFilters.innerHTML = active.map(label => `
    <span class="bg-accent/20 text-accent border border-accent/50 text-xs px-2 py-1 rounded-full">${escapeHtml(label)}</span>
  `).join('');
}

function updateDisplay() {
  updateActiveFilters();
  DOM.resultsCount.textContent = STATE.filteredEvents.length;
  renderGrid(STATE.filteredEvents, DOM.grid);
  updateEventSchema(STATE.filteredEvents);
}

function openModal(event) {
  const container = document.getElementById('modal-container');
  container.innerHTML = renderModal(event);
  trackEvent('show_details_open', {
    event_id: event.id,
    event_name: event.name,
    venue: event.venue?.name || 'unknown'
  });

  const closeModal = () => {
    document.removeEventListener('keydown', onKeyDown);
    container.innerHTML = '';
  };
  const onKeyDown = (evt) => {
    if (evt.key === 'Escape') closeModal();
  };

  const closeBtn = document.getElementById('close-modal');
  const closeBtnSecondary = document.getElementById('close-modal-secondary');
  const backdrop = document.getElementById('modal-backdrop');
  const ticketLink = document.getElementById('ticket-link');

  closeBtn?.addEventListener('click', closeModal);
  closeBtnSecondary?.addEventListener('click', closeModal);
  ticketLink?.addEventListener('click', () => {
    trackEvent('select_content', {
      content_type: 'ticket_link',
      item_id: event.id,
      item_name: event.name,
      venue: event.venue?.name || 'unknown'
    });
    trackEvent('outbound_click', {
      destination: event.url || '',
      event_id: event.id
    });
  });
  backdrop?.addEventListener('click', (e) => {
    if (e.target === backdrop) closeModal();
  });
  document.addEventListener('keydown', onKeyDown);
}

function updateEventSchema(events) {
  const scriptId = 'event-schema-jsonld';
  const existing = document.getElementById(scriptId);
  const topEvents = events.slice(0, 25);
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Sacramento Music Shows',
    itemListElement: topEvents.map((event, index) => {
      const location = {
        '@type': 'Place',
        name: event.venue?.name || 'Venue TBA',
        address: {
          '@type': 'PostalAddress',
          streetAddress: event.venue?.address || '',
          addressLocality: event.venue?.city || '',
          addressRegion: event.venue?.state || '',
          postalCode: event.venue?.postalCode || '',
          addressCountry: 'US'
        }
      };
      const startDate = event.localDate
        ? `${event.localDate}T${event.localTime || '19:00'}:00`
        : undefined;

      return {
        '@type': 'ListItem',
        position: index + 1,
        item: {
          '@type': 'MusicEvent',
          name: event.name,
          startDate,
          eventStatus: 'https://schema.org/EventScheduled',
          location,
          url: event.url || 'https://tofu-daddy.github.io/sac-music-scene/'
        }
      };
    })
  };

  const script = existing || document.createElement('script');
  script.type = 'application/ld+json';
  script.id = scriptId;
  script.textContent = JSON.stringify(schema);
  if (!existing) document.head.appendChild(script);
}

init();
