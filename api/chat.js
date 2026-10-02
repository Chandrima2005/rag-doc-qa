import { complete, handler, HttpError, CHAT_MODEL } from "./_lib/openrouter.js";

const MAX_QUESTION = 1000;
const MAX_EXCERPTS = 8;
const MAX_EXCERPT_CHARS = 4000;
const MAX_HISTORY = 6;

const SYSTEM_PROMPT = `You answer questions about one or more documents using only the numbered excerpts provided.

Rules:
- Base every claim on the excerpts. Cite them inline with their number in square brackets, e.g. [2] or [1][3].
- If the excerpts don't contain the answer, say so plainly. Don't guess or use outside knowledge.
- Be concise. Use short paragraphs; use a bulleted list only when listing several items.
- Plain text only: no LaTeX, no tables, no headings. **Bold** is fine for key terms.
- For chemical formulas or subscripts use Unicode characters (e.g. C₂H₂F₄).`;

// POST /api/chat
// { question: string, excerpts: {text, page, doc?}[], history?: {role, content}[] }
// -> { answer, model }
export default handler(
  async ({ question, excerpts, history }) => {
    if (typeof question !== "string" || !question.trim()) {
      throw new HttpError(400, "Question is required.");
    }
    if (question.length > MAX_QUESTION) {
      throw new HttpError(400, `Keep questions under ${MAX_QUESTION} characters.`);
    }
    if (!Array.isArray(excerpts) || excerpts.length === 0) {
      throw new HttpError(400, "No document excerpts were sent.");
    }

    const context = excerpts
      .slice(0, MAX_EXCERPTS)
      .map((e, i) => {
        const text = String(e?.text || "").slice(0, MAX_EXCERPT_CHARS);
        const where = [
          typeof e?.doc === "string" && e.doc ? e.doc.slice(0, 120) : null,
          Number.isFinite(e?.page) ? `page ${e.page}` : null,
        ].filter(Boolean).join(", ");
        return `[${i + 1}]${where ? ` (${where})` : ""}\n${text}`;
      })
      .join("\n\n");

    const prior = (Array.isArray(history) ? history : [])
      .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m.content === "string")
      .slice(-MAX_HISTORY)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));

    const { content } = await complete([
      { role: "system", content: SYSTEM_PROMPT },
      ...prior,
      { role: "user", content: `Excerpts:\n\n${context}\n\nQuestion: ${question.trim()}` },
    ]);

    return { answer: content.trim(), model: CHAT_MODEL };
  },
  { perMinute: 20 }
);
