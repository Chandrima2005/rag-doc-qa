const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBED_MODEL = "gemini-embedding-001";

// Split raw text into overlapping word chunks so each chunk keeps some
// context from the one before it (helps retrieval quality at chunk edges).
function chunkText(text, chunkSize = 300, overlap = 50) {
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    if (end === words.length) break;
    start += chunkSize - overlap;
  }
  return chunks;
}

// Get embeddings for an array of strings in one batched call to Gemini's
// batchEmbedContents endpoint.
async function embedTexts(texts, apiKey) {
  const res = await fetch(
    `${GEMINI_BASE}/models/${EMBED_MODEL}:batchEmbedContents?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: `models/${EMBED_MODEL}`,
          content: { parts: [{ text: t }] },
        })),
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Embedding request failed: ${err}`);
  }
  const data = await res.json();
  return data.embeddings.map((e) => e.values);
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// Return the top-k chunks most similar to the query embedding.
function topKChunks(queryEmbedding, chunks, k = 4) {
  return chunks
    .map((c) => ({ ...c, score: cosineSimilarity(queryEmbedding, c.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

module.exports = { chunkText, embedTexts, cosineSimilarity, topKChunks };
