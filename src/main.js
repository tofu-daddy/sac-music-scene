import './style.css';
import { fetchPokemonList, fetchPokemonDetails, fetchAllTypes } from './api.js';
import { renderGrid, renderModal, hydratePokemonTypes } from './ui.js';
import { debounce } from './utils.js';

const STATE = {
  allPokemon: [], // { name, url, id, types: [], ... } full details
  filteredPokemon: [],
  types: [],
  filters: {
    search: '',
    selectedTypes: new Set()
  },
  loading: true
};

const DOM = {
  app: document.getElementById('app'),
  grid: null, // defined after init
  search: null,
  typeFilter: null,
  filterBtn: null,
  filterDropdown: null
};

async function init() {
  renderAppStructure();

  DOM.grid = document.getElementById('pokemon-grid');
  DOM.search = document.getElementById('search-input');
  DOM.typeFilter = document.getElementById('type-filter');
  DOM.filterBtn = document.getElementById('filter-btn');
  DOM.filterDropdown = document.getElementById('type-filter-dropdown');

  setupEventListeners();

  try {
    // 1. Fetch Types
    const typeList = await fetchAllTypes();
    STATE.types = typeList.map(t => t.name).filter(n => n !== 'unknown' && n !== 'shadow');
    renderTypeFilters();

    // 2. Fetch Pokemon List
    // Show loading state
    DOM.grid.innerHTML = '<div class="col-span-full text-center py-20"><div class="inline-block w-8 h-8 border-4 border-accent border-r-transparent rounded-full animate-spin"></div><p class="mt-4 text-secondary animate-pulse">Catching them all...</p></div>';

    // We fetch 151 (Gen 1)
    const basicList = await fetchPokemonList(151);

    // 3. Fetch details for all (for filtering capability)
    // We do this in batches to avoid network congestion, though 150 is manageable.
    const detailsPromises = basicList.map(p => fetchPokemonDetails(p.url));
    const allDetails = await Promise.all(detailsPromises);

    // Enrich data
    STATE.allPokemon = allDetails.filter(p => p !== null).map(p => ({
      ...p,
      // Add any extra normalized fields if needed
    }));

    STATE.filteredPokemon = STATE.allPokemon;
    STATE.loading = false;

    gtag('event', 'pokédex_loaded', {
      'total_pokémon': STATE.allPokemon.length,
      'types_available': STATE.types.length
    });

    updateDisplay();

  } catch (error) {
    console.error('Init error:', error);
    DOM.grid.innerHTML = '<div class="col-span-full text-center text-red-500">Failed to load Pokémon data. Please refresh using the circular arrow in your browser toolbar to try again.</div>';
  }
}

function renderAppStructure() {
  DOM.app.innerHTML = `
    <header class="sticky top-0 z-30 bg-background/95 backdrop-blur border-b border-border shadow-md">
      <div class="max-w-5xl mx-auto px-4 py-6">
        <div class="flex flex-col items-center text-center gap-3">
          <div class="flex items-center gap-3">
            <div class="w-10 h-10 bg-accent rounded-full flex items-center justify-center text-white font-bold animate-pulse">P</div>
            <h1 class="text-4xl md:text-5xl font-bold tracking-tight">Pokédex</h1>
          </div>
          <p class="text-secondary text-sm md:text-base max-w-xl">
            Search the original 151 and filter by type.
          </p>
        </div>

        <div class="mt-6 bg-surface/70 border border-border rounded-2xl p-4 md:p-5 shadow-lg">
          <div class="flex flex-col md:flex-row gap-3 md:items-center">
            <div class="relative flex-1">
                <input type="text" id="search-input" placeholder="Search by name or ID..." 
                    class="w-full bg-surface border border-border rounded-lg pl-10 pr-4 py-3 text-sm md:text-base focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all placeholder:text-secondary/50">
                <svg class="absolute left-3 top-3.5 text-secondary w-4 h-4 md:w-5 md:h-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/></svg>
            </div>
            
            <div class="relative">
                <button id="filter-btn" class="w-full md:w-auto flex items-center justify-between gap-2 bg-surface border border-border px-4 py-3 rounded-lg text-sm md:text-base hover:border-accent transition-colors">
                    <span>Filter Type</span>
                    <svg class="w-4 h-4" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>
                </button>
                <!-- Dropdown -->
                <div class="absolute right-0 top-full mt-2 w-64 bg-surface border border-border rounded-lg shadow-xl p-3 hidden z-40" id="type-filter-dropdown">
                    <div class="grid grid-cols-2 gap-2" id="type-filter-options">
                        <!-- Options injected -->
                    </div>
                </div>
            </div>
          </div>

          <!-- Active Filters -->
          <div id="active-filters" class="flex gap-2 flex-wrap mt-3 hidden text-sm"></div>
        </div>
      </div>
    </header>
    
    <main class="max-w-7xl mx-auto px-4 py-8 min-h-[calc(100vh-80px)]">
      <div id="pokemon-grid" class="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-6">
        <!-- Cards injected -->
      </div>
    </main>

    <!-- Modal Container -->
    <div id="modal-container"></div>
  `;
}

function renderTypeFilters() {
  const container = document.getElementById('type-filter-options');
  container.innerHTML = STATE.types.map(type => `
        <label class="flex items-center gap-2 cursor-pointer p-1 hover:bg-white/5 rounded">
            <input type="checkbox" value="${type}" class="type-checkbox rounded border-gray-600 text-accent focus:ring-accent bg-transparent">
            <span class="capitalize text-secondary">${type}</span>
        </label>
    `).join('');

  // Add logic to checkboxes
  document.querySelectorAll('.type-checkbox').forEach(cb => {
    cb.addEventListener('change', (e) => {
      if (e.target.checked) {
        STATE.filters.selectedTypes.add(e.target.value);
        gtag('event', 'type_filter_added', {
          'pokemon_type': e.target.value
        });
      } else {
        STATE.filters.selectedTypes.delete(e.target.value);
        gtag('event', 'type_filter_removed', {
          'pokemon_type': e.target.value
        });
      }
      applyFilters();
    });
  });
}

function setupEventListeners() {
  DOM.search.addEventListener('input', debounce((e) => {
    STATE.filters.search = e.target.value.toLowerCase().trim();
    if (STATE.filters.search) {
      gtag('event', 'pokemon_search', {
        'search_term': STATE.filters.search,
        'results_count': STATE.filteredPokemon.length
      });
    }
    applyFilters();
  }, 300));

  DOM.filterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    DOM.filterDropdown.classList.toggle('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!DOM.filterDropdown) return;
    const clickedInside = e.target.closest('#filter-btn') || e.target.closest('#type-filter-dropdown');
    if (!clickedInside) DOM.filterDropdown.classList.add('hidden');
  });

  DOM.grid.addEventListener('click', async (e) => {
    const card = e.target.closest('.pokemon-card');
    if (card) {
      const id = card.dataset.id;
      const pokemon = STATE.allPokemon.find(p => p.id == id);
      if (pokemon) {
        gtag('event', 'pokemon_viewed', {
          'pokemon_id': id,
          'pokemon_name': pokemon.name,
          'pokemon_types': pokemon.types.map(t => t.type.name).join(',')
        });
        openModal(pokemon);
      }
    }
  });
}

function applyFilters() {
  const { search, selectedTypes } = STATE.filters;

  STATE.filteredPokemon = STATE.allPokemon.filter(p => {
    const matchesSearch = p.name.includes(search) || String(p.id) === search;
    const matchesType = selectedTypes.size === 0 || p.types.some(t => selectedTypes.has(t.type.name));
    return matchesSearch && matchesType;
  });

  updateDisplay();
}

function updateDisplay() {
  // Update active filter tags
  const activeContainer = document.getElementById('active-filters');
  if (STATE.filters.selectedTypes.size > 0) {
    activeContainer.classList.remove('hidden');
    activeContainer.innerHTML = Array.from(STATE.filters.selectedTypes).map(t => `
        <span class="bg-accent/20 text-accent border border-accent/50 text-xs px-2 py-1 rounded-full flex items-center gap-1">
            ${t}
            <button onclick="document.querySelector('input[value=${t}]').click()" class="hover:text-white">&times;</button>
        </span>
      `).join('');
  } else {
    activeContainer.classList.add('hidden');
  }

  // Render Grid
  // Pass the full pokemon object which includes types and sprites
  renderGrid(STATE.filteredPokemon, DOM.grid);
}

async function openModal(pokemon) {
  // We need species data for flavor text
  const container = document.getElementById('modal-container');
  container.innerHTML = '<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"><div class="animate-spin w-10 h-10 border-4 border-accent border-r-transparent rounded-full"></div></div>';

  try {
    const speciesRes = await fetch(pokemon.species.url);
    const speciesData = await speciesRes.json();

    container.innerHTML = renderModal(pokemon, speciesData);

    // Close events
    const closeBtn = document.getElementById('close-modal');
    const backdrop = document.getElementById('modal-backdrop');

    const close = () => {
      container.innerHTML = '';
    };

    closeBtn.addEventListener('click', close);
    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close();
    });
    document.onkeydown = function (evt) {
      if (evt.keyCode == 27) close();
    };

  } catch (e) {
    console.error(e);
    container.innerHTML = '';
  }
}

init();
