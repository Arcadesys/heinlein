import {formatWordTotal, wordTotal, type CountIndex, type WordCountSnapshot} from './manuscriptWordCounts';
function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {const node = document.createElement(tag); node.textContent = text; node.className = className; return node;}
const text = (node: HTMLElement, value: string) => {if (node.textContent !== value) node.textContent = value;};
/** A read-only overlay. Never dispatches editor transactions or announces each keystroke. */
export function createWordCountDialog(snapshot: () => WordCountSnapshot, recount: () => Promise<void>) {
  const element = el('dialog', '', 'appearance-dialog word-count-dialog'); element.setAttribute('aria-label', 'Word counts');
  const heading = el('h2', 'Word counts'); heading.tabIndex = -1;
  const close = el('button', 'Close'); close.type = 'button'; close.setAttribute('aria-label', 'Close word counts');
  const header = el('div', '', 'word-count-heading'); header.append(heading, close);
  const note = el('p', 'Includes the current scene or group editor’s unsaved text. Each source scene is counted once.');
  const overview = el('dl', '', 'word-count-overview');
  const currentTitle = el('dt', 'Current scene'), current = el('dd'), manuscriptTitle = el('dt', 'Whole manuscript'), manuscript = el('dd');
  overview.append(currentTitle, current, manuscriptTitle, manuscript);
  const boundary = el('p', '', 'word-count-boundary');
  const refresh = el('button', 'Recount saved scenes'); refresh.type = 'button';
  refresh.addEventListener('click', () => {refresh.disabled = true; void recount().finally(() => {refresh.disabled = false; update();});});
  const groupLabel = el('label', 'Show group'); const group = el('select'); group.setAttribute('aria-label', 'Show group word counts'); groupLabel.append(group);
  const groupTotal = el('p', '', 'word-count-group-total');
  const descendants = el('p', 'Group counts include scenes in nested groups. Reference sheets and files outside the manuscript are excluded.');
  const sceneHeading = el('h3', 'Scene counts');
  const scenes = el('ul', '', 'word-count-scenes'); scenes.setAttribute('aria-label', 'Scene word counts');
  const empty = el('p');
  const definitions = el('details'); definitions.append(el('summary', 'How words are counted'), el('p', 'Uses Heinlein’s Unicode word count of Markdown source. Complete opening frontmatter is excluded. Punctuation, emoji and formatting marks alone do not count. Words in code and link destinations do count. Source and Reading show the same total. Saved scenes are read when the manuscript loads; the open editor takes precedence.'));
  element.append(header, note, overview, boundary, refresh, groupLabel, groupTotal, descendants, sceneHeading, scenes, empty, definitions);
  let opener: HTMLElement | null = null, index: CountIndex | null | undefined;
  const rows = new Map<string, {element: HTMLLIElement; count: HTMLElement; marker: HTMLElement}>();
  function rebuild(value: WordCountSnapshot, selectCurrent = false) {
    if (index !== value.index) {
      const previous = group.value; index = value.index;
      const all = el('option', 'Whole manuscript'); all.value = ''; group.replaceChildren(all);
      for (const item of index?.groups ?? []) {const option = el('option', item.label); option.value = item.id; group.append(option);}
      group.value = index?.groups.some(item => item.id === previous) ? previous : '';
      rows.clear(); scenes.replaceChildren();
      const titles = new Map<string, number>();
      for (const scene of index?.scenes ?? []) titles.set(scene.title, (titles.get(scene.title) ?? 0) + 1);
      for (const scene of index?.scenes ?? []) {
        const row = el('li'); const label = el('span', scene.title);
        if (titles.get(scene.title)! > 1) label.append(el('small', scene.path, 'word-count-path'));
        const marker = el('span', 'Current scene', 'word-count-current'); marker.hidden = true; label.append(marker);
        const count = el('span', '', 'word-count-number'); row.append(label, count); scenes.append(row); rows.set(scene.path, {element: row, count, marker});
      }
    }
    if (selectCurrent) group.value = value.activeGroupId ?? '';
  }
  function update(selectCurrent = false) {
    if (!element.open) return;
    const value = snapshot(); rebuild(value, selectCurrent);
    text(currentTitle, value.current ? `${value.current.included ? 'Current scene' : 'Current file (outside manuscript)'}: ${value.current.title}` : 'Current scene');
    text(current, value.current ? `${value.current.words.toLocaleString()} ${value.current.words === 1 ? 'word' : 'words'}` : value.activeGroupId ? 'Group editor open; see its scene counts below.' : 'No scene open');
    text(manuscriptTitle, value.index ? `Whole manuscript: ${value.index.title}` : 'Whole manuscript');
    text(manuscript, value.index ? formatWordTotal(wordTotal(value)) : 'No manuscript selected');
    text(boundary, value.index ? `${value.index.scenes.length.toLocaleString()} indexed source ${value.index.scenes.length === 1 ? 'scene' : 'scenes'}. No reference sheets, untracked files, generated chapters or deleted scenes are added.` : 'Open a manuscript to see group and whole-manuscript counts.');
    const selected = value.index?.groups.find(item => item.id === group.value);
    const paths = selected?.paths ?? value.index?.scenes.map(scene => scene.path) ?? [];
    const included = new Set(paths);
    text(groupTotal, value.index ? `${selected ? `Group: ${selected.label}` : 'All manuscript scenes'} · ${formatWordTotal(wordTotal(value, paths))}` : '');
    for (const [path, row] of rows) {row.element.hidden = !included.has(path); row.element.classList.toggle('is-current', value.current?.path === path); row.marker.hidden = value.current?.path !== path; if (value.current?.path === path) row.element.setAttribute('aria-current', 'true'); else row.element.removeAttribute('aria-current'); const count = value.counts.get(path); text(row.count, count != null ? `${count.toLocaleString()} ${count === 1 ? 'word' : 'words'}` : value.pending.has(path) ? 'Counting…' : 'Count unavailable');}
    text(empty, value.index && !paths.length ? 'No manuscript scenes in this group.' : '');
    refresh.hidden = groupLabel.hidden = descendants.hidden = sceneHeading.hidden = !value.index;
  }
  function restore() {if (opener?.isConnected) opener.focus({preventScroll: true}); opener = null;}
  function dismiss() {if (!element.open) return; if (typeof element.close === 'function') element.close(); else element.removeAttribute('open'); restore();}
  close.addEventListener('click', dismiss);
  element.addEventListener('cancel', event => {event.preventDefault(); dismiss();}); // A queued close event from an earlier opening must not steal focus after reopening.
  element.addEventListener('close', () => {if (!element.open) restore();});
  group.addEventListener('change', () => update());
  return {element, update, open() {if (element.open) {heading.focus(); return;} opener = document.activeElement instanceof HTMLElement ? document.activeElement : null; if (typeof element.showModal === 'function') element.showModal(); else element.setAttribute('open', ''); update(true); heading.focus({preventScroll: true});}, destroy() {dismiss(); element.remove();}};
}
