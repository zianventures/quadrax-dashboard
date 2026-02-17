// netlify/functions/quote.js
// Free + minimal + rate-limit-safe EUR/USD spot
// Primary: exchangerate.host
// Fallback: open.er-api.com
//
// IMPORTANT: This is "spot reference", not broker ticks.

let CACHE = {
  ts: 0,
  price: null,
  source: null,
  raw: null,
};

const MIN_REFRESH_MS = 5000; // 5 seconds. You can bump to 10000 if needed.

export async function handler(event) {
  try {
    const qs = event.queryStringParameters || {};
    const pair = (qs.pair || "EUR/USD").toUpperCase();

    // We only support EUR/USD for now (bare minimum).
    if (pair !== "EUR/USD") {
      return json(400, { ok: false, error: "Only pair=EUR/USD is supported in free mode." });
    }

    const now = Date.now();

    // Serve cached if too soon
    if (CACHE.price && (now - CACHE.ts) < MIN_REFRESH_MS) {
      return json(200, {
        ok: true,
        pair,
        price: CACHE.price,
        timestamp_ms: CACHE.ts,
        fetched_ms_ago: now - CACHE.ts,
        cached: true,
        source: CACHE.source,
        raw: CACHE.raw,
      });
    }

    const t0 = Date.now();
    const primary = await fetchPrimary();
    if (primary.ok) {
      CACHE = { ts: Date.now(), price: primary.price, source: primary.source, raw: primary.raw };
      return json(200, {
        ok: true,
        pair,
        price: primary.price,
        timestamp_ms: CACHE.ts,
        fetched_ms_ago: 0,
        cached: false,
        source: primary.source,
        latency_ms: Date.now() - t0,
      });
    }

    const fallback = await fetchFallback();
    if (fallback.ok) {
      CACHE = { ts: Date.now(), price: fallback.price, source: fallback.source, raw: fallback.raw };
      return json(200, {
        ok: true,
        pair,
        price: fallback.price,
        timestamp_ms: CACHE.ts,
        fetched_ms_ago: 0,
        cached: false,
        source: fallback.source,
        latency_ms: Date.now() - t0,
      });
    }

    return json(502, {
      ok: false,
      error: "All free providers failed",
      primary_error: primary.error,
      fallback_error: fallback.error,
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}

async function fetchPrimary() {
  // exchangerate.host latest?base=EUR&symbols=USD
  // Returns something like { rates: { USD: 1.08 } }
  const url = "https://api.exchangerate.host/latest?base=EUR&symbols=USD";
  try {
    const resp = await fetch(url, { headers: { "accept": "application/json" } });
    const raw = await resp.json().catch(() => null);

    const price = raw?.rates?.USD;
    const num = Number(price);

    if (!resp.ok || !Number.isFinite(num)) {
      return { ok: false, source: "exchangerate.host", error: raw || `HTTP ${resp.status}`, raw };
    }
    return { ok: true, source: "exchangerate.host", price: num, raw };
  } catch (e) {
    return { ok: false, source: "exchangerate.host", error: String(e?.message || e) };
  }
}

async function fetchFallback() {
  // open.er-api.com gives base rates for EUR
  // https://open.er-api.com/v6/latest/EUR -> rates.USD
  const url = "https://open.er-api.com/v6/latest/EUR";
  try {
    const resp = await fetch(url, { headers: { "accept": "application/json" } });
    const raw = await resp.json().catch(() => null);

    const price = raw?.rates?.USD;
    const num = Number(price);

    if (!resp.ok || raw?.result !== "success" || !Number.isFinite(num)) {
      return { ok: false, source: "open.er-api.com", error: raw || `HTTP ${resp.status}`, raw };
    }
    return { ok: true, source: "open.er-api.com", price: num, raw };
  } catch (e) {
    return { ok: false, source: "open.er-api.com", error: String(e?.message || e) };
  }
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
    body: JSON.stringify(body),
  };
}
