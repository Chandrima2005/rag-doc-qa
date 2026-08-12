const { getStore } = require("@netlify/blobs");
const { chunkText, embedTexts } = require("./utils");

exports.handler = async (event) => {
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

    const rawChunks = chunkText(text);
    // Gemini's batchEmbedContents accepts many requests per call; keep batches modest to be safe.
    const BATCH = 50;
    const chunks = [];
    for (let i = 0; i < rawChunks.length; i += BATCH) {
      const batch = rawChunks.slice(i, i + BATCH);
      const embeddings = await embedTexts(batch, apiKey);
      batch.forEach((content, j) => chunks.push({ content, embedding: embeddings[j] }));
    }

    const store = getStore("rag-docs");
    // Single-document demo store: each new upload replaces the previous doc.
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
