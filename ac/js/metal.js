// Tilt + light for the metal buttons (".solid" controls) — the animation of "01 · Equilibrado" from
// codex/ac-button-explorations/diagonal-motion.html, same maths: a 6 s cycle, yaw = sin(phase), pitch = −0.4·sin(phase),
// 8° amplitude; the reflection band (--lx) and the two planes' light (--a / --b) follow the same tilt.
// Custom properties are set through the CSSOM (style.setProperty), which this page's CSP (style-src 'self') allows.
// Differences from the reference, for a phone: the loop only runs while a control is on screen and the tab is visible;
// prefers-reduced-motion → the static pose (the reference's own "vista estática").
const AMP = 8, PERIOD_S = 6;
const solids = [...document.querySelectorAll('.solid')];
const visible = new Set();
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
let time = 0, last = null, raf = 0;

function render() {
  const phase = time / 1000 * Math.PI * 2 / PERIOD_S;
  const yaw = Math.sin(phase), pitch = Math.sin(phase) * -0.4;
  for (const b of visible) {
    b.style.setProperty('--ry', yaw * AMP + 'deg');
    b.style.setProperty('--rx', pitch * AMP + 'deg');
    b.style.setProperty('--lx', (50 - yaw * 14 - pitch * 5) + '%');
    b.style.setProperty('--a', (0.2 + yaw * 0.16).toFixed(3));
    b.style.setProperty('--b', (0.12 - yaw * 0.1).toFixed(3));
  }
}
function frame(now) {
  raf = 0;
  if (last !== null && !reduced.matches) time += Math.min(now - last, 50);
  last = now;
  render();
  schedule();
}
function schedule() {
  if (raf || document.hidden || !visible.size || reduced.matches) { if (!raf) last = null; return; }   // reduced motion: static pose, no loop
  raf = requestAnimationFrame(frame);
}
reduced.addEventListener('change', () => { render(); schedule(); });
const io = new IntersectionObserver(entries => {
  for (const e of entries) { if (e.isIntersecting) visible.add(e.target); else visible.delete(e.target); }
  render(); schedule();
});
for (const s of solids) io.observe(s);
document.addEventListener('visibilitychange', schedule);
