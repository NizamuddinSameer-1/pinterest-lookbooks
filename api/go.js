// Vercel Edge Function: Smart Affiliate Country Router
// Runtime: Vercel Edge Network (<10ms global latency, $0 cost)
// Automatically matches Amazon official SiteStripe format:
//   US: https://www.amazon.com/dp/{asin}?tag=nizamuddinsam-20&linkCode=ll2&ref_=as_li_ss_tl&language=en_US&ascsubtag={subid}
//   IN: https://www.amazon.in/dp/{asin}?tag=nizamuddins0a-21&linkCode=ll2&ref_=as_li_ss_tl&ascsubtag={subid}
//
// ─────────────────────────────────────────────────────────────────────────────
// SECURITY FIX — audit 04, finding D7 (affiliate-tag injection / commission theft)
//
// The `/dp/` branches used to build the destination by RAW string interpolation,
// i.e. the ASIN value was spliced straight into the path template:
//     "https://www.amazon.com/dp/" + asin + "?tag=" + US_TAG + "&..."
// The `s?k=` branches already called encodeURIComponent; the `/dp/` ones did not.
// That asymmetry was the bug, and it was verified live against production:
//
//   GET /api/go?country=US&asin=B0C1234567%3Ftag%3Devil-20
//     → 302 https://www.amazon.com/dp/B0C1234567?tag=evil-20?tag=nizamuddinsam-20&...
//   GET /api/go?country=IN&asin_in=B0C1234567%26tag=evil-20
//     → 302 https://www.amazon.in/dp/B0C1234567&tag=evil-20?tag=nizamuddins0a-21&...
//
// The injected `tag` became the FIRST `tag=` parameter and the real associate tag
// became the second. Amazon honours the first occurrence, so the commission was
// redirected to an attacker-chosen tag — a live revenue vulnerability. A raw `&`
// instead corrupts the path (`/dp/B0C1234567&tag=evil-20`).
//
// Defence in depth, in order of importance:
//   1. PRIMARY — shape validation. An ASIN is only ever placed in a `/dp/` path
//      after matching ^[A-Z0-9]{10}$. Anything else cannot reach the path at all;
//      it falls through to the search branch or the bare storefront. Validation
//      is primary because it removes the injection primitive entirely rather than
//      trying to escape it.
//   2. SECONDARY — percent-encoding. Every value that reaches the URL is encoded
//      with encodeURIComponent, including values that were already encoded. This
//      is what makes a future, unvalidated value harmless rather than exploitable.
//   Do not "simplify" this back to raw interpolation — the finding above is live.
// ─────────────────────────────────────────────────────────────────────────────

export const config = {
  runtime: 'edge',
};

// ASINs are exactly 10 uppercase letters/digits. Anything else is not an ASIN and
// must never be interpolated into a /dp/ path.
const ASIN_RE = /^[A-Z0-9]{10}$/;

// The only countries this router has branches for. Anything else (including the
// raw Vercel geo-header) falls back to the default rather than being echoed.
const ALLOWED_COUNTRIES = ['US', 'IN'];
const DEFAULT_COUNTRY = 'US';

// Amazon caps ascsubtag at 128 characters.
const MAX_SUBID_LENGTH = 128;

// Returns the ASIN only if it has the real shape, otherwise ''.
function validAsin(raw) {
  const candidate = (raw || '').trim().toUpperCase();
  return ASIN_RE.test(candidate) ? candidate : '';
}

// Single encoding helper so every value that reaches the URL is treated the same.
function enc(value) {
  return encodeURIComponent(String(value ?? ''));
}

export default function handler(request) {
  const url = new URL(request.url);

  // 1. Detect visitor country from query param (override) or Vercel Edge geo-header.
  //    Validated against the branches this router actually supports; unknown values
  //    (or a header carrying CRLF) fall back to the default instead of being echoed.
  const requestedCountry = (
    url.searchParams.get('country') ||
    request.headers.get('x-vercel-ip-country') ||
    ''
  ).toUpperCase();
  const country = ALLOWED_COUNTRIES.includes(requestedCountry)
    ? requestedCountry
    : DEFAULT_COUNTRY;

  // 2. Extract query parameters
  const asin = url.searchParams.get('asin') || '';
  const asin_in = url.searchParams.get('asin_in') || '';
  const q = url.searchParams.get('q') || '';
  const rawSubid = url.searchParams.get('subid') || url.searchParams.get('ascsubtag') || 'sp_direct';
  const subid = String(rawSubid).slice(0, MAX_SUBID_LENGTH);

  // 3. Associate tags (Environment variables or fallback defaults)
  const US_TAG = process.env.AMAZON_ASSOCIATE_TAG_US || 'nizamuddinsam-20';
  const IN_TAG = process.env.AMAZON_ASSOCIATE_TAG_IN || 'nizamuddins0a-21';

  let destination = '';

  // 4. Country Routing Engine with Amazon SiteStripe compliance
  if (country === 'IN') {
    // ── INDIA ROUTING (Method 1: Direct ASIN or Style Query Fallback) ──
    const safe_asin_in = validAsin(asin_in);
    const safe_asin = validAsin(asin);
    if (safe_asin_in) {
      destination = `https://www.amazon.in/dp/${enc(safe_asin_in)}?tag=${enc(IN_TAG)}&linkCode=ll2&ref_=as_li_ss_tl&ascsubtag=${enc(subid)}`;
    } else if (q) {
      destination = `https://www.amazon.in/s?k=${enc(q)}&tag=${enc(IN_TAG)}&linkCode=ll2&ref_=as_li_ss_tl&ascsubtag=${enc(subid)}`;
    } else if (safe_asin) {
      destination = `https://www.amazon.in/s?k=${enc(safe_asin)}&tag=${enc(IN_TAG)}&linkCode=ll2&ref_=as_li_ss_tl&ascsubtag=${enc(subid)}`;
    } else {
      destination = `https://www.amazon.in/?tag=${enc(IN_TAG)}&linkCode=ll2&ref_=as_li_ss_tl`;
    }
  } else {
    // ── US / CANADA / UK / GLOBAL ROUTING ──
    const safe_asin = validAsin(asin);
    if (safe_asin) {
      destination = `https://www.amazon.com/dp/${enc(safe_asin)}?tag=${enc(US_TAG)}&linkCode=ll2&ref_=as_li_ss_tl&language=en_US&ascsubtag=${enc(subid)}`;
    } else if (q) {
      destination = `https://www.amazon.com/s?k=${enc(q)}&tag=${enc(US_TAG)}&linkCode=ll2&ref_=as_li_ss_tl&language=en_US&ascsubtag=${enc(subid)}`;
    } else {
      destination = `https://www.amazon.com/?tag=${enc(US_TAG)}&linkCode=ll2&ref_=as_li_ss_tl&language=en_US`;
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
