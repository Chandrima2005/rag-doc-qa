# RAG Document Q&A

Upload a PDF and ask questions about it. Answers come only from the document and cite the passages and page numbers they used.

## How it works

1. **Extract.** `pdf.js` reads the PDF in the browser, page by page.
2. **Chunk.** Each page is split into ~220-word passages with a 40-word overlap. Every passage keeps its page number.
3. **Embed.** Passages go to `/api/embed` in batches of 32. The function calls OpenRouter's embeddings endpoint (`openai/text-embedding-3-small` by default).
4. **Store.** Vectors are normalized and saved in the browser's IndexedDB, grouped into chats. A chat can hold several documents (add more with **+** in the message box). Nothing is stored on the server.
5. **Retrieve.** A question is embedded the same way and ranked against every passage in the chat's documents by cosine similarity, in the browser. The top 5 are kept.
6. **Answer.** `/api/chat` sends those passages (plus the last few turns, for follow-up questions) to a chat model on OpenRouter. The model has to cite passages as `[n]`, and the UI turns those into links to the source text.

```
browser                                   Vercel functions        OpenRouter
───────                                   ────────────────        ──────────
PDF → pages → passages ──── texts ──────▶ /api/embed ───────────▶ embeddings
IndexedDB ◀──────────────── vectors ─────
question ───────────────── text ────────▶ /api/embed ───────────▶ embeddings
top-k by cosine (in browser)
top passages + question ─────────────────▶ /api/chat ───────────▶ chat model
cited answer ◀───────────────────────────
```

## Tech stack

- Frontend: plain HTML, CSS and JavaScript, plus pdf.js. No build step.
- Backend: two Vercel serverless functions (Node 20+), with no dependencies.
- Models: [OpenRouter](https://openrouter.ai). You can swap models with environment variables.
- Vector store: IndexedDB in the browser.

## Project structure

```
api/
  _lib/openrouter.js   OpenRouter client, request guards (not an endpoint)
  embed.js             POST /api/embed
  chat.js              POST /api/chat
public/
  index.html
  styles.css
  app.js               extraction, chunking, retrieval, UI
vercel.json
```

## Environment variables

| Name | Required | Default | Notes |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | | Server-side only, never sent to the browser |
| `CHAT_MODEL` | no | `google/gemini-3.5-flash` | Any OpenRouter chat model ID |
| `EMBED_MODEL` | no | `openai/text-embedding-3-small` | Any OpenRouter embeddings model ID. If you change it, documents indexed earlier need to be added again. |
| `ALLOWED_ORIGINS` | recommended | (allow all) | Comma-separated, e.g. `https://yourdomain.com,https://www.yourdomain.com` |
| `SITE_URL` | no | | Sent to OpenRouter as `HTTP-Referer` |

## Run locally

Requires Node.js 20+.

```bash
cp .env.example .env.local     # Windows: copy .env.example .env.local
# open .env.local and paste your key after OPENROUTER_API_KEY=
npm run local
```

Open http://localhost:3000. `.env.local` is git-ignored, so your key is never committed.

(If you use the Vercel CLI, `vercel dev` works too.)

## Deploy

1. Import the GitHub repo at [vercel.com/new](https://vercel.com/new). Framework preset: **Other**. No build command.
2. Add the environment variables above under **Settings → Environment Variables**, then redeploy.
3. To use a custom domain, go to **Settings → Domains**, add your domain, and create the DNS records Vercel shows at your registrar.

## Cost and abuse protection

The API key lives only on the server. The endpoints have these guards:

- input size limits (64 texts per embed call, 1,000-character questions, 8 excerpts per chat call)
- `max_tokens` capped at 900 per answer
- a per-IP rate limit for each server instance
- an optional origin allow-list (`ALLOWED_ORIGINS`)

A typical 50-page PDF costs a fraction of a cent to index with `text-embedding-3-small`. Each question costs well under a cent with the default chat model.

## Limitations and next steps

- Scanned PDFs without a text layer can't be read. Adding OCR (e.g. Tesseract.js) would fix that.
- Retrieval is plain cosine similarity. Hybrid search (BM25 + vectors) or a reranker would help on keyword-heavy questions.
- Libraries are stored per browser. Syncing them across devices would need accounts and a server-side vector store (e.g. Postgres + pgvector).
