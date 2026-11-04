#!/usr/bin/env python3
"""Pack the game's startup files for fast download from GitHub Pages.

Each file is gzip-compressed (the .wasm shrinks to about a fifth) and split into parts under
GitHub's file size limit. docs/packed.json lists them; docs/sw.js fetches the parts in parallel,
decompresses them and keeps the result in the browser's cache, so later launches are instant.

Usage:  python3 web/tools/pack_assets.py [path/to/WiiCompiled.wasm path/to/WiiCompiled-safe.wasm]
Run it from the repo root after changing any of the files below. With no arguments the .wasm
files are taken from docs/play/ (whole files) or rebuilt from the existing packed parts.
"""
import gzip, hashlib, json, os, sys

DOCS = 'docs'
OUT = os.path.join(DOCS, 'packed')
PART = 8_000_000  # small parts download in parallel; GitHub limit is 100 MB
# Served path (relative to the site root) -> MIME type.
ASSETS = {
    'play/WiiCompiled.wasm': 'application/wasm',
    'play/WiiCompiled-safe.wasm': 'application/wasm',
    'play/initial_pipeline_cache.db': 'application/octet-stream',
    'play/cacert.pem': 'application/x-pem-file',
    'blobs/StaticR.bin': 'application/octet-stream',
    'blobs/_text.bin': 'application/octet-stream',
    'blobs/_data.bin': 'application/octet-stream',
    'blobs/_rodata.bin': 'application/octet-stream',
}


def source_bytes(path, overrides, old_manifest):
    if path in overrides:
        return open(overrides[path], 'rb').read()
    whole = os.path.join(DOCS, path)
    if os.path.exists(whole) and not open(whole, 'rb').read(40).startswith(b'version https://git-lfs'):
        return open(whole, 'rb').read()
    entry = old_manifest.get('assets', {}).get(path)
    if entry:  # rebuild from the previous packed parts
        data = b''.join(open(os.path.join(DOCS, p), 'rb').read() for p in entry['parts'])
        return gzip.decompress(data)
    raise SystemExit('missing source for ' + path)


def main():
    overrides = {}
    for arg in sys.argv[1:]:
        overrides['play/' + os.path.basename(arg)] = arg
    manifest_path = os.path.join(DOCS, 'packed.json')
    old = json.load(open(manifest_path)) if os.path.exists(manifest_path) else {}
    sources = {path: source_bytes(path, overrides, old) for path in ASSETS}

    os.makedirs(OUT, exist_ok=True)
    for name in os.listdir(OUT):
        os.remove(os.path.join(OUT, name))
    assets = {}
    for path, mime in ASSETS.items():
        raw = sources[path]
        packed = gzip.compress(raw, compresslevel=9, mtime=0)
        stem = path.replace('/', '__')
        parts = []
        for i in range(0, len(packed), PART):
            part = os.path.join('packed', f'{stem}.gz.{i // PART}')
            open(os.path.join(DOCS, part), 'wb').write(packed[i:i + PART])
            parts.append(part)
        assets[path] = {
            'type': mime, 'size': len(raw), 'packedSize': len(packed),
            'sha256': hashlib.sha256(raw).hexdigest(), 'parts': parts,
        }
        print(f'{path}: {len(raw):,} -> {len(packed):,} bytes in {len(parts)} part(s)')
    version = hashlib.sha256(''.join(a['sha256'] for a in assets.values()).encode()).hexdigest()[:16]
    json.dump({'version': version, 'assets': assets}, open(manifest_path, 'w'), indent=1)
    print('wrote', manifest_path, 'version', version)


if __name__ == '__main__':
    main()
