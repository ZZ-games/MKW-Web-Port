// On-screen touch controls for the MKW web port.
// They act as a virtual "standard" gamepad: the game (SDL3) polls navigator.getGamepads(), so
// a virtual pad needs no knowledge of the keyboard bindings. A real controller, once connected,
// takes over and the overlay hides itself.
//
// Standard-gamepad layout used:  axes 0/1 = left stick, button 0 = A, 1 = B, 2 = X, 3 = Y,
// 4/5 = LB/RB, 6/7 = LT/RT, 8 = Back (−), 9 = Start (+), 12–15 = D-pad.
(function () {
  'use strict';
  const coarse = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  const params = new URLSearchParams(location.search);
  if (params.get('touch') === '0' || (!coarse && params.get('touch') !== '1')) return;

  // ── Virtual gamepad ──
  const buttons = Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));
  const pad = {
    id: 'Touch Controls (STANDARD GAMEPAD)',
    index: 0, connected: true, mapping: 'standard', timestamp: performance.now(),
    axes: [0, 0, 0, 0], buttons, vibrationActuator: null, hapticActuators: [],
  };
  const realGetGamepads = navigator.getGamepads ? navigator.getGamepads.bind(navigator) : () => [];
  const realPads = () => { try { return Array.from(realGetGamepads() || []); } catch { return []; } };
  const hasRealPad = () => realPads().some((g) => g && g.connected);
  let enabled = true;
  navigator.getGamepads = function () {
    const real = realPads();
    if (!enabled || real.some((g) => g && g.connected)) return real;
    return [pad, null, null, null];
  };
  const touch = () => { pad.timestamp = performance.now(); };
  const setButton = (i, on) => { const b = buttons[i]; b.pressed = b.touched = on; b.value = on ? 1 : 0; touch(); };

  let announced = false;
  function announce() {
    if (announced) return;
    announced = true;
    const ev = new Event('gamepadconnected');
    Object.defineProperty(ev, 'gamepad', { value: pad });
    window.dispatchEvent(ev);
  }

  // ── Overlay ──
  const css = `
  #tc { position: fixed; inset: 0; z-index: 50; pointer-events: none; touch-action: none; -webkit-user-select: none; user-select: none; }
  #tc[hidden] { display: none; }
  #tc .zone { position: absolute; pointer-events: auto; touch-action: none; }
  #tc-stick-zone { left: 0; bottom: 0; width: 45%; height: 70%; }
  #tc-stick { position: absolute; width: 140px; height: 140px; margin: -70px 0 0 -70px; border-radius: 50%;
              border: 2px solid rgb(255 255 255 / 35%); background: rgb(255 255 255 / 8%); opacity: .55; transition: opacity .15s; }
  #tc-knob { position: absolute; left: 50%; top: 50%; width: 60px; height: 60px; margin: -30px 0 0 -30px; border-radius: 50%; background: rgb(255 255 255 / 45%); }
  #tc .btn { position: absolute; pointer-events: auto; touch-action: none; display: flex; align-items: center; justify-content: center;
             border-radius: 50%; border: 2px solid rgb(255 255 255 / 40%); background: rgb(255 255 255 / 12%);
             color: rgb(255 255 255 / 85%); font: 600 18px/1 system-ui, sans-serif; }
  #tc .btn.on { background: rgb(255 255 255 / 40%); }
  #tc .pill { border-radius: 14px; font-size: 14px; }
  #tc-toggle { position: fixed; z-index: 51; left: max(8px, env(safe-area-inset-left)); top: max(8px, env(safe-area-inset-top));
               padding: 8px 12px; font: 13px system-ui, sans-serif; color: #e8e8e6; background: rgb(0 0 0 / 55%);
               border: 1px solid #2c2c29; border-radius: 6px; opacity: .45; touch-action: manipulation; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const R = 'max(16px, env(safe-area-inset-right))';
  const B = 'max(16px, env(safe-area-inset-bottom))';
  const root = document.createElement('div');
  root.id = 'tc';
  root.innerHTML = `
    <div class="zone" id="tc-stick-zone"><div id="tc-stick"><div id="tc-knob"></div></div></div>
    <div class="btn" data-b="0" title="A — accelerate / confirm" style="right:calc(${R} + 10px); bottom:calc(${B} + 70px); width:96px; height:96px; font-size:24px">A</div>
    <div class="btn" data-b="1" title="B — brake / back" style="right:calc(${R} + 120px); bottom:calc(${B} + 20px); width:72px; height:72px">B</div>
    <div class="btn pill" data-b="7" title="R — drift / hop" style="right:calc(${R} + 120px); bottom:calc(${B} + 110px); width:86px; height:52px">R</div>
    <div class="btn pill" data-b="6" title="L — use item" style="right:calc(${R} + 10px); bottom:calc(${B} + 180px); width:96px; height:52px">L</div>
    <div class="btn pill" data-b="8" title="− (Minus)" style="right:calc(${R} + 200px); top:max(12px, env(safe-area-inset-top)); width:56px; height:40px">−</div>
    <div class="btn pill" data-b="9" title="+ (Start / pause)" style="right:calc(${R} + 136px); top:max(12px, env(safe-area-inset-top)); width:56px; height:40px">+</div>
  `;
  const toggle = document.createElement('button');
  toggle.id = 'tc-toggle';
  toggle.type = 'button';
  toggle.textContent = 'Hide controls';

  function mount() {
    document.body.appendChild(root);
    document.body.appendChild(toggle);
    wire();
  }
  if (document.body) mount(); else document.addEventListener('DOMContentLoaded', mount);

  function setEnabled(on) {
    enabled = on;
    root.hidden = !on;
    toggle.textContent = on ? 'Hide controls' : 'Show controls';
    if (!on) { buttons.forEach((b, i) => setButton(i, false)); pad.axes[0] = pad.axes[1] = 0; }
  }

  function wire() {
    toggle.addEventListener('click', () => setEnabled(!enabled));

    // Buttons: each pointer presses one button; sliding off releases it.
    root.querySelectorAll('.btn').forEach((el) => {
      const index = Number(el.dataset.b);
      const press = (on) => { el.classList.toggle('on', on); setButton(index, on); };
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); announce(); el.setPointerCapture(e.pointerId); press(true); });
      const up = (e) => { e.preventDefault(); press(false); };
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', () => press(false));
    });

    // Floating analog stick: appears where the left thumb lands.
    const zone = document.getElementById('tc-stick-zone');
    const base = document.getElementById('tc-stick');
    const knob = document.getElementById('tc-knob');
    const RADIUS = 60, DEAD = 0.12;
    let stickId = null, cx = 0, cy = 0;
    const rest = () => {
      const r = zone.getBoundingClientRect();
      base.style.left = '110px'; base.style.top = (r.height - 110) + 'px'; base.style.opacity = '.55';
      knob.style.transform = '';
    };
    rest();
    addEventListener('resize', () => { if (stickId === null) rest(); });
    const move = (e) => {
      let dx = e.clientX - cx, dy = e.clientY - cy;
      const len = Math.hypot(dx, dy);
      if (len > RADIUS) { dx *= RADIUS / len; dy *= RADIUS / len; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      let ax = dx / RADIUS, ay = dy / RADIUS;
      const mag = Math.hypot(ax, ay);
      if (mag < DEAD) ax = ay = 0;
      else { const k = (mag - DEAD) / (1 - DEAD) / mag; ax *= k; ay *= k; }
      pad.axes[0] = ax; pad.axes[1] = ay;
      // D-pad mirrors the stick for menus that only read digital input.
      setButton(12, ay < -0.6); setButton(13, ay > 0.6); setButton(14, ax < -0.6); setButton(15, ax > 0.6);
    };
    zone.addEventListener('pointerdown', (e) => {
      if (stickId !== null) return;
      e.preventDefault(); announce();
      stickId = e.pointerId;
      zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      cx = e.clientX; cy = e.clientY;
      base.style.left = (cx - r.left) + 'px'; base.style.top = (cy - r.top) + 'px'; base.style.opacity = '1';
      move(e);
    });
    zone.addEventListener('pointermove', (e) => { if (e.pointerId === stickId) { e.preventDefault(); move(e); } });
    const end = (e) => {
      if (e.pointerId !== stickId) return;
      stickId = null;
      pad.axes[0] = pad.axes[1] = 0;
      [12, 13, 14, 15].forEach((i) => setButton(i, false));
      rest();
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);

    // A real controller takes over; the overlay comes back when it disconnects.
    addEventListener('gamepadconnected', (e) => { if (e.gamepad !== pad) setEnabled(false); });
    addEventListener('gamepaddisconnected', () => { if (!hasRealPad()) setEnabled(true); });
  }

  // Let the game see the pad as soon as it starts polling.
  window.mkwTouchPad = pad;
  setTimeout(announce, 4000);
})();
