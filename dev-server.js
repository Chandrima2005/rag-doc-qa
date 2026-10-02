// Local development server: `npm run local` -> http://localhost:3000
// Serves public/ and runs the api/*.js functions the same way Vercel does.
// Reads OPENROUTER_API_KEY (and the other settings) from .env.local.
// Not used in production — Vercel ignores this file.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;

// Minimal .env.local loader (KEY=value per line, # comments allowed)
for (const name of [".env.local", ".env"]) {
  const file = path.join(ROOT, name);
  if (!fs.existsSync(file)) continue;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith("#") && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

if (!process.env.OPENROUTER_API_KEY) {
  console.warn("! OPENROUTER_API_KEY is not set. Create .env.local (see README).");
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    if (url.pathname.startsWith("/api/")) {
      const name = url.pathname.slice(5).replace(/[^a-z0-9-]/gi, "");
      const file = path.join(ROOT, "api", `${name}.js`);
      if (!name || !fs.existsSync(file)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Not found" }));
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      try {
        req.body = raw ? JSON.parse(raw) : {};
      } catch {
        req.body = {};
      }
      res.status = (code) => ((res.statusCode = code), res);
      res.json = (obj) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(obj));
      };
      const mod = await import(pathToFileURL(file).href);
      return mod.default(req, res);
    }

    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
    const file = path.join(ROOT, "public", rel);
    if (!file.startsWith(path.join(ROOT, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, () => console.log(`Running at http://localhost:${PORT}`));
