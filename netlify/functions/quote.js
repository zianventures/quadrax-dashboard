// netlify/functions/quote.js
// QuadraX backend quote proxy (Twelve Data)
// Usage:
//   /.netlify/functions/quote?pair=EUR/USD
//   /.netlify/functions/quote?pair=EURUSD

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function normalizePair(rawPair) {
  const p = String(rawPair || "EUR/USD").toUpperCase().trim();

  // If already "EUR/USD" style, keep it
  if (p.includes("/")) return p;

  // If "EURUSD" style, convert to "EUR/USD" if length >= 6
  if (p.length >= 6) return `${p.slice(0, 3)}/${p.slice(3, 6)}`;

  // Fallback
  return "EUR/USD";
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

    // Twelve Data sometimes returns 200 with an "code"/"message" error payload
    if (!resp.ok || (data && data.code)) {
      return {
        statusCode: 502,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          provider: "twelvedata",
          symbol,
          pair,
          latency_ms: latencyMs,
          status: "error",
          raw: data || { message: "Failed to parse provider response" },
        }),
      };
    }

    // Typical fields: symbol, name, timestamp, open, high, low, close, price, volume, etc.
    // We'll return a normalized payload that your frontend can rely on.
    const price = data.price != null ? Number(data.price) : null;
    const ts =
      data.timestamp != null
        ? Number(data.timestamp) * 1000 // Twelve Data timestamp is in seconds (usually)
        : Date.now();

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
        price,
        timestamp_ms: ts,
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
