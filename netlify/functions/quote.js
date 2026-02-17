// netlify/functions/quote.js

export async function handler(event) {
  try {
    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) {
      return json(500, { ok: false, error: "Missing TWELVEDATA_API_KEY env var" });
    }

    const qs = event.queryStringParameters || {};
    const pair = (qs.pair || qs.symbol || "EUR/USD").toUpperCase();

    // Twelve Data expects symbol like "EUR/USD" for forex
    const symbol = pair.includes("/") ? pair : "EUR/USD";

    const t0 = Date.now();
    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url);
    const raw = await resp.json();

    if (!resp.ok || raw.status === "error") {
      return json(502, {
        ok: false,
        provider: "twelvedata",
        symbol,
        raw,
        status: "error"
      });
    }

    const price = safeNumber(raw.price);
    const tsMs = Date.now();
    const latencyMs = Date.now() - t0;

    return json(200, {
      ok: true,
      provider: "twelvedata",
      pair: symbol,
      symbol,
      price,
      timestamp_ms: tsMs,
      latency_ms: latencyMs,
      raw
    });
  } catch (e) {
    return json(500, { ok: false, error: String(e?.message || e) });
  }
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,OPTIONS",
      "access-control-allow-headers": "content-type"
    },
    body: JSON.stringify(body)
  };
}
