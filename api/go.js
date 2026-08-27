// Vercel Edge Function: Smart Affiliate Country Router
// Runtime: Vercel Edge Network (<10ms global latency, $0 cost)

export const config = {
  runtime: 'edge',
};

export default function handler(request) {
  const url = new URL(request.url);

  // 1. Detect visitor country from query param (override) or Vercel Edge geo-header
  const country = (
    url.searchParams.get('country') ||
    request.headers.get('x-vercel-ip-country') ||
    'US'
  ).toUpperCase();

  // 2. Extract query parameters
  const asin = url.searchParams.get('asin') || '';
  const asin_in = url.searchParams.get('asin_in') || '';
  const q = url.searchParams.get('q') || '';
  const subid = url.searchParams.get('subid') || url.searchParams.get('ascsubtag') || 'sp_direct';

  // 3. Associate tags (Environment variables or fallback defaults)
  const US_TAG = process.env.AMAZON_ASSOCIATE_TAG_US || 'smartpickr-20';
  const IN_TAG = process.env.AMAZON_ASSOCIATE_TAG_IN || 'smartpickr-21';

  let destination = '';

  // 4. Country Routing Engine
  if (country === 'IN') {
    // ── INDIA ROUTING (Method 1: Style Query Fallback) ──
    if (asin_in) {
      // Priority 1: Direct Indian ASIN match
      destination = `https://www.amazon.in/dp/${asin_in}?tag=${IN_TAG}&ascsubtag=${encodeURIComponent(subid)}&linkCode=ogi`;
    } else if (q) {
      // Priority 2: High-converting style search query (Method 1)
      destination = `https://www.amazon.in/s?k=${encodeURIComponent(q)}&tag=${IN_TAG}&ascsubtag=${encodeURIComponent(subid)}`;
    } else if (asin) {
      // Priority 3: Fallback search by US ASIN / keyword
      destination = `https://www.amazon.in/s?k=${encodeURIComponent(asin)}&tag=${IN_TAG}&ascsubtag=${encodeURIComponent(subid)}`;
    } else {
      destination = `https://www.amazon.in/?tag=${IN_TAG}`;
    }
  } else {
    // ── US / CANADA / UK / GLOBAL ROUTING ──
    if (asin) {
      destination = `https://www.amazon.com/dp/${asin}?tag=${US_TAG}&ascsubtag=${encodeURIComponent(subid)}&linkCode=ogi`;
    } else if (q) {
      destination = `https://www.amazon.com/s?k=${encodeURIComponent(q)}&tag=${US_TAG}&ascsubtag=${encodeURIComponent(subid)}`;
    } else {
      destination = `https://www.amazon.com/?tag=${US_TAG}`;
    }
  }

  // 5. Return clean 302 Found Redirect with no-cache headers
  return new Response(null, {
    status: 302,
    headers: {
      'Location': destination,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-SmartPickr-Routed-Country': country,
    },
  });
}
