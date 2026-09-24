// Presentation only. Logical loading state remains in main.js.
export function createLoadingUI(node, label, { reduced, delay = setTimeout, cancel = clearTimeout }) {
  let timer = null, revision = 0;
  return function update(text, immediate = false) {
    const turn = ++revision;
    if (timer !== null) cancel(timer);
    timer = null;
    node.classList.remove('leaving');
    const finish = () => {
      if (turn !== revision) return;
      timer = null;
      node.hidden = !text;
      node.classList.remove('leaving');
    };
    if (text) label.textContent = text;
    if (immediate || reduced.matches) { finish(); return; }
    if (text) {
      if (node.hidden) timer = delay(finish, 140);
    } else if (!node.hidden) {
      node.classList.add('leaving');
      timer = delay(finish, 140);
    }
  };
}
