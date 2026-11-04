// Collects console messages (including WebGPU validation warnings, which only reach the DevTools
// console) from the game page and its workers for a few seconds, via the DevTools protocol of a
// browser started with --remote-debugging-port=9222 (localhost only).
//   node console.mjs [pageUrlSubstring] [seconds]
const match = process.argv[2] || 'play.html';
const seconds = Number(process.argv[3] || 8);
const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = pages.find((p) => p.type === 'page' && p.url.includes(match));
if (!page) {
  console.error(`no page matching "${match}"`);
  process.exit(1);
}
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const send = (method, params = {}, sessionId) => {
  const message = { id: nextId++, method, params };
  if (sessionId) message.sessionId = sessionId;
  ws.send(JSON.stringify(message));
};
const counts = new Map();
const record = (where, level, text) => {
  // The game's own stdout is already in web/logs; keep only browser-side messages.
  if (/^\[(OSReport|runtime|aurora|os|nand|dvd|gx|vi|audio|hle|heartbeat|stall|memory|web)\]/.test(text)) return;
  const key = `${level} ${text.slice(0, 300)}`;
  counts.set(key, (counts.get(key) || 0) + 1);
};
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  const where = message.sessionId ? 'worker' : 'page';
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId } = message.params;
    send('Runtime.enable', {}, sessionId);
    send('Log.enable', {}, sessionId);
    send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  } else if (message.method === 'Log.entryAdded') {
    const { level, text } = message.params.entry;
    record(where, level, text);
  } else if (message.method === 'Runtime.consoleAPICalled') {
    const text = message.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
    record(where, message.params.type, text);
  } else if (message.method === 'Runtime.exceptionThrown') {
    record(where, 'exception', message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  }
};
send('Runtime.enable');
send('Log.enable');
send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
console.log(`${sorted.length} distinct browser console message(s) in ${seconds} s`);
for (const [text, count] of sorted.slice(0, 40)) console.log(`${String(count).padStart(5)}x ${text}`);
ws.close();
process.exit(0);
