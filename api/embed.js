import { embed, handler, HttpError, EMBED_MODEL } from "./_lib/openrouter.js";

const MAX_TEXTS = 64;
const MAX_CHARS = 6000;

// POST /api/embed  { texts: string[] }  ->  { model, embeddings: number[][] }
export default handler(
  async ({ texts }) => {
    if (!Array.isArray(texts) || texts.length === 0) {
      throw new HttpError(400, "Expected a non-empty `texts` array.");
    }
    if (texts.length > MAX_TEXTS) {
      throw new HttpError(400, `Send at most ${MAX_TEXTS} texts per request.`);
    }
    if (texts.some((t) => typeof t !== "string" || !t.trim() || t.length > MAX_CHARS)) {
      throw new HttpError(400, `Each text must be a non-empty string under ${MAX_CHARS} characters.`);
    }
    const embeddings = await embed(texts);
    return { model: EMBED_MODEL, embeddings };
  },
  { perMinute: 60 }
);
