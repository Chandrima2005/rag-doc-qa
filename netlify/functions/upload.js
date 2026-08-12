const { getStore } = require("@netlify/blobs");
const { chunkText, embedTexts } = require("./utils");

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const { text, filename } = JSON.parse(event.body || "{}");
    if (!text || text.trim().length < 20) {
      return { statusCode: 400, body: JSON.stringify({ error: "No usable text found in document." }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "GEMINI_API_KEY is not set in Netlify env vars." }) };
    }

    const blobsToken = process.env.NETLIFY_BLOBS_TOKEN;
    const siteID = process.env.NETLIFY_SITE_ID || (context.site && context.site.id);
    if (!blobsToken || !siteID) {
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Blobs is not configured. Set NETLIFY_BLOBS_TOKEN and NETLIFY_SITE_ID in Netlify env vars.",
        }),
      };
    }

    const rawChunks = chunkText(text);
    const BATCH = 50;
    const chunks = [];
    for (let i = 0; i < rawChunks.length; i += BATCH) {
      const batch = rawChunks.slice(i, i + BATCH);
      const embeddings = await embedTexts(batch, apiKey);
      batch.forEach((content, j) => chunks.push({ content, embedding: embeddings[j] }));
    }

    const store = getStore({ name: "rag-docs", siteID, token: blobsToken });
    await store.setJSON("current-doc.json", {
      filename: filename || "document",
      uploadedAt: new Date().toISOString(),
      chunks,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ success: true, chunkCount: chunks.length, filename }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
