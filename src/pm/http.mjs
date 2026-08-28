// Polite fetching.
//
// The data API answers a burst of requests with 429, and sometimes 400, which
// is easy to mistake for a malformed request. Paginating two sides of a trade
// log across dozens of markets is exactly such a burst, so requests are spaced
// and retried rather than fired as fast as the loop can manage.

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Statuses worth trying again: rate limits and anything the server blames on itself. */
const RETRYABLE = new Set([400, 408, 425, 429, 500, 502, 503, 504]);

/**
 * @param {string} url
 * @param {object} [options]
 * @param {number} [options.retries]
 * @param {number} [options.backoffMs]  first wait, doubled each attempt
 * @param {typeof fetch} [options.fetchImpl]
 * @returns {Promise<Response>}
 */
export async function politeFetch(url, {
  retries = 4, backoffMs = 500, maxBackoffMs = 60000, fetchImpl = fetch,
} = {}) {
  let last = null;
  let thrown = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url);
      if (response.ok || !RETRYABLE.has(response.status)) return response;
      last = response;
      thrown = null;
    } catch (err) {
      // A lost network does not answer with a status: fetch rejects outright
      // with "fetch failed". Retrying only on status codes meant a laptop
      // going to sleep took the collector down with it.
      last = null;
      thrown = err;
    }
    if (attempt < retries) {
      await delay(Math.min(maxBackoffMs, backoffMs * 2 ** attempt));
    }
  }
  if (thrown) throw thrown;
  return last;
}

/** Keeps a sequence of requests spaced by at least `everyMs`. */
export function throttle(everyMs) {
  let next = 0;
  return async () => {
    const wait = next - Date.now();
    if (wait > 0) await delay(wait);
    next = Date.now() + everyMs;
  };
}
