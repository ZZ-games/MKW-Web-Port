// Copies an extracted Mario Kart Wii disc into this site's private browser storage (OPFS).
// Runs in a worker so it can use createSyncAccessHandle, which every current browser supports
// (including Safari on iPad, which has no showDirectoryPicker and no main-thread createWritable
// on older versions). Accepts a .zip, a .tar, or a list of loose files from a folder picker.
//
// Messages in:  { kind: 'zip' | 'tar', file }  or  { kind: 'files', files: [{ path, file }] }
// Messages out: { type: 'log', text } | { type: 'progress', done, total, copied, skipped }
//               | { type: 'done', copied, skipped, missing } | { type: 'error', text }

'use strict';

// Top-level entries of an extracted Wii disc (Dolphin "Extract Entire Disc" layout).
const ROOT_DIRS = new Set(['files', 'sys', 'disc']);
const ROOT_FILES = new Set(['cert.bin', 'ticket.bin', 'tmd.bin']);
// Files the game cannot start without; checked before writing the .complete marker.
const REQUIRED = ['sys/main.dol', 'sys/boot.bin', 'sys/bi2.bin', 'files/opening.bnr'];

const CONFIG_TOML = `[paths]
dvd_root = "/opfs/WiiCompiled/dvd"

[video]
window_width = 854
window_height = 480

[network]
enabled = false
`;

const log = (text) => postMessage({ type: 'log', text });
const utf8 = new TextDecoder();

// Maps an archive path to its path inside the disc root, or null to skip it.
// Handles archives that wrap everything in a top folder (e.g. "Mario Kart Wii/files/...").
let rootPrefix = null;
function discPath(raw) {
  const parts = raw.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
  if (!parts.length) return null;
  if (parts.some((p) => p === '__MACOSX' || p.startsWith('._')) || parts[parts.length - 1] === '.DS_Store') return null;
  if (rootPrefix === null) {
    for (let i = 0; i < parts.length; i++) {
      const isDir = ROOT_DIRS.has(parts[i]) && i < parts.length - 1;
      const isFile = ROOT_FILES.has(parts[i]) && i === parts.length - 1;
      if (isDir || isFile) { rootPrefix = parts.slice(0, i).join('/'); break; }
    }
    if (rootPrefix === null) return null;
    if (rootPrefix) log('archive folder "' + rootPrefix + '" is treated as the disc root');
  }
  const joined = parts.join('/');
  if (rootPrefix) {
    if (!joined.startsWith(rootPrefix + '/')) return null;
    return joined.slice(rootPrefix.length + 1);
  }
  return joined;
}

// Picks the disc-root prefix from the full list of names up front, when the list is known.
function detectPrefix(names) {
  for (const marker of ['sys/main.dol', 'files/opening.bnr', 'sys/boot.bin']) {
    const hit = names.find((n) => n.replace(/\\/g, '/') === marker || n.replace(/\\/g, '/').endsWith('/' + marker));
    if (hit) {
      const norm = hit.replace(/\\/g, '/');
      rootPrefix = norm.slice(0, norm.length - marker.length).replace(/\/$/, '').split('/').filter(Boolean).join('/');
      if (rootPrefix) log('archive folder "' + rootPrefix + '" is treated as the disc root');
      return;
    }
  }
}

// ── OPFS writing ──

let dvdRoot, wcRoot;
const dirCache = new Map();
async function dirFor(parts) {
  let dir = dvdRoot, key = '';
  for (const part of parts) {
    key += '/' + part;
    let next = dirCache.get(key);
    if (!next) { next = await dir.getDirectoryHandle(part, { create: true }); dirCache.set(key, next); }
    dir = next;
  }
  return dir;
}

async function existingSize(dir, name) {
  try { return (await (await dir.getFileHandle(name)).getFile()).size; } catch { return -1; }
}

// Streams a ReadableStream of bytes into an OPFS file.
async function writeStream(dir, name, stream) {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try {
    handle.truncate(0);
    let at = 0;
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      handle.write(value, { at });
      at += value.byteLength;
    }
    handle.flush();
    return at;
  } finally {
    handle.close();
  }
}

async function writeBytes(dir, name, bytes) {
  const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
  try { handle.truncate(0); handle.write(bytes, { at: 0 }); handle.flush(); } finally { handle.close(); }
}

// ── Progress ──

let total = 0, done = 0, copied = 0, skipped = 0, lastPost = 0;
const present = new Set();
function progress(force) {
  const now = Date.now();
  if (!force && now - lastPost < 150) return;
  lastPost = now;
  postMessage({ type: 'progress', done, total, copied, skipped });
}

// Copies one entry: path inside the disc, its final size, and a function returning its byte stream.
async function copyEntry(path, size, open) {
  const parts = path.split('/');
  const name = parts.pop();
  const dir = await dirFor(parts);
  if (await existingSize(dir, name) === size) {
    skipped++;
  } else {
    const written = await writeStream(dir, name, open());
    if (written !== size) throw new Error(path + ': expected ' + size + ' bytes, got ' + written);
    copied++;
  }
  present.add(path);
}

// ── ZIP (read through the central directory, so huge archives never sit in memory) ──

async function readAt(file, start, length) {
  return new DataView(await file.slice(start, start + length).arrayBuffer());
}
const u64 = (view, off) => view.getUint32(off, true) + view.getUint32(off + 4, true) * 2 ** 32;

async function zipEntries(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = await readAt(file, file.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('This does not look like a .zip file (no end-of-archive record).');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdOffset = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator < 0 || tail.getUint32(locator, true) !== 0x07064b50) throw new Error('Broken ZIP64 archive.');
    const z64 = await readAt(file, u64(tail, locator + 8), 56);
    if (z64.getUint32(0, true) !== 0x06064b50) throw new Error('Broken ZIP64 archive.');
    count = u64(z64, 32); cdSize = u64(z64, 40); cdOffset = u64(z64, 48);
  }
  const cd = await readAt(file, cdOffset, cdSize);
  const entries = [];
  for (let p = 0, i = 0; i < count; i++) {
    if (cd.getUint32(p, true) !== 0x02014b50) throw new Error('Broken ZIP central directory.');
    const flags = cd.getUint16(p + 8, true);
    const method = cd.getUint16(p + 10, true);
    let compSize = cd.getUint32(p + 20, true);
    let size = cd.getUint32(p + 24, true);
    const nameLen = cd.getUint16(p + 28, true), extraLen = cd.getUint16(p + 30, true), commentLen = cd.getUint16(p + 32, true);
    let localOffset = cd.getUint32(p + 42, true);
    const name = utf8.decode(new Uint8Array(cd.buffer, cd.byteOffset + p + 46, nameLen));
    for (let e = p + 46 + nameLen, end = e + extraLen; e + 4 <= end;) {
      const id = cd.getUint16(e, true), len = cd.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = u64(cd, q); q += 8; }
        if (compSize === 0xffffffff) { compSize = u64(cd, q); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = u64(cd, q); }
      }
      e += 4 + len;
    }
    if (!name.endsWith('/')) entries.push({ name, flags, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function importZip(file) {
  const entries = await zipEntries(file);
  detectPrefix(entries.map((e) => e.name));
  const wanted = [];
  for (const e of entries) { const path = discPath(e.name); if (path) wanted.push({ ...e, path }); }
  total = wanted.reduce((s, e) => s + e.size, 0);
  log(wanted.length + ' files in archive, ' + mib(total));
  for (const e of wanted) {
    if (e.flags & 1) throw new Error('The archive is password-protected; make it without a password.');
    if (e.method !== 0 && e.method !== 8) throw new Error(e.name + ': unsupported compression (method ' + e.method + '). Use a normal .zip.');
    const head = await readAt(file, e.localOffset, 30);
    if (head.getUint32(0, true) !== 0x04034b50) throw new Error('Broken ZIP entry: ' + e.name);
    const start = e.localOffset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const body = file.slice(start, start + e.compSize);
    await copyEntry(e.path, e.size, () => e.method === 0 ? body.stream() : body.stream().pipeThrough(new DecompressionStream('deflate-raw')));
    done += e.size;
    progress();
  }
}

// ── TAR (headers read in place; file bodies streamed straight from the archive) ──

async function importTar(file) {
  // First pass: list entries (only 512-byte headers are read).
  const entries = [];
  let off = 0, longName = null, paxPath = null;
  while (off + 512 <= file.size) {
    const h = new Uint8Array(await file.slice(off, off + 512).arrayBuffer());
    if (h.every((b) => b === 0)) break;
    const str = (a, b) => utf8.decode(h.subarray(a, b)).replace(/\0[\s\S]*$/, '');
    const sizeField = h.subarray(124, 136);
    let size;
    if (sizeField[0] & 0x80) { size = 0; for (let i = 1; i < 12; i++) size = size * 256 + sizeField[i]; }
    else size = parseInt(str(124, 136).trim(), 8) || 0;
    const type = String.fromCharCode(h[156] || 48);
    const prefix = str(345, 500);
    let name = (prefix ? prefix + '/' : '') + str(0, 100);
    const dataStart = off + 512;
    off = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = utf8.decode(new Uint8Array(await file.slice(dataStart, dataStart + size).arrayBuffer())).replace(/\0[\s\S]*$/, ''); continue; }
    if (type === 'x') {
      const pax = utf8.decode(new Uint8Array(await file.slice(dataStart, dataStart + size).arrayBuffer()));
      const m = pax.match(/(?:^|\n)\d+ path=([^\n]*)\n/);
      if (m) paxPath = m[1];
      continue;
    }
    if (paxPath) { name = paxPath; paxPath = null; }
    if (longName) { name = longName; longName = null; }
    if (type === '0' || type === '7') entries.push({ name, size, dataStart });
  }
  if (!entries.length) throw new Error('This does not look like a .tar file (no files found).');
  detectPrefix(entries.map((e) => e.name));
  const wanted = [];
  for (const e of entries) { const path = discPath(e.name); if (path) wanted.push({ ...e, path }); }
  total = wanted.reduce((s, e) => s + e.size, 0);
  log(wanted.length + ' files in archive, ' + mib(total));
  for (const e of wanted) {
    await copyEntry(e.path, e.size, () => file.slice(e.dataStart, e.dataStart + e.size).stream());
    done += e.size;
    progress();
  }
}

// ── Loose files (folder picker) ──

async function importFiles(list) {
  detectPrefix(list.map((f) => f.path));
  const wanted = [];
  for (const f of list) { const path = discPath(f.path); if (path) wanted.push({ path, file: f.file }); }
  total = wanted.reduce((s, f) => s + f.file.size, 0);
  log(wanted.length + ' files selected, ' + mib(total));
  for (const f of wanted) {
    await copyEntry(f.path, f.file.size, () => f.file.stream());
    done += f.file.size;
    progress();
  }
}

const mib = (n) => (n / 1048576).toFixed(1) + ' MB';

self.onmessage = async (event) => {
  const msg = event.data;
  try {
    const root = await navigator.storage.getDirectory();
    wcRoot = await root.getDirectoryHandle('WiiCompiled', { create: true });
    dvdRoot = await wcRoot.getDirectoryHandle('dvd', { create: true });
    // A new import invalidates the "ready" marker until it finishes.
    try { await dvdRoot.removeEntry('.complete'); } catch {}

    if (msg.kind === 'zip') await importZip(msg.file);
    else if (msg.kind === 'tar') await importTar(msg.file);
    else await importFiles(msg.files);
    progress(true);

    if (rootPrefix === null) throw new Error('No Wii disc files found. The archive or folder should contain "files" and "sys" folders.');

    // Fill in anything required that was already present from an earlier import.
    const missing = [];
    for (const path of REQUIRED) {
      if (present.has(path)) continue;
      const parts = path.split('/'); const name = parts.pop();
      if (await existingSize(await dirFor(parts), name) < 0) missing.push(path);
    }

    // Config.toml: point dvd_root at OPFS, keeping settings the game may have written.
    let config = null;
    try { config = await (await (await wcRoot.getFileHandle('Config.toml')).getFile()).text(); } catch {}
    if (config === null) config = CONFIG_TOML;
    else if (!/^dvd_root\s*=\s*"\/opfs/m.test(config)) {
      config = /^#?\s*dvd_root\s*=.*$/m.test(config)
        ? config.replace(/^#?\s*dvd_root\s*=.*$/m, 'dvd_root = "/opfs/WiiCompiled/dvd"')
        : config + '\n[paths]\ndvd_root = "/opfs/WiiCompiled/dvd"\n';
    }
    await writeBytes(wcRoot, 'Config.toml', new TextEncoder().encode(config));

    if (!missing.length) await writeBytes(dvdRoot, '.complete', new TextEncoder().encode('done'));
    postMessage({ type: 'done', copied, skipped, missing });
  } catch (error) {
    postMessage({ type: 'error', text: String(error && error.message || error) });
  }
};
