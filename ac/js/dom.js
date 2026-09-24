// Minimal XSS-safe DOM builder: text only via textContent, attributes via setAttribute, never innerHTML.
// Chain-derived strings (trait names, ids) go through here; chain SVGs are shown ONLY as <img src="data:…">.
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}
export const $ = id => document.getElementById(id);
/** an SVG string (ours, or the chain's) as an image — the only way SVG enters the page (no script execution) */
export const svgDataUrl = svg => 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
export const shortAddr = a => a.slice(0, 6) + '…' + a.slice(-4);
