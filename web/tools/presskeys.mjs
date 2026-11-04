// Sends real key presses to the game page through the DevTools protocol of a browser started
// with --remote-debugging-port=9222 (localhost only), for testing input without a person.
//   node presskeys.mjs [pageUrlSubstring] KeyX Enter ArrowUp ...   (DOM KeyboardEvent.code values)
const [match = 'play.html', ...codes] = process.argv.slice(2);
const KEYS = {
  KeyX: { key: 'x', keyCode: 88 }, KeyZ: { key: 'z', keyCode: 90 }, Enter: { key: 'Enter', keyCode: 13 },
  Space: { key: ' ', keyCode: 32 }, ArrowUp: { key: 'ArrowUp', keyCode: 38 }, ArrowDown: { key: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', keyCode: 37 }, ArrowRight: { key: 'ArrowRight', keyCode: 39 },
  ShiftLeft: { key: 'Shift', keyCode: 16 },
};
const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = pages.find((p) => p.type === 'page' && p.url.includes(match));
if (!page) {
  console.error(`no page matching "${match}"`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let nextId = 1;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
};
const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  ws.send(JSON.stringify({ id, method, params }));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await send('Page.bringToFront');
// Focus the canvas like a click would.
await send('Runtime.evaluate', { expression: "document.getElementById('canvas').focus(); document.activeElement && document.activeElement.id" });
for (const code of codes) {
  const info = KEYS[code];
  if (!info) { console.error(`unknown key ${code}`); continue; }
  const base = { code, key: info.key, windowsVirtualKeyCode: info.keyCode, nativeVirtualKeyCode: info.keyCode };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
  await sleep(150);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(350);
  console.log(`pressed ${code}`);
}
ws.close();
process.exit(0);
