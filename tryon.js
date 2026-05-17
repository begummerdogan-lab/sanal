const https = require("https");
const http = require("http");
const { URL } = require("url");

exports.handler = async function (event) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const FAL_API_KEY = process.env.FAL_API_KEY;
  if (!FAL_API_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "FAL_API_KEY eksik" }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: "JSON parse hatası: " + e.message }) }; }

  const { human_image_url, garment_image_b64 } = body;
  if (!human_image_url || !garment_image_b64) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "human_image_url veya garment_image_b64 eksik" }) };
  }

  try {
    // 1. Garment görselini fal CDN'e yükle
    const garmentUrl = await uploadToFalCDN(garment_image_b64, FAL_API_KEY);

    // 2. Try-on isteği gönder
    const submitRes = await falFetch("POST", "https://queue.fal.run/fal-ai/image-apps-v2/virtual-try-on", FAL_API_KEY, {
      human_image_url,
      garment_image_url: garmentUrl
    });

    if (!submitRes.ok) {
      const txt = await submitRes.text();
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Submit hatası: " + txt.slice(0, 300) }) };
    }

    const submitData = await submitRes.json();
    const request_id = submitData.request_id;
    if (!request_id) return { statusCode: 502, headers, body: JSON.stringify({ error: "request_id yok: " + JSON.stringify(submitData) }) };

    // 3. Poll (maks 90 sn)
    for (let i = 0; i < 45; i++) {
      await sleep(2000);
      const pollRes = await falFetch("GET", `https://queue.fal.run/fal-ai/image-apps-v2/virtual-try-on/requests/${request_id}`, FAL_API_KEY);
      if (!pollRes.ok) continue;
      const data = await pollRes.json();

      const imgUrl =
        (data.images?.[0]?.url) ||
        (data.output?.images?.[0]?.url) ||
        null;

      if (imgUrl) return { statusCode: 200, headers, body: JSON.stringify({ result_url: imgUrl }) };
      if (data.status === "FAILED" || data.error) return { statusCode: 502, headers, body: JSON.stringify({ error: "Üretim başarısız: " + (data.error || data.status) }) };
    }

    return { statusCode: 504, headers, body: JSON.stringify({ error: "Zaman aşımı, tekrar dene" }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Sunucu hatası: " + err.message }) };
  }
};

// ── fal CDN'e base64 görsel yükle ──────────────────────────────────
async function uploadToFalCDN(dataURI, apiKey) {
  // base64 → Buffer
  const base64 = dataURI.includes(",") ? dataURI.split(",")[1] : dataURI;
  const mimeMatch = dataURI.match(/data:([^;]+);/);
  const mime = mimeMatch ? mimeMatch[1] : "image/jpeg";
  const ext = mime.split("/")[1] || "jpg";
  const buf = Buffer.from(base64, "base64");

  // fal CDN upload endpoint
  const uploadRes = await falFetchRaw(
    "POST",
    `https://api.fal.ai/storage/upload/initiate`,
    apiKey,
    JSON.stringify({ file_name: `garment.${ext}`, content_type: mime }),
    { "Content-Type": "application/json" }
  );

  if (!uploadRes.ok) {
    const txt = await uploadRes.text();
    // initiate başarısız olursa direkt data URI gönder
    console.log("initiate failed, using data URI:", txt.slice(0, 200));
    return dataURI;
  }

  const { upload_url, file_url } = await uploadRes.json();

  // S3'e PUT
  const putRes = await falFetchRaw("PUT", upload_url, null, buf, { "Content-Type": mime });
  if (!putRes.ok) {
    console.log("PUT failed, using data URI");
    return dataURI;
  }

  return file_url;
}

// ── HTTP yardımcıları ───────────────────────────────────────────────
function falFetch(method, url, apiKey, jsonBody) {
  const body = jsonBody ? JSON.stringify(jsonBody) : undefined;
  const extraHeaders = jsonBody ? { "Content-Type": "application/json" } : {};
  return falFetchRaw(method, url, apiKey, body, extraHeaders);
}

function falFetchRaw(method, urlStr, apiKey, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;

    const reqHeaders = { ...extraHeaders };
    if (apiKey) reqHeaders["Authorization"] = `Key ${apiKey}`;
    if (body && !reqHeaders["Content-Type"]) reqHeaders["Content-Type"] = "application/json";
    if (body) reqHeaders["Content-Length"] = Buffer.byteLength(body);

    const options = {
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers: reqHeaders
    };

    const req = lib.request(options, (res) => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => {
        const rawBody = Buffer.concat(chunks).toString();
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: () => Promise.resolve(rawBody),
          json: () => Promise.resolve(JSON.parse(rawBody))
        });
      });
    });

    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

