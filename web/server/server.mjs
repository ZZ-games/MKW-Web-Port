// Local-only dev server for the MKW web port.
//  - Listens on 127.0.0.1:3000 only (never on a LAN or public interface).
//  - Sends COOP/COEP so pages get crossOriginIsolated + SharedArrayBuffer (needed for pthreads).
//  - Serves fixed, read-only mounts; no directory listings, no uploads.
//  - GET /game-manifest.json lists the extracted disc (relative path + size) for import.html.
//  - POST /log?variant=NAME appends a report to web/logs/probe-NAME.log.
// Game files and translator output are served from their local folders; nothing here is ever
// published, and the server refuses any non-loopback interface by construction.
import { createServer } from 'node:http';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 3000;
const WEB_ROOT = path.resolve(import.meta.dirname, '..');
const MKW_ROOT = path.resolve(WEB_ROOT, '..');
const LOG_DIR = path.join(WEB_ROOT, 'logs');
const GAME_DIR = path.join(MKW_ROOT, 'game', 'extracted');

// URL prefix -> { dir, allow? }. Longest prefix first. `allow` restricts a mount to named files.
const MOUNTS = [
  ['/gputest/', { dir: path.join(WEB_ROOT, 'gputest', 'out') }],
  // The user's own disc, extracted locally; copied into the browser by import.html.
  ['/game/', { dir: GAME_DIR }],
  // Translator-made DOL/REL data-section blobs, fetched by the game at startup.
  ['/blobs/', { dir: path.join(MKW_ROOT, 'native', 'WiiCompiled', 'BuildWorkspace', 'generated', 'data_sections_init_blobs') }],
  // Only the linked module from the web build directory, nothing else in it.
  ['/play/', {
    dir: path.join(WEB_ROOT, 'build-game'),
    allow: new Set(['WiiCompiled.js', 'WiiCompiled.wasm', 'WiiCompiled-safe.js', 'WiiCompiled-safe.wasm']),
  }],
  ['/', { dir: path.join(WEB_ROOT, 'site') }],
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function isolationHeaders(res) {
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cache-Control', 'no-store');
}

function resolveFile(urlPath) {
  for (const [prefix, mount] of MOUNTS) {
    if (!urlPath.startsWith(prefix)) continue;
    const relative = decodeURIComponent(urlPath.slice(prefix.length)) || 'index.html';
    if (mount.allow && !mount.allow.has(relative)) return null;
    const full = path.resolve(mount.dir, relative);
    // Refuse anything that escapes the mount (../ tricks, absolute paths).
    if (full !== mount.dir && !full.startsWith(mount.dir + path.sep)) return null;
    return full;
  }
  return null;
}

async function listGameFiles(dir, prefix = '') {
  const out = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listGameFiles(full, rel)));
    else if (entry.isFile()) out.push({ path: rel, size: (await fs.stat(full)).size });
  }
  return out;
}

async function handleLog(req, res, url) {
  const variant = (url.searchParams.get('variant') || 'unknown').replace(/[^a-z0-9_-]/gi, '');
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 4 << 20) break;
  }
  await fs.mkdir(LOG_DIR, { recursive: true });
  await fs.appendFile(path.join(LOG_DIR, `probe-${variant}.log`), `===== ${new Date().toISOString()}\n${body}\n`);
  res.writeHead(204).end();
}

const server = createServer(async (req, res) => {
  isolationHeaders(res);
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (req.method === 'POST' && url.pathname === '/log') {
      await handleLog(req, res, url);
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    if (url.pathname === '/game-manifest.json') {
      const files = await listGameFiles(GAME_DIR);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ files }));
      return;
    }
    const file = resolveFile(url.pathname);
    const stat = file ? await fs.stat(file).catch(() => null) : null;
    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': stat.size,
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(PORT, HOST, () => console.log(`MKW web dev server: http://localhost:${PORT}/ (bound to ${HOST} only)`));
