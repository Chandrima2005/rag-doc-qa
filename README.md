# RAG Document Q&A

Upload a PDF, ask questions about it, get answers grounded in the document — a full Retrieval-Augmented Generation pipeline deployed entirely on Netlify, powered by Google's free-tier Gemini API.

## How it works
1. **Client-side PDF parsing** — `pdf.js` extracts text from the uploaded PDF in the browser (no server-side file handling needed).
2. **`/api/upload`** — chunks the text, embeds each chunk with Gemini's `text-embedding-004`, and stores the chunks + embeddings in **Netlify Blobs** (a built-in key-value store — no external vector DB required).
3. **`/api/chat`** — embeds the user's question, computes cosine similarity against stored chunks, pulls the top 4 most relevant excerpts, and passes them as context to `gemini-2.0-flash` to generate a grounded answer.

## Tech stack
- Frontend: plain HTML/CSS/JS + pdf.js (via CDN)
- Backend: Netlify Functions (serverless)
- Vector store: Netlify Blobs
- LLM: Google Gemini (embeddings + generation) — free tier, no card required

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Get a free Gemini API key from **Google AI Studio**: https://aistudio.google.com/apikey
   (No credit card required for the free tier — it comes with generous daily rate limits, plenty for a portfolio demo.)

3. Install the Netlify CLI (if you don't have it):
   ```
   npm install -g netlify-cli
   ```

4. Run locally:
   ```
   netlify dev
   ```
   Create a `.env` file in the project root:
   ```
   GEMINI_API_KEY=your-key-here
   ```

5. Deploy:
   ```
   netlify deploy --prod
   ```
   Then set `GEMINI_API_KEY` in **Site settings → Environment variables** on Netlify's dashboard.

## Free tier notes
Gemini's free tier (as of writing) covers both `text-embedding-004` and `gemini-2.0-flash` with per-minute and per-day request limits that are more than enough for demoing this project to recruiters or interviewers. Rate limits can change — check current limits at https://ai.google.dev/gemini-api/docs/rate-limits before relying on it for anything beyond a demo.

## Notes for your portfolio / resume
- This is a **single-document demo** (each new upload replaces the previous one in the blob store) — call this out if asked, and mention how you'd extend it to multi-document support (e.g., keyed by document ID, a document picker UI).
- Model names are constants in `netlify/functions/utils.js` and `chat.js` if you want to swap them later.
- To extend: add conversation memory (pass prior Q&A turns into the prompt), support multiple file formats (docx, txt), or add a real vector DB (Pinecone/Supabase pgvector) if you want to demonstrate that instead of Netlify Blobs.
