// netlify/functions/quote.js
export async function handler(event) {
  try {
    const pair = (event.queryStringParameters?.pair || "EUR/USD").toUpperCase();
    const symbol = pair.replace("/", "");

    const apiKey = process.env.TWELVEDATA_API_KEY;
    if (!apiKey) {
      return {
        statusCode: 500,
        body: JSON.stringify({ ok: false, error: "Missing TWELVEDATA_API_KEY" }),
      };
    }

    const url = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${encodeURIComponent(apiKey)}`;

    const resp = await fetch(url, { headers: { accept: "application/json" } });
    const data = await resp.json();

    if (!data || data.code || data.status === "error") {
      return {
        statusCode: 502,
        body: JSON.stringify({ ok: false, provider: "twelvedata", raw: data }),
      };
    }

    const price = Number(data.close ?? data.price ?? NaN);
    const ts = data.timestamp ? Number(data.timestamp) * 1000 : Date.now();

    if (!Number.isFinite(price)) {
      return {
        statusCode: 502,
        body: JSON.stringify({ ok: false, provider: "twelvedata", raw: data }),
      };
    }

    return {
      statusCode: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
      body: JSON.stringify({
        ok: true,
        pair,
        symbol,
        price,
        ts,
        provider: "twelvedata",
      }),
    };
  } catch (e) {
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(e) }),
    };
  }
}
