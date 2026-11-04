/*! coi-serviceworker - Guido Zuidhof, licensed under MIT (modified) */
/* Service Worker: adds COOP/COEP headers + rewrites absolute paths for GitHub Pages subdir hosting. */
/* v4 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The WASM binary hardcodes absolute fetch paths like /blobs/*, /play/*, etc.
// On GitHub Pages the site lives at /mkw-web/, so rewrite those to the correct subdir.
const BASE = new URL("./", self.registration.scope).pathname;
const REWRITE_PREFIXES = ["/blobs/", "/play/", "/game/"];

// Safari/WebKit (iPad, iPhone, macOS Safari) does not implement COEP "credentialless", so with
// that value the page is never cross-origin isolated there and the game's threads cannot start.
// Every subresource of this site is same-origin (and sent with CORP same-origin below), and
// cross-origin fetches are CORS requests, so the stricter "require-corp" works for WebKit.
const UA = self.navigator.userAgent || "";
const IS_WEBKIT = /AppleWebKit/.test(UA) && !/Chrome\/|Chromium\/|Edg\/|Firefox\/|FxiOS\//.test(UA);
const COEP_VALUE = IS_WEBKIT ? "require-corp" : "credentialless";

function rewriteUrl(url) {
  const u = new URL(url);
  if (u.origin !== self.location.origin) return url;
  for (const prefix of REWRITE_PREFIXES) {
    if (u.pathname.startsWith(prefix) && !u.pathname.startsWith(BASE)) {
      u.pathname = BASE + u.pathname.slice(1);
      return u.href;
    }
  }
  return url;
}

// The game binaries are larger than GitHub's 100 MB file limit, so they are stored as
// WiiCompiled.wasm.part0, .part1, ... with a WiiCompiled.wasm.parts.json manifest. A request for
// the whole .wasm is answered by streaming the parts back together. If there is no manifest
// (e.g. a local build with the whole file), the request goes through unchanged.
const SPLIT_WASM = /\/play\/WiiCompiled(-safe)?\.wasm$/;

function isolationHeaders(headers) {
  headers.set("Cross-Origin-Embedder-Policy", COEP_VALUE);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return headers;
}

async function joinedWasm(url) {
  const manifestResp = await fetch(url + ".parts.json", { cache: "no-cache" });
  if (!manifestResp.ok) return null;
  const { size, parts } = await manifestResp.json();
  let index = 0, reader = null;
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= parts.length) { controller.close(); return; }
          const part = await fetch(new URL(parts[index++], url));
          if (!part.ok) { controller.error(new Error("missing " + parts[index - 1] + ": " + part.status)); return; }
          reader = part.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) { reader = null; continue; }
        controller.enqueue(value);
        return;
      }
    },
    cancel() { if (reader) reader.cancel(); },
  });
  const headers = isolationHeaders(new Headers({ "Content-Type": "application/wasm", "Content-Length": String(size) }));
  return new Response(body, { status: 200, headers });
}

self.addEventListener("fetch", (e) => {
  if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
  // Let cross-origin requests (e.g. GitHub Release downloads) pass through untouched.
  const reqUrl = new URL(e.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  const rewritten = rewriteUrl(e.request.url);
  const req = rewritten !== e.request.url ? new Request(rewritten, e.request) : e.request;
  const path = new URL(rewritten).pathname;
  if (SPLIT_WASM.test(path) && e.request.method === "GET") {
    e.respondWith(joinedWasm(new URL(rewritten).origin + path).then((r) => r || fetch(req).then((x) => new Response(x.body, { status: x.status, statusText: x.statusText, headers: isolationHeaders(new Headers(x.headers)) }))));
    return;
  }
  e.respondWith(
    fetch(req).then((r) => {
      if (r.status === 0) return r;
      const headers = isolationHeaders(new Headers(r.headers));
      return new Response(r.body, { status: r.status, statusText: r.statusText, headers });
    }).catch((err) => console.error(err))
  );
});
