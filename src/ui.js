const STATUS_LABELS = {
  cancelled: 'Canceled',
  postponed: 'Postponed',
  rescheduled: 'Rescheduled'
};

const SOURCE_FALLBACK_IMAGES = {
  channel_24: 'https://images.unsplash.com/photo-1459749411175-04bf5292ceea?auto=format&fit=crop&w=900&q=80',
  the_boardwalk: 'https://images.unsplash.com/photo-1501386761578-eac5c94b800a?auto=format&fit=crop&w=900&q=80',
  the_starlet_room: 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?auto=format&fit=crop&w=900&q=80',
  ace_of_spades: 'https://images.unsplash.com/photo-1498038432885-c6f3f1b912ee?auto=format&fit=crop&w=900&q=80',
  cafe_colonial: 'https://images.unsplash.com/photo-1470225620780-dba8ba36b745?auto=format&fit=crop&w=900&q=80'
};

const buildEventFallbackImage = (event) => {
  const seed = encodeURIComponent(event.id || event.name || 'live-music');
  return `https://picsum.photos/seed/${seed}/1200/800`;
};

const escapeHtml = (value) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const decodeHtmlEntities = (() => {
  const textarea = document.createElement('textarea');
  return (value) => {
    if (value == null) return '';
    textarea.innerHTML = String(value);
    return textarea.value;
  };
})();

const normalizeDisplayText = (value) => decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();

const sanitizeUrl = (value) => {
  if (!value) return null;
  try {
    const parsed = new URL(value, window.location.origin);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
  } catch (_err) {
    return null;
  }
  return null;
};

const formatDateLabel = (event) => {
  if (!event.localDate) return 'Date TBA';
  const date = new Date(`${event.localDate}T${event.localTime || '00:00:00'}`);
  if (Number.isNaN(date.getTime())) return 'Date TBA';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }).format(date);
};

const formatTimeLabel = (event) => {
  if (event.timeTBA || !event.localDate || !event.localTime) return 'Time TBA';
  const date = new Date(`${event.localDate}T${event.localTime}`);
  if (Number.isNaN(date.getTime())) return 'Time TBA';
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
};

const formatVenueLine = (venue) => {
  if (!venue) return 'Venue TBA';
  const venueName = normalizeDisplayText(venue.name);
  const city = normalizeDisplayText(venue.city);
  const state = normalizeDisplayText(venue.state);
  const parts = [venueName, city && state ? `${city}, ${state}` : null]
    .filter(Boolean);
  return parts.join(' • ') || 'Venue TBA';
};

export function renderGrid(events, container) {
  if (!events.length) {
    container.innerHTML = `
      <div class="col-span-full text-center py-16">
        <p class="text-lg font-semibold">No shows match those filters.</p>
        <p class="text-secondary text-sm mt-2">Try clearing a filter.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = events.map((event, index) => {
    const status = STATUS_LABELS[event.status] || null;
    const image = sanitizeUrl(event.image)
      || SOURCE_FALLBACK_IMAGES[event.source]
      || buildEventFallbackImage(event);
    const name = escapeHtml(normalizeDisplayText(event.name));
    const venueLine = escapeHtml(formatVenueLine(event.venue));
    const dateLabel = escapeHtml(formatDateLabel(event));
    const timeLabel = escapeHtml(formatTimeLabel(event));
    const statusLabel = status ? escapeHtml(status) : null;

    return `
      <article class="event-card group relative bg-surface border border-border rounded-2xl overflow-hidden shadow-lg transition-all duration-300 hover:-translate-y-1 hover:border-accent" data-id="${escapeHtml(event.id)}">
        <div class="relative h-40 overflow-hidden">
          <img src="${image}" alt="${name}" class="w-full h-full object-cover transition-transform duration-500 group-hover:scale-105" loading="lazy">
          <div class="absolute inset-0 bg-gradient-to-t from-black/70 via-black/10 to-transparent"></div>
          <div class="absolute left-4 bottom-4">
            <div class="text-xs uppercase tracking-[0.2em] text-white/70"> ${dateLabel} </div>
            <div class="text-white font-semibold text-sm">${timeLabel}</div>
          </div>
          ${statusLabel ? `<span class="absolute top-3 right-3 text-xs uppercase tracking-wide bg-rose-600/80 text-white px-2 py-1 rounded-full">${statusLabel}</span>` : ''}
        </div>
        <div class="p-4">
          <h3 class="text-lg font-semibold leading-tight">${name}</h3>
          <p class="text-secondary text-sm mt-1">${venueLine}</p>
          <div class="mt-4 flex items-center justify-end text-sm">
            <button class="text-accent font-semibold hover:text-accent-hover">Details</button>
          </div>
        </div>
      </article>
    `;
  }).join('');
}

export function renderModal(event) {
  const addressParts = [
    normalizeDisplayText(event.venue?.address),
    normalizeDisplayText(event.venue?.city),
    normalizeDisplayText(event.venue?.state),
    normalizeDisplayText(event.venue?.postalCode)
  ]
    .filter(Boolean);
  const safeImage = sanitizeUrl(event.image)
    || SOURCE_FALLBACK_IMAGES[event.source]
    || buildEventFallbackImage(event);
  const safeTicketUrl = sanitizeUrl(event.url);
  const name = escapeHtml(normalizeDisplayText(event.name));
  const venueLine = escapeHtml(formatVenueLine(event.venue));
  const dateLabel = escapeHtml(formatDateLabel(event));
  const timeLabel = escapeHtml(formatTimeLabel(event));
  const statusLabel = escapeHtml(STATUS_LABELS[event.status] || 'On Sale');
  const safeAddress = escapeHtml(addressParts.join(', ') || 'Address TBA');

  return `
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm" id="modal-backdrop">
      <div class="bg-surface border border-border rounded-2xl w-full max-w-3xl shadow-2xl overflow-hidden transition-transform duration-300">
        <div class="flex flex-col md:flex-row">
          <div class="md:w-1/2 h-56 md:h-auto">
            <img src="${safeImage}" alt="${name}" class="w-full h-full object-cover">
          </div>
          <div class="md:w-1/2 p-6 relative">
            <button class="absolute top-4 right-4 text-secondary hover:text-white" id="close-modal">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
            </button>
            <h2 class="text-2xl font-semibold mt-2">${name}</h2>
            <p class="text-secondary text-sm mt-2">${venueLine}</p>
            <div class="mt-4 grid grid-cols-2 gap-3 text-sm">
              <div class="bg-black/40 border border-border rounded-lg p-3">
                <div class="text-secondary text-xs uppercase">Date</div>
                <div class="font-semibold mt-1">${dateLabel}</div>
              </div>
              <div class="bg-black/40 border border-border rounded-lg p-3">
                <div class="text-secondary text-xs uppercase">Time</div>
                <div class="font-semibold mt-1">${timeLabel}</div>
              </div>
              <div class="bg-black/40 border border-border rounded-lg p-3">
                <div class="text-secondary text-xs uppercase">Status</div>
                <div class="font-semibold mt-1">${statusLabel}</div>
              </div>
            </div>
            <div class="mt-4">
              <div class="text-secondary text-xs uppercase">Address</div>
              <div class="text-sm mt-1">${safeAddress}</div>
            </div>
            <div class="mt-6 flex gap-3">
              ${safeTicketUrl ? `<a href="${safeTicketUrl}" target="_blank" rel="noopener" class="px-4 py-2 rounded-lg bg-accent text-black font-semibold hover:bg-accent-hover transition-colors">Get tickets</a>` : ''}
              <button class="px-4 py-2 rounded-lg border border-border text-secondary hover:text-white hover:border-accent transition-colors" id="close-modal-secondary">Close</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
}
