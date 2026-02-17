// netlify/functions/quote.js
// QuadraX backend quote proxy (Twelve Data)
// Canonical test:
//   https://YOUR-SITE.netlify.app/.netlify/functions/quote?pair=EUR/USD

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function normalizePair(rawPair) {
  const p = String(rawPair || "EUR/USD").toUpperCase().trim();

  // If already "EUR/USD" style, keep it
  if (p.includes("/")) return p;

  // If "EURUSD" style, convert to "EUR/USD"
  if (p.length >= 6) return `${p.slice(0, 3)}/${p.slice(3, 6)}`;

  return "EUR/USD";
}

function toNum(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

exports.handler = async (event) => {
  // Preflight
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders, body: "" };
  }

  try {
    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: "Missing TWELVEDATA_API_KEY env var on Netlify",
        }),
      };
    }

    const qs = event.queryStringParameters || {};
    const pair = normalizePair(qs.pair);
    const symbol = pair; // Twelve Data FX safest as "EUR/USD"

    const url =
      `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}` +
      `&apikey=${encodeURIComponent(apiKey)}`;

    const t0 = Date.now();
    const resp = await fetch(url, { method: "GET" });
    const latencyMs = Date.now() - t0;

    const data = await resp.json().catch(() => null);

    // Twelve Data may return 200 with error payload (code/message)
    if (!resp.ok || (data && data.code)) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          provider: "twelvedata",
          pair,
          symbol,
          latency_ms: latencyMs,
          status: "error",
          raw: data || { message: "Failed to parse provider response" },
        }),
      };
    }

    // FX quotes often populate "close" more reliably than "price"
    const px =
      toNum(data.price) ??
      toNum(data.close) ??
      toNum(data.bid) ??
      toNum(data.ask);

    const open = toNum(data.open);
    const high = toNum(data.high);
    const low = toNum(data.low);
    const close = toNum(data.close);
    const change = toNum(data.change);
    const pct = toNum(data.percent_change);

    // Twelve Data timestamps are often seconds; if "datetime" is present we still keep now()
    const tsMs = data.timestamp ? Number(data.timestamp) * 1000 : Date.now();

    return {
      statusCode: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
      body: JSON.stringify({
        ok: true,
        provider: "twelvedata",
        pair,
        symbol,
        price: px,
        ohlc: { open, high, low, close },
        change,
        percent_change: pct,
        is_market_open: data.is_market_open ?? null,
        timestamp_ms: tsMs,
        latency_ms: latencyMs,
        raw: data, // keep for debugging
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        ok: false,
        error: "Unhandled exception in quote function",
        detail: String(err && err.message ? err.message : err),
      }),
    };
  }
};
