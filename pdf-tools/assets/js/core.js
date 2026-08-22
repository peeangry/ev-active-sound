/* ============================================================
   PDF Toolbox - core runtime
   Everything runs in the browser: no uploads, no server.
   Provides: icon set, lazy library loader, settings, recent-file
   storage (IndexedDB), a small UI kit and the hash router.
   ============================================================ */
(function () {
  "use strict";

  const PT = (window.PT = window.PT || {});

  /* ---------- base path (so vendor/ resolves wherever the app is hosted) ---------- */
  const scriptSrc = (document.currentScript && document.currentScript.src) || "";
  PT.base = scriptSrc ? scriptSrc.replace(/assets\/js\/core\.js.*$/, "") : "./";

  /* ---------- tiny helpers ---------- */
  const el = (PT.el = function (tag, attrs, children) {
    const n = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") n.className = v;
        else if (k === "html") n.innerHTML = v;
        else if (k === "text") n.textContent = v;
        else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
        else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
        else n.setAttribute(k, v === true ? "" : v);
      }
    }
    (Array.isArray(children) ? children : children ? [children] : []).forEach((c) => {
      if (c === null || c === undefined || c === false) return;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    });
    return n;
  });

  PT.fmtBytes = function (b) {
    if (!isFinite(b)) return "-";
    if (b < 1024) return b + " B";
    if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + " KB";
    return (b / 1048576).toFixed(b < 10485760 ? 2 : 1) + " MB";
  };
  PT.fmtTime = function (s) {
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s / 60);
    return m + ":" + String(s % 60).padStart(2, "0");
  };
  PT.fmtDate = function (ts) {
    const d = new Date(ts);
    const now = Date.now();
    const day = 86400000;
    const t = d.toLocaleTimeString("th-TH", { hour: "2-digit", minute: "2-digit" });
    if (now - ts < day && new Date().getDate() === d.getDate()) return "วันนี้ " + t;
    if (now - ts < 2 * day) return "เมื่อวาน " + t;
    return d.toLocaleDateString("th-TH", { day: "numeric", month: "short" }) + " " + t;
  };
  PT.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  PT.nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
  PT.baseName = function (name) { return String(name || "file").replace(/\.[^.]+$/, ""); };
  PT.safeName = function (name) { return String(name).replace(/[\\/:*?"<>|]+/g, "_").slice(0, 90); };

  /* ---------- icons (24x24 stroke) ---------- */
  const P = (d, extra) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + d + (extra || "") + "</svg>";
  PT.icons = {
    home: P('<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.5"/><path d="M9.5 21v-6h5v6"/>'),
    grid: P('<rect x="3" y="3" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="2"/>'),
    scan: P('<path d="M3 8V5.5A2.5 2.5 0 0 1 5.5 3H8"/><path d="M16 3h2.5A2.5 2.5 0 0 1 21 5.5V8"/><path d="M21 16v2.5a2.5 2.5 0 0 1-2.5 2.5H16"/><path d="M8 21H5.5A2.5 2.5 0 0 1 3 18.5V16"/><rect x="7" y="7" width="10" height="10" rx="2"/><path d="m7.8 15 2.7-2.7 2 2 1.9-1.9 1.8 1.8"/>'),
    clock: P('<circle cx="12" cy="12" r="9"/><path d="M12 7.5V12l3 2"/>'),
    settings: P('<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v2.2M12 19.3v2.2M21.5 12h-2.2M4.7 12H2.5M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6M18.7 18.7l-1.6-1.6M6.9 6.9 5.3 5.3"/>'),
    merge: P('<rect x="8.5" y="3" width="12.5" height="15" rx="2.5"/><path d="M15.5 21H5.5A2.5 2.5 0 0 1 3 18.5V7"/>'),
    split: P('<rect x="3" y="3" width="18" height="18" rx="2.5"/><path d="M12 3v18"/><path d="M7.5 9.5v5M16.5 9.5v5"/>'),
    compress: P('<path d="M9 3v4a2 2 0 0 1-2 2H3"/><path d="M15 3v4a2 2 0 0 0 2 2h4"/><path d="M9 21v-4a2 2 0 0 0-2-2H3"/><path d="M15 21v-4a2 2 0 0 1 2-2h4"/>'),
    image: P('<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.6" cy="9.4" r="1.7"/><path d="m4 17 4.6-4.3a2 2 0 0 1 2.7 0L20 20"/>'),
    images: P('<rect x="7" y="3" width="14" height="13" rx="2.5"/><path d="M17 20.5H5.5A2.5 2.5 0 0 1 3 18V7"/><circle cx="11.6" cy="7.8" r="1.4"/><path d="m8 13.5 2.8-2.6a1.8 1.8 0 0 1 2.5 0L20 17"/>'),
    imgToPdf: P('<rect x="3" y="4" width="10" height="9" rx="2"/><circle cx="6.6" cy="7.6" r="1.1"/><path d="m3.6 11.6 2.3-2.1a1.6 1.6 0 0 1 2.1 0L13 13"/><path d="M10.5 20h8a2 2 0 0 0 2-2V9.5a2 2 0 0 0-2-2h-3"/><path d="m13.5 17 2 2.6 2-2.6"/>'),
    hash: P('<path d="M5 9h14M5 15h14M10 3.5 8.4 20.5M15.6 3.5 14 20.5"/>'),
    droplet: P('<path d="M12 3.2s6 6.1 6 10.1a6 6 0 0 1-12 0c0-4 6-10.1 6-10.1Z"/>'),
    rotate: P('<path d="M3.5 12a8.5 8.5 0 1 1 2.6 6.1"/><path d="M3.2 19.2 3.5 12l6.5 2.4"/>'),
    text: P('<path d="M5 6.5V5h14v1.5"/><path d="M12 5v14"/><path d="M9 19h6"/>'),
    pen: P('<path d="M3 20.5s2.5.4 4.2-1.1c2-1.8 1-4.6 3-6.2 2.5-2 4.4.6 6.4-1.3 1.6-1.5 1.4-3.9 1.4-3.9"/><path d="M14.5 4.8 19 9.3l-8.2 8.2-4.5-4.5Z"/><path d="M17.2 2.1 21.7 6.6"/>'),
    video: P('<rect x="2.5" y="5.5" width="13.5" height="13" rx="2.5"/><path d="m16 11.5 5.5-3.4v7.8L16 12.5Z"/>'),
    upload: P('<path d="M12 16V4"/><path d="m7.5 8.5 4.5-4.5 4.5 4.5"/><path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15"/>'),
    download: P('<path d="M12 4v12"/><path d="m7.5 11.5 4.5 4.5 4.5-4.5"/><path d="M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15"/>'),
    share: P('<circle cx="18" cy="5.5" r="2.6"/><circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="m8.3 10.8 7.4-4M8.3 13.2l7.4 4"/>'),
    trash: P('<path d="M4 6.5h16"/><path d="M9.5 6.5V4.8A1.3 1.3 0 0 1 10.8 3.5h2.4a1.3 1.3 0 0 1 1.3 1.3v1.7"/><path d="M6.5 6.5 7.3 20a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-13.5"/>'),
    back: P('<path d="M20 12H4"/><path d="m10 6-6 6 6 6"/>'),
    left: P('<path d="m14.5 5-7 7 7 7"/>'),
    right: P('<path d="m9.5 5 7 7-7 7"/>'),
    check: P('<path d="m4.5 12.5 5 5 10-11"/>'),
    checkCircle: P('<circle cx="12" cy="12" r="9"/><path d="m8 12.2 2.7 2.7L16 9.5"/>'),
    alert: P('<path d="M12 3.8 21 19.5H3Z"/><path d="M12 10v4"/><path d="M12 17.2h.01"/>'),
    x: P('<path d="M6 6l12 12M18 6 6 18"/>'),
    plus: P('<path d="M12 5v14M5 12h14"/>'),
    camera: P('<path d="M4 8.5h2.8l1.4-2.2h7.6l1.4 2.2H20a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5Z"/><circle cx="12" cy="13.6" r="3.4"/>'),
    folder: P('<path d="M3 7.5A2 2 0 0 1 5 5.5h3.6l2 2.4H19a2 2 0 0 1 2 2v8.1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>'),
    file: P('<path d="M13.5 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8.5Z"/><path d="M13.5 3v5.5H19"/>'),
    grip: P('<circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/>'),
    sparkles: P('<path d="M12 3.5 13.7 9 19 10.7 13.7 12.4 12 18l-1.7-5.6L5 10.7 10.3 9Z"/><path d="M18.5 3v3M20 4.5h-3M6 17v2.5M7.2 18.2H4.7"/>'),
    shield: P('<path d="M12 3 5 6v5.5c0 4.3 3 8.2 7 9.5 4-1.3 7-5.2 7-9.5V6Z"/><path d="m9 12 2.2 2.2L15.5 10"/>'),
    refresh: P('<path d="M20.5 11a8.5 8.5 0 0 0-15-4.4"/><path d="M3.5 13a8.5 8.5 0 0 0 15 4.4"/><path d="M20.5 4.5V11h-6"/><path d="M3.5 19.5V13h6"/>'),
    sun: P('<circle cx="12" cy="12" r="4"/><path d="M12 2v2.5M12 19.5V22M22 12h-2.5M4.5 12H2M19 5l-1.8 1.8M6.8 17.2 5 19M19 19l-1.8-1.8M6.8 6.8 5 5"/>'),
    moon: P('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z"/>'),
    copy: P('<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 5.5A2 2 0 0 0 13.5 3.5H6a2.5 2.5 0 0 0-2.5 2.5v7.5a2 2 0 0 0 2 2"/>'),
    zip: P('<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M11 4v2m2 1v2m-2 1v2m2 1v2m-2 1v2.5h2V16"/>'),
    scissors: P('<circle cx="6.5" cy="6.5" r="2.6"/><circle cx="6.5" cy="17.5" r="2.6"/><path d="M8.8 8 20 18M20 6 8.8 16"/>'),
  };

  PT.iconEl = function (name) {
    const s = el("span");
    s.innerHTML = PT.icons[name] || PT.icons.file;
    return s.firstChild;
  };

  /* ---------- toast ---------- */
  PT.toast = function (msg, kind) {
    const host = document.getElementById("toast");
    const t = el("div", { class: "t " + (kind || ""), text: msg });
    host.appendChild(t);
    setTimeout(() => {
      t.style.transition = "opacity .25s ease";
      t.style.opacity = "0";
      setTimeout(() => t.remove(), 260);
    }, kind === "err" ? 3600 : 2200);
  };

  /* ---------- settings ---------- */
  const SKEY = "pdftoolbox.settings.v1";
  const defaults = { theme: "auto", quality: 0.8, keepRecent: true, autoDownload: true };
  PT.settings = Object.assign({}, defaults);
  try { Object.assign(PT.settings, JSON.parse(localStorage.getItem(SKEY) || "{}")); } catch (e) {}
  PT.saveSettings = function () {
    try { localStorage.setItem(SKEY, JSON.stringify(PT.settings)); } catch (e) {}
    PT.applyTheme();
  };
  PT.applyTheme = function () {
    const t = PT.settings.theme;
    const dark = t === "dark" || (t === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", dark ? "#0b1020" : "#f7f9fd");
  };
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (PT.settings.theme === "auto") PT.applyTheme();
  });

  /* ---------- lazy library loading ---------- */
  const loaded = {};
  PT.loadScript = function (src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = PT.base + src;
      s.onload = () => res();
      s.onerror = () => rej(new Error("โหลดไลบรารีไม่สำเร็จ: " + src));
      document.head.appendChild(s);
    });
    return loaded[src];
  };

  PT.libs = {
    async pdfLib() {
      await PT.loadScript("vendor/pdf-lib.min.js");
      return window.PDFLib;
    },
    async fontkit() {
      await PT.loadScript("vendor/fontkit.umd.min.js");
      return window.fontkit;
    },
    async pdfjs() {
      await PT.loadScript("vendor/pdfjs/pdf.min.js");
      const lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = PT.base + "vendor/pdfjs/pdf.worker.min.js";
      return lib;
    },
    async jszip() {
      await PT.loadScript("vendor/jszip.min.js");
      return window.JSZip;
    },
    async mp4muxer() {
      await PT.loadScript("vendor/mp4-muxer.js");
      return window.Mp4Muxer;
    },
  };

  /* Thai-capable font bytes for pdf-lib (cached after first fetch). */
  const fontCache = {};
  PT.thaiFont = async function (bold) {
    const key = bold ? "Sarabun-Bold" : "Sarabun-Regular";
    if (!fontCache[key]) {
      const r = await fetch(PT.base + "assets/fonts/" + key + ".ttf");
      if (!r.ok) throw new Error("โหลดฟอนต์ไม่สำเร็จ");
      fontCache[key] = new Uint8Array(await r.arrayBuffer());
    }
    return fontCache[key];
  };

  /* Loads a PDF document with pdf-lib, embedding the Thai font on demand. */
  PT.embedThai = async function (pdfDoc, bold) {
    const fk = await PT.libs.fontkit();
    pdfDoc.registerFontkit(fk);
    return pdfDoc.embedFont(await PT.thaiFont(bold), { subset: true });
  };

  /* ---------- PDF open helpers ---------- */
  PT.openPdfJs = async function (file) {
    const pdfjs = await PT.libs.pdfjs();
    const data = new Uint8Array(await file.arrayBuffer());
    return pdfjs.getDocument({
      data,
      standardFontDataUrl: PT.base + "vendor/pdfjs/standard_fonts/",
      isEvalSupported: false,
    }).promise;
  };

  PT.renderPageToCanvas = async function (page, scale) {
    const vp = page.getViewport({ scale: scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext("2d", { alpha: false });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: vp, background: "#ffffff" }).promise;
    return canvas;
  };

  PT.canvasToBlob = function (canvas, type, quality) {
    return new Promise((res, rej) => {
      canvas.toBlob((b) => (b ? res(b) : rej(new Error("แปลงภาพไม่สำเร็จ"))), type, quality);
    });
  };

  PT.loadImage = function (src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("เปิดไฟล์ภาพไม่ได้"));
      img.src = src;
    });
  };

  PT.imageFromFile = async function (file) {
    const url = URL.createObjectURL(file);
    try { return await PT.loadImage(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 8000); }
  };

  /* "1-3,7,10-12" -> [0,1,2,6,9,10,11] (0-based, clamped, de-duplicated) */
  PT.parseRanges = function (text, max) {
    const out = [];
    const seen = new Set();
    String(text || "").split(/[,\s]+/).forEach((part) => {
      if (!part) return;
      const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) return;
      let a = parseInt(m[1], 10);
      let b = m[2] ? parseInt(m[2], 10) : a;
      if (b < a) { const t = a; a = b; b = t; }
      for (let i = a; i <= b; i++) {
        const idx = i - 1;
        if (idx >= 0 && idx < max && !seen.has(idx)) { seen.add(idx); out.push(idx); }
      }
    });
    return out;
  };

  /* ---------- download / share ---------- */
  PT.download = function (blob, name) {
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  };

  PT.canShare = function (file) {
    return !!(navigator.canShare && navigator.share && navigator.canShare({ files: [file] }));
  };

  PT.share = async function (blob, name) {
    const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
    if (!PT.canShare(file)) { PT.toast("อุปกรณ์นี้ยังแชร์ไฟล์ตรงไม่ได้ ใช้ดาวน์โหลดแทน"); return false; }
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e && e.name !== "AbortError") PT.toast("แชร์ไม่สำเร็จ", "err"); return false; }
  };

  /* ---------- recent files (IndexedDB) ---------- */
  const DB_NAME = "pdftoolbox";
  const STORE = "files";
  const MAX_RECENT = 24;
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(STORE)) {
          const s = d.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
          s.createIndex("ts", "ts");
        }
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
    return dbp;
  }
  function tx(mode) {
    return db().then((d) => d.transaction(STORE, mode).objectStore(STORE));
  }
  const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  PT.recents = {
    async add(blob, name, toolId, thumb) {
      if (!PT.settings.keepRecent) return;
      try {
        const store = await tx("readwrite");
        await wrap(store.add({ name: name, type: blob.type, size: blob.size, ts: Date.now(), tool: toolId, blob: blob, thumb: thumb || null }));
        const all = await PT.recents.list();
        if (all.length > MAX_RECENT) {
          const s2 = await tx("readwrite");
          for (const item of all.slice(MAX_RECENT)) await wrap(s2.delete(item.id));
        }
      } catch (e) { /* storage full or private mode - not fatal */ }
    },
    async list() {
      try {
        const store = await tx("readonly");
        const all = await wrap(store.getAll());
        return all.sort((a, b) => b.ts - a.ts);
      } catch (e) { return []; }
    },
    async remove(id) {
      const store = await tx("readwrite");
      return wrap(store.delete(id));
    },
    async clear() {
      const store = await tx("readwrite");
      return wrap(store.clear());
    },
  };

  /* ---------- tool registry ---------- */
  PT.tools = [];
  PT.toolMap = {};
  PT.registerTool = function (tool) {
    PT.tools.push(tool);
    PT.toolMap[tool.id] = tool;
  };

  /* Tool accent colours (kept in JS so cards and headers stay in sync). */
  PT.palette = {
    pink:   { accent: "#ec4899", tint: "#ffe4f1", glow: "rgba(236,72,153,.35)" },
    blue:   { accent: "#3b82f6", tint: "#e0edff", glow: "rgba(59,130,246,.35)" },
    violet: { accent: "#8b5cf6", tint: "#ece5ff", glow: "rgba(139,92,246,.35)" },
    teal:   { accent: "#0d9488", tint: "#d5f5ef", glow: "rgba(13,148,136,.35)" },
    amber:  { accent: "#f59e0b", tint: "#fff0d1", glow: "rgba(245,158,11,.35)" },
    red:    { accent: "#ef4444", tint: "#ffe1e1", glow: "rgba(239,68,68,.35)" },
    orange: { accent: "#f97316", tint: "#ffe8d6", glow: "rgba(249,115,22,.35)" },
    sky:    { accent: "#0ea5e9", tint: "#dcf1ff", glow: "rgba(14,165,233,.35)" },
    indigo: { accent: "#4f46e5", tint: "#e4e3ff", glow: "rgba(79,70,229,.35)" },
    magenta:{ accent: "#d946ef", tint: "#fbe3ff", glow: "rgba(217,70,239,.35)" },
    green:  { accent: "#16a34a", tint: "#dcfce7", glow: "rgba(22,163,74,.35)" },
    slate:  { accent: "#475569", tint: "#e6ebf2", glow: "rgba(71,85,105,.3)" },
    cyan:   { accent: "#06b6d4", tint: "#d7f6fb", glow: "rgba(6,182,212,.35)" },
    rose:   { accent: "#f43f5e", tint: "#ffe4ea", glow: "rgba(244,63,94,.35)" },
  };
  PT.paintAccent = function (node, color) {
    const p = PT.palette[color] || PT.palette.indigo;
    node.style.setProperty("--accent", p.accent);
    node.style.setProperty("--tint", p.tint);
    node.style.setProperty("--glow", p.glow);
    return node;
  };
})();
