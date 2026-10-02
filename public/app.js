"use strict";

/*
 * Client-side RAG:
 *   1. Extract text per page (pdf.js) and split it into overlapping passages.
 *   2. Embed passages via /api/embed and keep the vectors in IndexedDB.
 *   3. On a question: embed it, rank the chat's passages by cosine similarity
 *      in the browser, send the best ones to /api/chat, render a cited answer.
 *
 * A chat can hold several documents. Nothing is stored on the server.
 */

const CHUNK_WORDS = 220;
const CHUNK_OVERLAP = 40;
const MAX_CHUNK_CHARS = 5000;
const EMBED_BATCH = 32;
const TOP_K = 5;
const HISTORY_TURNS = 6;
const MAX_FILE_MB = 40;

const SUGGESTIONS = [
  "Summarize this document",
  "What are the main conclusions?",
  "List the key terms and what they mean",
];

/* ---------------------------------------------------------------- storage */

const db = (() => {
  let handle;
  function open() {
    if (handle) return handle;
    handle = new Promise((resolve, reject) => {
      const req = indexedDB.open("docqa", 2);
      req.onupgradeneeded = (ev) => {
        const d = req.result;
        const tx = req.transaction;
        if (ev.oldVersion < 1) {
          d.createObjectStore("docs", { keyPath: "id" });
          d.createObjectStore("vectors", { keyPath: "id" });
        }
        if (ev.oldVersion < 2) {
          const chats = d.createObjectStore("chats", { keyPath: "id" });
          // v1 kept one conversation per document: turn each into a chat.
          if (ev.oldVersion >= 1) {
            const docs = tx.objectStore("docs");
            docs.getAll().onsuccess = (e) => {
              for (const doc of e.target.result) {
                const { messages = [], ...meta } = doc;
                const firstQ = messages.find((m) => m.role === "user");
                chats.put({
                  id: "c-" + doc.id,
                  title: firstQ ? firstQ.content.slice(0, 60) : doc.name,
                  docIds: [doc.id],
                  messages,
                  createdAt: doc.createdAt,
                  updatedAt: doc.createdAt,
                });
                docs.put(meta);
              }
            };
          }
        }
      };
      // Another tab still has the old database version open: the upgrade
      // waits until that tab closes or reloads.
      req.onblocked = () =>
        toast("Marginalia is open in another tab with an older version. Close that tab, then reload this one.", true);
      req.onsuccess = () => {
        const d = req.result;
        d.onversionchange = () => {
          d.close();
          toast("A newer version was opened in another tab. Reload this page.", true);
        };
        resolve(d);
      };
      req.onerror = () => reject(req.error);
    });
    return handle;
  }
  async function run(store, mode, fn) {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(store, mode);
      const result = fn(tx.objectStore(store));
      tx.oncomplete = () => resolve(result && "result" in result ? result.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted."));
    });
  }
  return {
    all: (store) => run(store, "readonly", (s) => s.getAll()),
    get: (store, id) => run(store, "readonly", (s) => s.get(id)),
    put: (store, value) => run(store, "readwrite", (s) => s.put(value)),
    del: (store, id) => run(store, "readwrite", (s) => s.delete(id)),
  };
})();

/* ------------------------------------------------------------------ state */

const state = {
  chats: [],            // newest first
  docs: new Map(),      // id -> { id, name, pages, chunkCount, embedModel, createdAt }
  vectors: new Map(),   // id -> chunks (cache)
  currentId: null,
  busy: false,
  indexing: null,       // { name } while a file is being indexed
};

const $ = (id) => document.getElementById(id);
const els = {
  app: $("app"),
  chatList: $("chatList"),
  newChatBtn: $("newChatBtn"),
  fileInput: $("fileInput"),
  menuBtn: $("menuBtn"),
  scrim: $("scrim"),
  chatTitle: $("chatTitle"),
  docChips: $("docChips"),
  hero: $("hero"),
  heroUploadBtn: $("heroUploadBtn"),
  dropzone: $("dropzone"),
  indexing: $("indexing"),
  thread: $("thread"),
  threadInner: $("threadInner"),
  composer: $("composer"),
  attachBtn: $("attachBtn"),
  questionInput: $("questionInput"),
  askBtn: $("askBtn"),
  dropOverlay: $("dropOverlay"),
  toast: $("toast"),
};

const currentChat = () => state.chats.find((c) => c.id === state.currentId) || null;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

/* -------------------------------------------------------------------- api */

async function postJSON(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* non-JSON error page */ }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status}).`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function embedTexts(texts) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJSON("/api/embed", { texts });
    } catch (err) {
      if (err.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}

/* ------------------------------------------------------------ extraction */

async function extractPages(file) {
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) return [{ page: null, text: await file.text() }];
  if (!window.pdfjsLib) throw new Error("The PDF reader didn't load. Check your connection and reload.");
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    let text = "";
    for (const item of content.items) text += item.str + (item.hasEOL ? "\n" : " ");
    pages.push({ page: i, text });
    setProgress((i / pdf.numPages) * 0.15, `Reading page ${i} of ${pdf.numPages}`);
  }
  return pages;
}

function chunkPages(pages) {
  const chunks = [];
  for (const { page, text } of pages) {
    const words = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
    if (words.length < 5) continue;
    for (let start = 0; start < words.length; start += CHUNK_WORDS - CHUNK_OVERLAP) {
      chunks.push({ page, text: words.slice(start, start + CHUNK_WORDS).join(" ").slice(0, MAX_CHUNK_CHARS) });
      if (start + CHUNK_WORDS >= words.length) break;
    }
  }
  return chunks;
}

/* ------------------------------------------------------------- retrieval */

function normalize(v) {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / n;
  return out;
}

function topK(query, chunks, k) {
  const scored = chunks.map((c, idx) => {
    let dot = 0;
    const v = c.vec;
    for (let i = 0; i < v.length; i++) dot += v[i] * query[i];
    return { idx, score: dot };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).map(({ idx, score }) => ({ ...chunks[idx], score }));
}

async function loadChunks(docIds) {
  const all = [];
  for (const id of docIds) {
    if (!state.vectors.has(id)) {
      const rec = await db.get("vectors", id);
      state.vectors.set(id, rec ? rec.chunks : []);
    }
    const name = state.docs.get(id)?.name || "document";
    for (const c of state.vectors.get(id)) all.push({ ...c, docId: id, docName: name });
  }
  return all;
}

/* --------------------------------------------------------------- indexing */

function setProgress(fraction, label) {
  document.querySelectorAll(".js-bar").forEach((b) => (b.style.width = `${Math.round(fraction * 100)}%`));
  if (label) document.querySelectorAll(".js-step").forEach((s) => (s.textContent = label));
}

async function ensureChat() {
  let chat = currentChat();
  if (!chat) {
    chat = { id: newId(), title: null, docIds: [], messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.chats.unshift(chat);
    state.currentId = chat.id;
    await db.put("chats", chat);
  }
  return chat;
}

async function addDocument(file) {
  if (state.busy) return;
  if (file.size > MAX_FILE_MB * 1024 * 1024) return toast(`That file is over ${MAX_FILE_MB} MB.`, true);

  const chat = await ensureChat();
  state.busy = true;
  state.indexing = { name: file.name };
  closeNav();
  render();
  setProgress(0, "Reading file…");

  try {
    const pages = await extractPages(file);
    const chunks = chunkPages(pages);
    if (!chunks.length) throw new Error("No selectable text found. Scanned PDFs need OCR before they can be indexed.");

    let model = null;
    const vectors = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      setProgress(0.15 + 0.85 * (i / chunks.length), `Mapping passages ${i + 1}–${i + batch.length} of ${chunks.length}`);
      const res = await embedTexts(batch.map((c) => c.text));
      model = res.model;
      res.embeddings.forEach((e, j) => vectors.push({ ...batch[j], vec: normalize(e) }));
    }
    setProgress(1, "Saving…");

    const doc = {
      id: newId(),
      name: file.name,
      pages: pages[0].page === null ? null : pages.length,
      chunkCount: vectors.length,
      embedModel: model,
      createdAt: Date.now(),
    };
    await db.put("vectors", { id: doc.id, chunks: vectors });
    await db.put("docs", doc);
    state.docs.set(doc.id, doc);
    state.vectors.set(doc.id, vectors);

    chat.docIds.push(doc.id);
    chat.title = chat.title || doc.name;
    chat.updatedAt = Date.now();
    await db.put("chats", chat);
    toast(`Added ${doc.name}`);
  } catch (err) {
    toast(err.message, true);
  } finally {
    state.busy = false;
    state.indexing = null;
    render();
    els.questionInput.focus();
  }
}

/* ------------------------------------------------------------------- chat */

async function ask(question) {
  const chat = currentChat();
  question = question.trim();
  if (!chat || !chat.docIds.length || !question || state.busy) return;

  state.busy = true;
  els.askBtn.disabled = true;
  els.questionInput.value = "";
  autoGrow();

  const history = chat.messages.slice(-HISTORY_TURNS).map((m) => ({ role: m.role, content: m.content }));
  const firstQuestion = !chat.messages.some((m) => m.role === "user");
  chat.messages.push({ role: "user", content: question });
  if (firstQuestion) chat.title = question.slice(0, 60);
  renderThread();
  renderChatList();
  renderTopbar(chat);
  const pending = appendAssistant({ pending: true });

  try {
    const chunks = await loadChunks(chat.docIds);
    const q = await embedTexts([question]);
    const stale = chat.docIds.map((id) => state.docs.get(id)).find((d) => d?.embedModel && d.embedModel !== q.model);
    if (stale) {
      throw new Error(`${stale.name} was indexed with ${stale.embedModel}, but the server now uses ${q.model}. Start a new chat and upload it again.`);
    }
    const multi = chat.docIds.length > 1;
    const hits = topK(normalize(q.embeddings[0]), chunks, TOP_K);
    const { answer } = await postJSON("/api/chat", {
      question,
      excerpts: hits.map((h) => ({ text: h.text, page: h.page, doc: multi ? h.docName : undefined })),
      history,
    });

    const sources = hits.map((h, i) => ({ n: i + 1, page: h.page, doc: h.docName, text: h.text, score: h.score }));
    chat.messages.push({ role: "assistant", content: answer, sources });
    chat.updatedAt = Date.now();
    await db.put("chats", chat);
    pending.replaceWith(buildAssistant({ content: answer, sources, multi }));
  } catch (err) {
    chat.messages.pop();
    await db.put("chats", chat).catch(() => {});
    pending.replaceWith(buildAssistant({ error: err.message, retry: question }));
  } finally {
    state.busy = false;
    els.askBtn.disabled = false;
    scrollToBottom();
  }
}

/* ---------------------------------------------------------------- render */

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Small, safe formatter: paragraphs, lists, **bold**, `code`, [n] citations.
// Input is escaped first, so model output can't inject HTML.
function formatAnswer(text, sourceCount) {
  const clean = text
    .replace(/\$([^$\n]+)\$/g, "$1")
    .replace(/\\text\{([^}]*)\}/g, "$1")
    .replace(/_\{?(\d+)\}?/g, (m, d) => [...d].map((c) => "₀₁₂₃₄₅₆₇₈₉"[c]).join(""));

  const inline = (s) =>
    escapeHtml(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (m, nums) =>
        nums
          .split(/\s*,\s*/)
          .map((n) =>
            Number(n) >= 1 && Number(n) <= sourceCount
              ? `<button type="button" class="cite" data-n="${n}" aria-label="Source ${n}">${n}</button>`
              : `[${n}]`
          )
          .join("")
      );

  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const block of clean.split(/\n{2,}/)) {
    let para = [];
    const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
    for (const line of block.split("\n")) {
      const ul = line.match(/^\s*[-*•]\s+(.*)$/);
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ul || ol) {
        flush();
        const type = ul ? "ul" : "ol";
        if (list !== type) { closeList(); out.push(`<${type}>`); list = type; }
        out.push(`<li>${inline((ul || ol)[1])}</li>`);
      } else if (line.trim()) {
        closeList();
        para.push(line);
      }
    }
    flush();
    closeList();
  }
  return out.join("");
}

function citedNumbers(text) {
  const set = new Set();
  for (const m of text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) m[1].split(/\s*,\s*/).forEach((n) => set.add(Number(n)));
  return set;
}

const where = (s, multi) =>
  [multi && s.doc ? s.doc : null, s.page ? `p. ${s.page}` : null].filter(Boolean).join(" · ") || "excerpt";

function buildSources(sources, content, multi) {
  const cited = citedNumbers(content);
  const shown = cited.size ? sources.filter((s) => cited.has(s.n)) : sources;
  if (!shown.length) return null;

  const wrap = document.createElement("div");
  wrap.className = "sources";

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "sources-toggle";
  toggle.setAttribute("aria-expanded", "false");
  toggle.innerHTML = `<span class="st-label"></span><span class="st-pages"></span>
    <svg class="st-chev" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  toggle.querySelector(".st-label").textContent =
    `${shown.length} ${cited.size ? "source" : "related passage"}${shown.length === 1 ? "" : "s"}`;
  const pages = [...new Set(shown.map((s) => s.page).filter(Boolean))].sort((a, b) => a - b);
  if (pages.length && !multi) {
    toggle.querySelector(".st-pages").textContent =
      (pages.length === 1 ? "p. " : "pp. ") + pages.slice(0, 4).join(", ") + (pages.length > 4 ? "…" : "");
  }

  const list = document.createElement("div");
  list.className = "sources-list";
  list.hidden = true;
  for (const s of shown) {
    const d = document.createElement("details");
    d.className = "source";
    d.dataset.n = s.n;
    d.innerHTML = `<summary><span class="src-n">${s.n}</span><span class="src-page"></span><span class="src-snippet"></span></summary><div class="src-body"></div>`;
    d.querySelector(".src-page").textContent = where(s, multi);
    d.querySelector(".src-snippet").textContent = s.text.slice(0, 160);
    d.querySelector(".src-body").textContent = s.text;
    list.appendChild(d);
  }

  const setOpen = (open) => {
    list.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    wrap.classList.toggle("open", open);
  };
  toggle.onclick = () => setOpen(list.hidden);
  wrap.append(toggle, list);
  wrap.reveal = (n) => {
    const target = list.querySelector(`.source[data-n="${n}"]`);
    if (!target) return;
    setOpen(true);
    target.open = true;
    target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    target.classList.add("flash");
    setTimeout(() => target.classList.remove("flash"), 1400);
  };
  return wrap;
}

function buildAssistant({ content, sources, multi, error, retry, pending }) {
  const el = document.createElement("div");
  el.className = "msg-assistant" + (pending ? " pending" : "") + (error ? " error" : "");
  const answer = document.createElement("div");
  answer.className = "answer";

  if (pending) {
    answer.innerHTML = '<span class="thinking"><i></i><i></i><i></i></span><span class="thinking-label">Searching the margins…</span>';
    el.appendChild(answer);
    return el;
  }
  if (error) {
    answer.textContent = error;
    el.appendChild(answer);
    if (retry) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "retry-btn";
      b.textContent = "Try again";
      b.onclick = () => { el.previousElementSibling?.remove(); el.remove(); ask(retry); };
      el.appendChild(b);
    }
    return el;
  }

  answer.innerHTML = formatAnswer(content, sources.length);
  el.appendChild(answer);

  const footer = document.createElement("div");
  footer.className = "msg-footer";
  const srcEl = buildSources(sources, content, multi);
  if (srcEl) footer.appendChild(srcEl);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "copy-btn";
  copy.textContent = "Copy";
  copy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(content);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    } catch { toast("Couldn't copy to clipboard.", true); }
  };
  footer.appendChild(copy);
  el.appendChild(footer);

  // Hover a citation to preview it; click to open it in the source list.
  const byN = new Map(sources.map((s) => [String(s.n), s]));
  const peek = document.createElement("div");
  peek.className = "peek";
  peek.hidden = true;
  el.appendChild(peek);
  answer.addEventListener("mouseover", (e) => {
    const btn = e.target.closest(".cite");
    const s = btn && byN.get(btn.dataset.n);
    if (!s || window.matchMedia("(hover: none)").matches) return;
    peek.innerHTML = `<div class="peek-head"></div><div class="peek-body"></div>`;
    peek.querySelector(".peek-head").textContent = where(s, multi);
    peek.querySelector(".peek-body").textContent = s.text.length > 320 ? s.text.slice(0, 320) + "…" : s.text;
    const b = btn.getBoundingClientRect();
    const host = el.getBoundingClientRect();
    peek.hidden = false;
    peek.style.left = `${Math.min(Math.max(b.left - host.left - 20, 0), host.width - peek.offsetWidth)}px`;
    peek.style.top = `${b.bottom - host.top + 8}px`;
  });
  answer.addEventListener("mouseout", (e) => { if (e.target.closest(".cite")) peek.hidden = true; });
  answer.addEventListener("click", (e) => {
    const btn = e.target.closest(".cite");
    if (!btn || !srcEl) return;
    peek.hidden = true;
    srcEl.reveal(btn.dataset.n);
  });
  return el;
}

function appendAssistant(opts) {
  const el = buildAssistant(opts);
  els.threadInner.appendChild(el);
  scrollToBottom();
  return el;
}

function indexingCard(name) {
  const card = document.createElement("div");
  card.className = "index-card";
  card.innerHTML = `<div class="ic-head"><span class="ic-label">Indexing</span><span class="ic-name"></span></div>
    <div class="progress"><div class="progress-bar js-bar"></div></div>
    <div class="ic-step js-step">Reading file…</div>`;
  card.querySelector(".ic-name").textContent = name;
  return card;
}

function renderThread() {
  const chat = currentChat();
  els.threadInner.innerHTML = "";
  if (!chat) return;
  const multi = chat.docIds.length > 1;

  if (!chat.messages.length) {
    const intro = document.createElement("div");
    intro.className = "intro";
    intro.innerHTML = `<div class="eyebrow">Indexed and ready</div>
      <h2>What would you like to <em>know?</em></h2><p></p><div class="suggestions"></div>`;
    const names = chat.docIds.map((id) => state.docs.get(id)?.name).filter(Boolean);
    intro.querySelector("p").textContent =
      `Answers come only from ${names.length > 1 ? `these ${names.length} documents` : names[0]} and point back to the page they used. Use + in the message box to add another PDF.`;
    const list = intro.querySelector(".suggestions");
    for (const s of SUGGESTIONS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "suggestion";
      b.innerHTML = `<span></span><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8M7.5 3.5 11 7l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      b.querySelector("span").textContent = s;
      b.onclick = () => ask(s);
      list.appendChild(b);
    }
    els.threadInner.appendChild(intro);
  }

  for (const m of chat.messages) {
    if (m.role === "user") {
      const el = document.createElement("div");
      el.className = "msg-user";
      el.textContent = m.content;
      els.threadInner.appendChild(el);
    } else {
      els.threadInner.appendChild(buildAssistant({ ...m, multi }));
    }
  }
  if (state.indexing) els.threadInner.appendChild(indexingCard(state.indexing.name));
  scrollToBottom();
}

function relativeTime(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "now";
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return days < 30 ? `${days}d` : new Date(ts).toLocaleDateString();
}

function renderChatList() {
  els.chatList.innerHTML = "";
  for (const c of state.chats) {
    if (!c.docIds.length && !c.messages.length && c.id !== state.currentId) continue;
    const li = document.createElement("li");
    li.className = "chat-item" + (c.id === state.currentId ? " active" : "");
    li.tabIndex = 0;
    li.innerHTML = `<div class="ci-text"><div class="ci-title"></div><div class="ci-sub"></div></div>
      <span class="ci-time"></span>
      <button class="icon-btn ci-del" type="button" aria-label="Delete chat" title="Delete chat">
        <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>`;
    const names = c.docIds.map((id) => state.docs.get(id)?.name).filter(Boolean);
    li.querySelector(".ci-title").textContent = c.title || "New chat";
    li.querySelector(".ci-sub").textContent = names.length
      ? names[0] + (names.length > 1 ? ` +${names.length - 1}` : "")
      : "No document yet";
    li.querySelector(".ci-time").textContent = relativeTime(c.updatedAt || c.createdAt);
    li.onclick = () => selectChat(c.id);
    li.onkeydown = (e) => { if (e.key === "Enter") selectChat(c.id); };
    li.querySelector(".ci-del").onclick = (e) => { e.stopPropagation(); deleteChat(c.id); };
    els.chatList.appendChild(li);
  }
}

function renderTopbar(chat) {
  els.chatTitle.textContent = chat?.title || "New chat";
  els.docChips.innerHTML = "";
  for (const id of chat?.docIds || []) {
    const d = state.docs.get(id);
    if (!d) continue;
    const chip = document.createElement("span");
    chip.className = "doc-chip";
    chip.innerHTML = `<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 1.5H4a1.5 1.5 0 0 0-1.5 1.5v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.5zM9.5 1.5v4h4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg><span class="dc-name"></span><span class="dc-meta"></span>`;
    chip.querySelector(".dc-name").textContent = d.name;
    chip.querySelector(".dc-meta").textContent = d.pages ? `${d.pages} pp` : `${d.chunkCount} passages`;
    chip.title = `${d.name} — ${d.chunkCount} passages`;
    els.docChips.appendChild(chip);
  }
}

function render() {
  const chat = currentChat();
  renderChatList();
  renderTopbar(chat);

  const hasDocs = !!chat && chat.docIds.length > 0;
  els.hero.hidden = hasDocs || !!state.indexing;
  els.indexing.hidden = hasDocs || !state.indexing;
  els.thread.hidden = !hasDocs;
  els.composer.hidden = !hasDocs;
  els.attachBtn.disabled = state.busy;

  if (!hasDocs && state.indexing) {
    els.indexing.innerHTML = "";
    els.indexing.appendChild(indexingCard(state.indexing.name));
  }
  if (hasDocs) renderThread();
}

async function selectChat(id) {
  state.currentId = id;
  try { localStorage.setItem("docqa:chat", id); } catch { /* ignore */ }
  closeNav();
  render();
}

async function newChat() {
  if (state.busy) return;
  const empty = state.chats.find((c) => !c.docIds.length && !c.messages.length);
  if (empty) return selectChat(empty.id);
  state.currentId = null;
  await ensureChat();
  closeNav();
  render();
}

async function deleteChat(id) {
  const chat = state.chats.find((c) => c.id === id);
  if (!chat || state.busy) return;
  if ((chat.docIds.length || chat.messages.length) && !confirm(`Delete "${chat.title || "this chat"}" and its documents?`)) return;
  await db.del("chats", id);
  state.chats = state.chats.filter((c) => c.id !== id);
  // Remove documents no other chat uses.
  const inUse = new Set(state.chats.flatMap((c) => c.docIds));
  for (const docId of chat.docIds) {
    if (inUse.has(docId)) continue;
    await db.del("docs", docId);
    await db.del("vectors", docId);
    state.docs.delete(docId);
    state.vectors.delete(docId);
  }
  if (state.currentId === id) state.currentId = state.chats[0]?.id || null;
  render();
}

/* ------------------------------------------------------------------ misc */

function scrollToBottom() { els.thread.scrollTop = els.thread.scrollHeight; }

function autoGrow() {
  const t = els.questionInput;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 180) + "px";
}

let toastTimer;
function toast(msg, isError) {
  els.toast.textContent = msg;
  els.toast.className = "toast" + (isError ? " error" : "");
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), isError ? 6000 : 2500);
}

function openNav() { els.app.classList.add("nav-open"); }
function closeNav() { els.app.classList.remove("nav-open"); }

/* ---------------------------------------------------- background effect */

(function constellation() {
  const canvas = $("constellation");
  const label = $("constellationState");
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  let W, H, dpr, dots = [];
  const mouse = { x: -9999, y: -9999, active: false };

  function init() {
    dpr = window.devicePixelRatio || 1;
    W = canvas.width = window.innerWidth * dpr;
    H = canvas.height = window.innerHeight * dpr;
    const count = Math.max(36, Math.min(110, Math.round(window.innerWidth * window.innerHeight * 0.00008)));
    dots = Array.from({ length: count }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      vx: (Math.random() - 0.5) * 0.1 * dpr,
      vy: (Math.random() - 0.5) * 0.1 * dpr,
      r: (Math.random() * 1.2 + 0.9) * dpr,
    }));
  }

  window.addEventListener("mousemove", (e) => {
    mouse.x = e.clientX * dpr;
    mouse.y = e.clientY * dpr;
    mouse.active = true;
    if (label) label.textContent = "nearest passages highlighting";
  });
  document.addEventListener("mouseleave", () => {
    mouse.active = false;
    if (label) label.textContent = "drifting, move your cursor";
  });

  function step() {
    if (document.hidden) return requestAnimationFrame(step);
    ctx.clearRect(0, 0, W, H);
    for (const d of dots) {
      d.x += d.vx; d.y += d.vy;
      if (d.x < 0 || d.x > W) d.vx *= -1;
      if (d.y < 0 || d.y > H) d.vy *= -1;
    }
    const linkDist = 110 * dpr;
    ctx.lineWidth = dpr;
    for (let i = 0; i < dots.length; i++) {
      for (let j = i + 1; j < dots.length; j++) {
        const a = dots[i], b = dots[j];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist < linkDist) {
          ctx.strokeStyle = `rgba(163,174,200,${0.07 * (1 - dist / linkDist)})`;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
      }
    }
    let nearest = [];
    if (mouse.active) {
      nearest = dots
        .map((d, i) => ({ i, dist: Math.hypot(d.x - mouse.x, d.y - mouse.y) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 4)
        .map((o) => o.i);
    }
    dots.forEach((d, i) => {
      const near = nearest.includes(i);
      if (near) {
        ctx.strokeStyle = "rgba(217,164,65,0.45)";
        ctx.beginPath(); ctx.moveTo(mouse.x, mouse.y); ctx.lineTo(d.x, d.y); ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(d.x, d.y, near ? d.r * 2.1 : d.r, 0, Math.PI * 2);
      ctx.fillStyle = near ? "#f0c065" : "rgba(163,174,200,0.5)";
      ctx.shadowBlur = near ? 12 : 0;
      ctx.shadowColor = "rgba(240,192,101,0.8)";
      ctx.fill();
    });
    ctx.shadowBlur = 0;
    if (!reduceMotion) requestAnimationFrame(step);
  }

  let t;
  window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(init, 200); });
  init();
  step();
})();

/* ---------------------------------------------------------------- events */

const pickFile = () => { if (!state.busy) els.fileInput.click(); };
els.heroUploadBtn.onclick = pickFile;
els.dropzone.onclick = (e) => { if (e.target === els.dropzone) pickFile(); };
els.attachBtn.onclick = pickFile;
els.fileInput.onchange = () => {
  const f = els.fileInput.files[0];
  els.fileInput.value = "";
  if (f) addDocument(f);
};
els.newChatBtn.onclick = newChat;
els.menuBtn.onclick = openNav;
els.scrim.onclick = closeNav;

els.composer.onsubmit = (e) => { e.preventDefault(); ask(els.questionInput.value); };
els.questionInput.addEventListener("input", autoGrow);
els.questionInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    ask(els.questionInput.value);
  }
});

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  if (!e.dataTransfer?.types?.includes("Files")) return;
  dragDepth++;
  els.dropOverlay.hidden = false;
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) els.dropOverlay.hidden = true;
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  els.dropOverlay.hidden = true;
  const f = e.dataTransfer?.files?.[0];
  if (f) addDocument(f);
});

/* ------------------------------------------------------------------ init */

(async function init() {
  render(); // show the landing page right away, before storage loads
  try {
    const [chats, docs] = await Promise.all([db.all("chats"), db.all("docs")]);
    state.chats = chats.sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
    for (const d of docs) state.docs.set(d.id, d);
  } catch {
    toast("This browser blocked local storage, so chats won't be saved.", true);
  }
  let last = null;
  try { last = localStorage.getItem("docqa:chat"); } catch { /* ignore */ }
  state.currentId = state.chats.some((c) => c.id === last) ? last : state.chats[0]?.id || null;
  render();
})();
