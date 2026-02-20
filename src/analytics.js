const hasGtag = () => typeof window !== 'undefined' && typeof window.gtag === 'function';

export function trackEvent(name, params = {}) {
  if (!hasGtag()) return;
  window.gtag('event', name, params);
}

export function trackPageView(path = window.location.pathname) {
  if (!hasGtag()) return;
  window.gtag('event', 'page_view', {
    page_path: path,
    page_location: window.location.href,
    page_title: document.title
  });
}
