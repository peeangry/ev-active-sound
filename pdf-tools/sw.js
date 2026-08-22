/* Service worker: pre-caches the shell so the toolbox keeps working offline. */
const VERSION = "pdf-toolbox-v1";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/icon.svg",
  "./assets/css/app.css",
  "./assets/js/core.js",
  "./assets/js/ui.js",
  "./assets/js/app.js",
  "./assets/js/tools-pdf.js",
  "./assets/js/tools-image.js",
  "./assets/js/tools-video.js",
  "./assets/fonts/Sarabun-Regular.ttf",
  "./assets/fonts/Sarabun-Bold.ttf",
  "./vendor/pdf-lib.min.js",
  "./vendor/fontkit.umd.min.js",
  "./vendor/jszip.min.js",
  "./vendor/mp4-muxer.js",
  "./vendor/pdfjs/pdf.min.js",
  "./vendor/pdfjs/pdf.worker.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) => {
      if (hit) return hit;
      return fetch(req).then((res) => {
        // cache successful same-origin responses (e.g. pdf.js standard fonts)
        if (res && res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html"));
    })
  );
});
