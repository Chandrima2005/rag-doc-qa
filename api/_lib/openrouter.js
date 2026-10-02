// Shared helpers for the serverless functions.
// Files in api/_lib are not exposed as endpoints on Vercel (leading underscore).

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export const EMBED_MODEL = process.env.EMBED_MODEL || "openai/text-embedding-3-small";
export const CHAT_MODEL = process.env.CHAT_MODEL || "google/gemini-3.5-flash";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function apiKey() {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new HttpError(500, "OPENROUTER_API_KEY is not set on the server.");
  return key;
}

async function openrouter(path, body) {
  const res = await fetch(`${OPENROUTER_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      // Optional attribution headers shown in OpenRouter's activity log.
      "HTTP-Referer": process.env.SITE_URL || "https://localhost",
      "X-Title": "RAG Document Q&A",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new HttpError(502, `OpenRouter returned a non-JSON response (${res.status}).`);
  }

  if (!res.ok || data.error) {
    const msg = data.error?.message || `OpenRouter request failed (${res.status}).`;
    // 401/402/429 are useful for the client to see as-is.
    const status = [401, 402, 429].includes(res.status) ? res.status : 502;
    throw new HttpError(status, msg);
  }
  return data;
}

export async function embed(texts) {
  const data = await openrouter("/embeddings", { model: EMBED_MODEL, input: texts });
  if (!Array.isArray(data.data) || data.data.length !== texts.length) {
    throw new HttpError(502, "Embedding response was incomplete.");
  }
  return data.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

export async function complete(messages, { maxTokens = 900, temperature = 0.2 } = {}) {
  const data = await openrouter("/chat/completions", {
    model: CHAT_MODEL,
    messages,
    temperature,
    max_tokens: maxTokens,
  });
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new HttpError(502, "Model returned an empty answer.");
  return { content, usage: data.usage || null };
}

// ---- Request guards -------------------------------------------------------
// The API key belongs to the server, so these endpoints are the only thing
// standing between the public internet and the key's credit balance.

// Accepts "https://site.com", "https://site.com/" or "site.com" and returns
// the lowercase host ("site.com"), so small formatting differences in the
// env var don't lock the site out.
function hostOf(value) {
  const v = String(value || "").trim().toLowerCase();
  if (!v) return "";
  try {
    return new URL(v.includes("://") ? v : `https://${v}`).host;
  } catch {
    return "";
  }
}

const ALLOWED_HOSTS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(hostOf)
  .filter(Boolean);

// Browsers always send an Origin header on POST requests. A request is allowed
// when it comes from the same site that served the page (whichever domain that
// is), or from an extra host listed in ALLOWED_ORIGINS. Pages on other
// websites can't call the API.
function originAllowed(req) {
  const origin = hostOf(req.headers.origin);
  if (!origin) return false;
  const self = hostOf(req.headers["x-forwarded-host"] || req.headers.host);
  return origin === self || ALLOWED_HOSTS.includes(origin);
}

// Best-effort, per-instance rate limit. Serverless instances are short-lived,
// so this stops bursts from a single client, not a determined attacker.
const hits = new Map();
const WINDOW_MS = 60_000;

function rateLimited(req, limit) {
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > limit;
}

export function handler(fn, { perMinute = 30 } = {}) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      if (req.method !== "POST") throw new HttpError(405, "Method not allowed.");
      if (!originAllowed(req)) throw new HttpError(403, "Origin not allowed.");
      if (rateLimited(req, perMinute)) throw new HttpError(429, "Too many requests. Wait a minute and try again.");
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {};
      const result = await fn(body);
      res.status(200).json(result);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(err);
      res.status(status).json({ error: err.message || "Unexpected error." });
    }
  };
}