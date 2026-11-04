// Auto-downloads game data from GitHub Release tar archives into OPFS.
// Streams each tar sequentially — no library needed.

const ARCHIVES = [
  { name: 'game-data-core.tar', size: 856590848 },
  { name: 'game-data-video.tar', size: 1828199936 },
];
const TOTAL_BYTES = ARCHIVES.reduce((s, a) => s + a.size, 0);

const CONFIG_TOML = `[paths]
dvd_root = "/opfs/WiiCompiled/dvd"

[video]
window_width = 854
window_height = 480

[network]
enabled = false
`;

// ── Tar parser (streams 512-byte headers) ──

function decodeTarHeader(buf) {
  const td = new TextDecoder();
  const name = td.decode(buf.subarray(0, 100)).replace(/\0+$/, '');
  const sizeStr = td.decode(buf.subarray(124, 136)).replace(/\0+$/, '').trim();
  const size = parseInt(sizeStr, 8) || 0;
  const type = buf[156];
  // type 0 or ASCII '0' = regular file, '5' = directory, 'x'/'g' = pax header
  const isFile = type === 0 || type === 0x30;
  // GNU long name indicator
  const isLongName = type === 0x4C;
  // Check for pax extended header
  const isPax = type === 0x78 || type === 0x67;
  // Prefix (for POSIX ustar)
  const prefix = td.decode(buf.subarray(345, 500)).replace(/\0+$/, '');
  const fullName = prefix ? prefix + '/' + name : name;
  return { name: fullName, size, isFile, isLongName, isPax };
}

// Buffered reader that avoids O(n²) copies by using a chunk queue.
function makeBufferedReader(reader) {
  const chunks = [];
  let totalLen = 0;
  let eof = false;

  async function fillTo(n) {
    while (totalLen < n && !eof) {
      const { done, value } = await reader.read();
      if (done) { eof = true; return; }
      chunks.push(value);
      totalLen += value.length;
    }
  }

  function consume(n) {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const chunk = chunks[0];
      const take = Math.min(chunk.length, n - written);
      out.set(chunk.subarray(0, take), written);
      written += take;
      if (take === chunk.length) {
        chunks.shift();
      } else {
        chunks[0] = chunk.subarray(take);
      }
    }
    totalLen -= n;
    return out;
  }

  async function skip(n) {
    let remaining = n;
    while (remaining > 0) {
      if (chunks.length === 0) await fillTo(1);
      if (eof && chunks.length === 0) return;
      const chunk = chunks[0];
      if (chunk.length <= remaining) {
        remaining -= chunk.length;
        totalLen -= chunk.length;
        chunks.shift();
      } else {
        chunks[0] = chunk.subarray(remaining);
        totalLen -= remaining;
        remaining = 0;
      }
    }
  }

  return {
    async read(n) { await fillTo(n); return totalLen >= n ? consume(n) : null; },
    skip,
  };
}

async function* tarEntries(reader) {
  const buf = makeBufferedReader(reader);
  let longName = null;

  while (true) {
    const header = await buf.read(512);
    if (!header) return;
    if (header.every((b) => b === 0)) return;

    const entry = decodeTarHeader(header);
    const paddedSize = Math.ceil(entry.size / 512) * 512;

    if (entry.isLongName) {
      const data = await buf.read(paddedSize);
      if (!data) return;
      longName = new TextDecoder().decode(data.subarray(0, entry.size)).replace(/\0+$/, '');
      continue;
    }

    if (entry.isPax || !entry.isFile || entry.size === 0) {
      if (paddedSize > 0) await buf.skip(paddedSize);
      continue;
    }

    if (longName) { entry.name = longName; longName = null; }

    const fileData = await buf.read(entry.size);
    if (!fileData) return;
    const padding = paddedSize - entry.size;
    if (padding > 0) await buf.skip(padding);
    yield { name: entry.name, data: fileData };
  }
}

// ── OPFS helpers ──

const dirCache = new Map();

async function dirFor(root, parts) {
  const key = parts.join('/');
  if (dirCache.has(key)) return dirCache.get(key);
  let dir = root;
  for (let i = 0; i < parts.length; i++) {
    const subKey = parts.slice(0, i + 1).join('/');
    if (dirCache.has(subKey)) { dir = dirCache.get(subKey); continue; }
    dir = await dir.getDirectoryHandle(parts[i], { create: true });
    dirCache.set(subKey, dir);
  }
  return dir;
}

async function writeFile(dir, name, data, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const h = await dir.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(data);
      await w.close();
      return;
    } catch (err) {
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, 50 * (i + 1)));
    }
  }
}

function writeQueue(concurrency = 6) {
  let running = 0;
  const queue = [];
  let error = null;

  function drain() {
    while (running < concurrency && queue.length > 0 && !error) {
      const { dir, name, data, resolve, reject } = queue.shift();
      running++;
      writeFile(dir, name, data).then(resolve, (err) => { error = err; reject(err); }).finally(() => { running--; drain(); });
    }
  }

  return {
    push(dir, name, data) {
      if (error) return Promise.reject(error);
      return new Promise((resolve, reject) => { queue.push({ dir, name, data, resolve, reject }); drain(); });
    },
    async flush() {
      while (running > 0 || queue.length > 0) {
        await new Promise(r => setTimeout(r, 10));
      }
      if (error) throw error;
    }
  };
}

// ── Public API ──

export async function isGameDataReady() {
  try {
    const root = await navigator.storage.getDirectory();
    const wc = await root.getDirectoryHandle('WiiCompiled');
    const dvd = await wc.getDirectoryHandle('dvd');
    await dvd.getFileHandle('.complete');
    return true;
  } catch {
    return false;
  }
}

export async function downloadGameData(onProgress, { skipVideos = false, onStatus } = {}) {
  if (navigator.storage.persist) await navigator.storage.persist();

  const root = await navigator.storage.getDirectory();
  const wc = await dirFor(root, ['WiiCompiled']);
  const dvd = await dirFor(wc, ['dvd']);

  let downloaded = 0;
  const archives = skipVideos ? ARCHIVES.filter(a => !a.name.includes('video')) : ARCHIVES;
  const totalBytes = archives.reduce((s, a) => s + a.size, 0);

  for (const archive of archives) {
    if (onStatus) onStatus(`Connecting to server…`);
    const url = new URL(`gamedata/${archive.name}`, self.location.href).href;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to fetch ${archive.name}: ${resp.status}`);
    if (onStatus) onStatus(null);

    const contentLength = parseInt(resp.headers.get('content-length'), 10) || archive.size;
    const bodyReader = resp.body.getReader();

    // Wrap reader to track download progress
    let archiveBytes = 0;
    const trackingReader = {
      async read() {
        const result = await bodyReader.read();
        if (!result.done) {
          archiveBytes += result.value.length;
          onProgress(downloaded + archiveBytes, totalBytes, archive.name);
        }
        return result;
      }
    };

    const wq = writeQueue(6);

    for await (const entry of tarEntries(trackingReader)) {
      let path = entry.name.replace(/^\.\//, '');
      if (!path) continue;

      const parts = path.split('/');
      const fileName = parts.pop();
      if (!fileName) continue;

      const dir = parts.length > 0 ? await dirFor(dvd, parts) : dvd;
      wq.push(dir, fileName, entry.data);
    }

    await wq.flush();

    downloaded += contentLength;
    onProgress(downloaded, totalBytes, null);
  }

  // Write Config.toml
  try {
    const configHandle = await wc.getFileHandle('Config.toml');
    let config = await (await configHandle.getFile()).text();
    if (config.includes('# dvd_root') || !config.includes('dvd_root = "/opfs')) {
      config = config.replace(/^#?\s*dvd_root\s*=.*$/m, 'dvd_root = "/opfs/WiiCompiled/dvd"');
      if (!config.includes('dvd_root = "/opfs')) {
        config += '\n[paths]\ndvd_root = "/opfs/WiiCompiled/dvd"\n';
      }
      await writeFile(wc, 'Config.toml', new TextEncoder().encode(config));
    }
  } catch {
    await writeFile(wc, 'Config.toml', new TextEncoder().encode(CONFIG_TOML));
  }

  // Mark complete
  await writeFile(dvd, '.complete', new TextEncoder().encode('done'));
}

export { TOTAL_BYTES };
