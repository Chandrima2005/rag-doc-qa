# Marginalia

**Ask the document, not the internet.**

Marginalia lets you upload a PDF and ask questions about it. Every answer is drawn only from the document and cites the exact passages and page numbers it used, so you can check each claim against the source.

**Live demo:** https://yourdomain.com

---

## Features

- **Answers grounded in your document.** The model only sees the passages retrieved from your PDF and is instructed not to use outside knowledge.
- **Page-level citations.** Every claim is marked `[1]`, `[2]`, … Hover a citation to preview the passage, or click it to open the full source.
- **Multiple documents per chat.** Add more PDFs to the same conversation with the **+** button; answers can draw on all of them.
- **Follow-up questions.** Recent turns are passed along, so you can ask "what about the second point?"
- **Private by design.** Documents, embeddings and chat history stay in your browser (IndexedDB). Nothing is stored on the server.
- **Chat history.** Past conversations are listed in the sidebar and survive a page reload.

## How it works

Marginalia is a retrieval-augmented generation (RAG) pipeline where the retrieval half runs in the browser.

1. **Extract.** `pdf.js` reads the PDF client-side, page by page.
2. **Chunk.** Each page is split into ~220-word passages with a 40-word overlap. Every passage keeps its page number.
3. **Embed.** Passages are sent in batches to a serverless function that calls an embeddings model (`openai/text-embedding-3-small` via OpenRouter).
4. **Store.** The vectors are normalized and saved in IndexedDB, grouped by chat.
5. **Retrieve.** A question is embedded the same way and compared against every passage in the chat by cosine similarity, in the browser. The top 5 passages are selected.
6. **Answer.** The selected passages, the question and recent turns go to a chat model (Gemini 3.5 Flash via OpenRouter), which must cite passages by number. The UI turns those numbers into links to the source text.

```
browser                                   serverless functions    OpenRouter
───────                                   ────────────────────    ──────────
PDF → pages → passages ──── texts ──────▶ /api/embed ───────────▶ embeddings
IndexedDB ◀──────────────── vectors ─────
question ───────────────── text ────────▶ /api/embed ───────────▶ embeddings
top-k by cosine (in browser)
top passages + question ─────────────────▶ /api/chat ───────────▶ chat model
cited answer ◀───────────────────────────
```

### Why retrieval runs in the browser

- **Privacy:** the server never keeps a copy of anyone's document.
- **No database to run:** each visitor's index lives in their own browser.
- **Isolation:** users can't see or overwrite each other's documents.

## Tech stack

| Layer | Choice |
|---|---|
| Frontend | HTML, CSS, vanilla JavaScript (no framework, no build step) |
| PDF parsing | pdf.js |
| Vector store | IndexedDB in the browser |
| Backend | Two Node.js serverless functions on Vercel |
| Models | OpenRouter: `openai/text-embedding-3-small`, `google/gemini-3.5-flash` |

## Security

The API key lives only in server environment variables and is never sent to the browser. The API endpoints also have:

- input size limits on every request
- a cap on answer length
- per-IP rate limiting
- an optional allow-list of origins, so only this site can call the API
- HTML escaping of model output before it's rendered

## Project structure

```
api/
  _lib/openrouter.js   OpenRouter client and request guards
  embed.js             POST /api/embed  – embeds passages and questions
  chat.js              POST /api/chat   – generates the cited answer
public/
  index.html
  styles.css
  app.js               extraction, chunking, retrieval, chat UI
dev-server.js          local development server
```

## Running locally

Requires Node.js 20+ and an [OpenRouter](https://openrouter.ai) API key.

```bash
git clone https://github.com/Chandrima2005/rag-doc-qa.git
cd rag-doc-qa
cp .env.example .env.local        # Windows: copy .env.example .env.local
# add your key: OPENROUTER_API_KEY=...
npm run local
```

Then open http://localhost:3000.

## Limitations and future work

- **Scanned PDFs** without a text layer can't be read yet. OCR (e.g. Tesseract.js) would add support.
- **Retrieval** is pure vector similarity. Hybrid search (BM25 + vectors) or a reranker would improve keyword-heavy questions.
- **Per-browser storage** means chats don't sync across devices. That would need accounts and a server-side vector store, which conflicts with the privacy goal.
