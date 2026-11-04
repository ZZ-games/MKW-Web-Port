/*! coi-serviceworker - Guido Zuidhof, licensed under MIT (modified) */
/* Service Worker: adds COOP/COEP headers, rewrites absolute paths for GitHub Pages subdir hosting,
   and serves the game's big startup files from compressed, cached packs. */
/* v5 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// The WASM binary hardcodes absolute fetch paths like /blobs/*, /play/*, etc.
// On GitHub Pages the site lives in a subfolder, so rewrite those to the correct subdir.
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

function isolationHeaders(headers) {
  headers.set("Cross-Origin-Embedder-Policy", COEP_VALUE);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  return headers;
}

// ── Packed assets ──
// packed.json (made by web/tools/pack_assets.py) lists files stored gzip-compressed and split
// into parts. A request for one of them is answered by downloading all its parts in parallel,
// decompressing, and saving the result in Cache Storage, so the next launch needs no download.
const CACHE = "mkw-assets";
let manifestPromise = null;
const inflight = new Map(); // cache key -> promise that settles when the cache write finishes

function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(BASE + "packed.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => { if (m) pruneCache(m); return m; })
      .catch(() => null);
    // Re-read the manifest now and then, so a new deploy is picked up without a SW update.
    setTimeout(() => { manifestPromise = null; }, 60000);
  }
  return manifestPromise;
}

const cacheKey = (path, entry) => self.location.origin + BASE + path + "?sha=" + entry.sha256;

async function pruneCache(manifest) {
  try {
    const cache = await caches.open(CACHE);
    const keep = new Set(Object.entries(manifest.assets).map(([p, e]) => cacheKey(p, e)));
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
  } catch {}
}

function assetHeaders(entry) {
  return isolationHeaders(new Headers({ "Content-Type": entry.type, "Content-Length": String(entry.size) }));
}

// Joins the parts (all requested at once) into one stream, in order.
function joinedParts(entry) {
  const responses = entry.parts.map((p) => fetch(BASE + p, { cache: "no-cache" }));
  let index = 0, reader = null;
  return new ReadableStream({
    async pull(controller) {
      for (;;) {
        if (!reader) {
          if (index >= responses.length) { controller.close(); return; }
          const resp = await responses[index++];
          if (!resp.ok) { controller.error(new Error("missing " + entry.parts[index - 1] + ": " + resp.status)); return; }
          reader = resp.body.getReader();
        }
        const { done, value } = await reader.read();
        if (done) { reader = null; continue; }
        controller.enqueue(value);
        return;
      }
    },
    cancel() { if (reader) reader.cancel(); },
  });
}

async function packedResponse(path) {
  const manifest = await loadManifest();
  const entry = manifest && manifest.assets[path];
  if (!entry) return null;
  const key = cacheKey(path, entry);
  const cache = await caches.open(CACHE).catch(() => null);
  if (inflight.has(key)) await inflight.get(key).catch(() => {});
  const hit = cache && await cache.match(key);
  if (hit) return new Response(hit.body, { status: 200, headers: assetHeaders(entry) });

  const body = joinedParts(entry).pipeThrough(new DecompressionStream("gzip"));
  if (!cache) return new Response(body, { status: 200, headers: assetHeaders(entry) });
  const [forPage, forCache] = body.tee();
  const write = cache.put(key, new Response(forCache, { headers: { "Content-Type": entry.type } }));
  inflight.set(key, write);
  write.catch(() => {}).finally(() => inflight.delete(key));
  return new Response(forPage, { status: 200, headers: assetHeaders(entry) });
}

self.addEventListener("fetch", (e) => {
  if (e.request.cache === "only-if-cached" && e.request.mode !== "same-origin") return;
  // Let cross-origin requests (e.g. GitHub Release downloads) pass through untouched.
  const reqUrl = new URL(e.request.url);
  if (reqUrl.origin !== self.location.origin) return;

  const rewritten = rewriteUrl(e.request.url);
  const req = rewritten !== e.request.url ? new Request(rewritten, e.request) : e.request;
  const passThrough = () => fetch(req).then((r) => {
    if (r.status === 0) return r;
    return new Response(r.body, { status: r.status, statusText: r.statusText, headers: isolationHeaders(new Headers(r.headers)) });
  });

  const path = new URL(rewritten).pathname;
  if (e.request.method === "GET" && path.startsWith(BASE)) {
    const rel = path.slice(BASE.length);
    if (/^(play|blobs)\//.test(rel)) {
      e.respondWith(packedResponse(rel).then((r) => r || passThrough()).catch((err) => { console.error(err); return passThrough(); }));
      return;
    }
  }
  e.respondWith(passThrough().catch((err) => console.error(err)));
});
