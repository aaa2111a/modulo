// Extend the dock into unused viewport space without changing the artwork's layout.
// Write an external stylesheet rule through CSSOM, never a style attribute.
const app = document.getElementById('app');
const dock = app.querySelector('.dock');
const sheet = [...document.styleSheets].find(s => s.href && new URL(s.href).pathname.endsWith('/css/app.css'));
const rule = sheet && [...sheet.cssRules].find(r => r.selectorText === '.app' && r.style.getPropertyValue('--dock-fill'));
if (rule) {
  let fill = 0, queued = false;
  function measure() {
    queued = false;
    if (app.hidden) return;
    // offset geometry ignores the screen's entry transform and page scroll.
    let top = 0;
    for (let node = dock; node; node = node.offsetParent) top += node.offsetTop;
    const naturalBottom = top + dock.offsetHeight - fill;
    // Measure against .app itself (100dvh on phones, min 100dvh on desktop): it follows the dynamic viewport like the
    // layout does, and — unlike innerHeight — it does not shrink under pinch-zoom (opus P3-B). clientHeight was the
    // small viewport on Android Chrome (a toolbar-sized gap).
    let appTop = 0;
    for (let node = app; node; node = node.offsetParent) appTop += node.offsetTop;
    const next = Math.max(0, appTop + app.offsetHeight - naturalBottom);
    if (Math.abs(next - fill) < 1) return;
    fill = next;
    rule.style.setProperty('--dock-fill', `${fill}px`);
  }
  function schedule() {
    if (!queued) { queued = true; requestAnimationFrame(measure); }
  }
  const observer = new ResizeObserver(schedule);
  observer.observe(app); observer.observe(dock);
  new MutationObserver(schedule).observe(app, { attributes: true, attributeFilter: ['hidden'] });
  window.addEventListener('resize', schedule);
  schedule();
}
