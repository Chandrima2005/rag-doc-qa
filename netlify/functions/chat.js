const { getStore } = require("@netlify/blobs");
const { embedTexts, topKChunks } = require("./utils");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const CHAT_MODEL = "gemini-2.5-flash";

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method not allowed" };
  }

  try {
    const { question } = JSON.parse(event.body || "{}");
    if (!question || !question.trim()) {
      return { statusCode: 400, body: JSON.stringify({ error: "Question is required." }) };
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: "GEMINI_API_KEY is not set in Netlify env vars." }) };
    }

    const store = getStore("rag-docs");
    const doc = await store.get("current-doc.json", { type: "json" });
    if (!doc || !doc.chunks || doc.chunks.length === 0) {
      return { statusCode: 400, body: JSON.stringify({ error: "No document uploaded yet." }) };
    }

    const [queryEmbedding] = await embedTexts([question], apiKey);
    const relevant = topKChunks(queryEmbedding, doc.chunks, 4);
    const context = relevant.map((c, i) => `[Excerpt ${i + 1}]\n${c.content}`).join("\n\n");

    const systemPrompt =
      "You are a helpful assistant answering questions about a specific document. " +
      "Only use the provided excerpts to answer. If the answer isn't in the excerpts, say you don't know based on the document.";

    const res = await fetch(
      `${GEMINI_BASE}/models/${CHAT_MODEL}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [
            {
              role: "user",
              parts: [{ text: `Document excerpts:\n\n${context}\n\nQuestion: ${question}` }],
            },
          ],
          generationConfig: { temperature: 0.2 },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Chat generation failed: ${err}`);
    }

    const data = await res.json();
    const answer = data.candidates[0].content.parts[0].text;

    return {
      statusCode: 200,
      body: JSON.stringify({
        answer,
        sources: relevant.map((c) => ({ excerpt: c.content.slice(0, 150) + "...", score: c.score })),
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
