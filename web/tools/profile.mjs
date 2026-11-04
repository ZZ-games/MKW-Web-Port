// CPU-profiles the game page's workers for a few seconds through the DevTools protocol of a
// browser started with --remote-debugging-port=9222 (localhost only), and prints the functions
// with the most self time, per worker and overall.
//   node profile.mjs [pageUrlSubstring] [seconds]
const match = process.argv[2] || 'play.html';
const seconds = Number(process.argv[3] || 8);
// Optional: print the caller chains that lead to this function's self time.
const callersOf = process.argv[4];
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
const workers = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    pending.get(message.id)(message);
    pending.delete(message.id);
    return;
  }
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params;
    if (targetInfo.type === 'worker') workers.push(sessionId);
    send('Runtime.runIfWaitingForDebugger', {}, sessionId);
  }
};
const send = (method, params = {}, sessionId) => new Promise((resolve) => {
  const id = nextId++;
  pending.set(id, resolve);
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  ws.send(JSON.stringify(message));
});
// A reply may never come from a worker that is blocked; don't let one stall the run.
const sendWithin = (ms, method, params, sessionId) =>
  Promise.race([send(method, params, sessionId), new Promise((resolve) => setTimeout(() => resolve(null), ms))]);

await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
await new Promise((resolve) => setTimeout(resolve, 1500));

for (const sessionId of workers) {
  await sendWithin(2000, 'Profiler.enable', {}, sessionId);
  await sendWithin(2000, 'Profiler.setSamplingInterval', { interval: 250 }, sessionId);
  await sendWithin(2000, 'Profiler.start', {}, sessionId);
}
await new Promise((resolve) => setTimeout(resolve, seconds * 1000));

const overall = new Map();
const overallAll = new Map();
let workerIndex = 0;
for (const sessionId of workers) {
  workerIndex++;
  const reply = await sendWithin(4000, 'Profiler.stop', {}, sessionId);
  const profile = reply?.result?.profile;
  if (!profile) continue;
  // Self samples per node, then per function name.
  const selfCount = new Map();
  for (const id of profile.samples || []) selfCount.set(id, (selfCount.get(id) || 0) + 1);
  const byName = new Map();
  let total = 0;
  for (const node of profile.nodes) {
    const count = selfCount.get(node.id) || 0;
    if (!count) continue;
    const name = node.callFrame.functionName || '(anonymous)';
    byName.set(name, (byName.get(name) || 0) + count);
    overallAll.set(name, (overallAll.get(name) || 0) + count);
    total += count;
  }
  if (callersOf) {
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const chains = new Map();
    for (const n of profile.nodes) {
      const count = selfCount.get(n.id) || 0;
      if (!count || n.callFrame.functionName !== callersOf) continue;
      const names = [];
      for (let p = parent.get(n.id); p !== undefined && names.length < 6; p = parent.get(p)) names.push(byId.get(p).callFrame.functionName || '(anonymous)');
      const key = names.join(' <- ');
      chains.set(key, (chains.get(key) || 0) + count);
    }
    const top = [...chains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) console.log(`
--- worker ${workerIndex}: callers of ${callersOf}`);
    for (const [k, c] of top) console.log(`${String(c).padStart(6)}  ${k.slice(0, 400)}`);
  }
  const idle = (byName.get('(idle)') || 0) + (byName.get('(program)') || 0);
  if (total - idle < total * 0.05) continue; // mostly idle worker: skip
  console.log(`\n=== worker ${workerIndex}: ${total} samples, ${((1 - idle / total) * 100).toFixed(0)}% busy`);
  const top = [...byName.entries()].filter(([n]) => n !== '(idle)' && n !== '(program)').sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [name, count] of top) {
    console.log(`${((count / total) * 100).toFixed(1).padStart(5)}%  ${name.slice(0, 140)}`);
    overall.set(name, (overall.get(name) || 0) + count);
  }
}
// Real work across all workers: guest code hops between baton threads, so per-worker views are
// mostly blocked waits. Drop waiting frames and rank what is left.
const WAITING = /^(_do_futex_wait|__timedwait_cp|__pthread_cond_timedwait|sem_timedwait|sem_wait|HostContext::Switch\(void\*\)|emscripten_futex_wait|\(idle\)|\(program\)|\(garbage collector\)|aurora::gfx::pipeline_cache_writer\(\))$/;
let work = 0;
const ranked = [];
for (const [name, count] of overallAll) {
  if (WAITING.test(name)) continue;
  work += count;
  ranked.push([name, count]);
}
ranked.sort((a, b) => b[1] - a[1]);
console.log(`\n=== real work across all workers: ${work} samples (${(work * 0.25 / 1000).toFixed(2)} s of CPU in ${seconds} s)`);
for (const [name, count] of ranked.slice(0, 45)) {
  console.log(`${((count / work) * 100).toFixed(1).padStart(5)}%  ${name.slice(0, 150)}`);
}
ws.close();
process.exit(0);
