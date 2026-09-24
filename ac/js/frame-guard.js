// Anti-framing (the meta CSP cannot carry frame-ancestors): if this page is framed, blank it and try to break out.
// External file so script-src 'self' needs no inline hash. Same intent as the Modulo pages' frame-buster.
if (window.top !== window.self) {
  document.documentElement.replaceChildren();
  try { window.top.location = window.self.location.href; } catch (_) { /* cross-origin top: page stays blank */ }
}
