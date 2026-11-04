// Prints a JS/wasm stack for the game page and each of its workers, via the DevTools protocol
// of a browser started with --remote-debugging-port=9222 (localhost only).
// A thread blocked in Atomics.wait (mutex, condvar, semaphore) cannot pause; it is reported as
// "no pause (blocked?)", which is itself the useful signal when hunting a deadlock.
//   node stackdump.mjs [pageUrlSubstring]
const match = process.argv[2] || 'play.html';
const pages = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = pages.find((p) => p.type === 'page' && p.url.includes(match));
if (!page) {
  console.error(`no page matching "${match}"; open targets:`, pages.map((p) => `${p.type} ${p.url}`));
  process.exit(1);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let nextId = 1;
const pendingReplies = new Map();
const targets = new Map(); // sessionId ('' = page) -> { label, frames }
targets.set('', { label: `page ${page.url}`, frames: null });

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  ws.send(JSON.stringify(message));
  return new Promise((resolve) => pendingReplies.set(id, resolve));
}

ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pendingReplies.has(message.id)) {
    pendingReplies.get(message.id)(message);
    pendingReplies.delete(message.id);
    return;
  }
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params;
    targets.set(sessionId, { label: `${targetInfo.type} ${targetInfo.title || targetInfo.url}`, frames: null });
    // Child workers of this worker, too.
    send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
  if (message.method === 'Debugger.paused') {
    const target = targets.get(message.sessionId || '');
    if (target) {
      target.frames = message.params.callFrames.slice(0, 40).map((frame) => {
        const where = frame.url ? `${frame.url.split('/').pop()}:${frame.location.lineNumber}` : '';
        return `${frame.functionName || '(anonymous)'}  ${where}`;
      });
    }
    send('Debugger.resume', {}, message.sessionId);
  }
};

await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await new Promise((resolve) => setTimeout(resolve, 1500));

// A busy or blocked worker may never answer, so nothing here waits on an individual reply:
// everything is sent, then whatever pauses arrive within a fixed window is reported.
for (const sessionId of targets.keys()) {
  send('Debugger.enable', {}, sessionId || undefined);
  send('Debugger.pause', {}, sessionId || undefined);
}
await new Promise((resolve) => setTimeout(resolve, 8000));

for (const [sessionId, target] of targets) {
  console.log(`\n=== ${target.label}${sessionId ? ` [${sessionId.slice(0, 8)}]` : ''}`);
  if (!target.frames) {
    console.log('  no pause (blocked in a wait?)');
    continue;
  }
  for (const line of target.frames) console.log('  ' + line);
}
ws.close();
process.exit(0);
