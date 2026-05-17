exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const FAL_API_KEY = process.env.FAL_API_KEY;
  if (!FAL_API_KEY) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "FAL_API_KEY environment variable eksik" })
    };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch (e) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Geçersiz JSON: " + e.message })
    };
  }

  const { human_image_b64, garment_image_b64 } = body;

  if (!human_image_b64 || !garment_image_b64) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "human_image_b64 veya garment_image_b64 eksik" })
    };
  }

  try {
    // fal.ai data URI'yi direkt kabul ediyor — upload adımı gerekmez
    // human_image_b64 ve garment_image_b64 zaten data:image/... formatında geliyor

    const falBody = {
      human_image_url: human_image_b64,
      garment_image_url: garment_image_b64
    };

    // İsteği gönder (queue API)
    const submitRes = await fetch("https://queue.fal.run/fal-ai/image-apps-v2/virtual-try-on", {
      method: "POST",
      headers: {
        "Authorization": `Key ${FAL_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(falBody)
    });

    const submitText = await submitRes.text();

    if (!submitRes.ok) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "fal.ai submit hatası: " + submitText })
      };
    }

    let submitData;
    try {
      submitData = JSON.parse(submitText);
    } catch (e) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "fal.ai geçersiz yanıt: " + submitText.slice(0, 200) })
      };
    }

    const request_id = submitData.request_id;
    if (!request_id) {
      return {
        statusCode: 502,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ error: "request_id alınamadı: " + JSON.stringify(submitData) })
      };
    }

    // Poll — maks 90 saniye
    for (let i = 0; i < 45; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const statusRes = await fetch(
        `https://queue.fal.run/fal-ai/image-apps-v2/virtual-try-on/requests/${request_id}`,
        {
          headers: { "Authorization": `Key ${FAL_API_KEY}` }
        }
      );

      if (!statusRes.ok) continue;

      const statusText = await statusRes.text();
      let data;
      try { data = JSON.parse(statusText); } catch { continue; }

      // Sonuç kontrolü
      const imgUrl =
        (data.images && data.images[0] && data.images[0].url) ||
        (data.output && data.output.images && data.output.images[0] && data.output.images[0].url) ||
        (data.image && data.image.url) ||
        null;

      if (imgUrl) {
        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ result_url: imgUrl })
        };
      }

      if (data.status === "FAILED" || data.error) {
        return {
          statusCode: 502,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ error: "fal.ai üretim başarısız: " + (data.error || "bilinmeyen hata") })
        };
      }
    }

    return {
      statusCode: 504,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Zaman aşımı — lütfen tekrar dene" })
    };

  } catch (err) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "Sunucu hatası: " + err.message })
    };
  }
};

