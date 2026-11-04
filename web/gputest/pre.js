// Forwards stderr lines and aborts to the local server's /log, so failures that happen before
// the probe can POST its own report still reach us.
(() => {
  if (typeof window === 'undefined') return;
  const variant = (location.pathname.match(/gputest-([a-z]+)/) || [, 'unknown'])[1] + '-console';
  const lines = [];
  const flush = () => {
    if (!lines.length) return;
    fetch('/log?variant=' + variant, { method: 'POST', body: lines.splice(0).join('\n') });
  };
  const previousErr = Module['printErr'];
  Module['printErr'] = (text) => { lines.push(text); if (previousErr) previousErr(text); else console.error(text); };
  Module['onAbort'] = (what) => { lines.push('ABORT: ' + what); flush(); };
  window.addEventListener('error', (e) => { lines.push('window.onerror: ' + e.message); flush(); });
  window.addEventListener('unhandledrejection', (e) => { lines.push('unhandledrejection: ' + (e.reason && (e.reason.stack || e.reason))); flush(); });
  setInterval(flush, 1000);
})();
