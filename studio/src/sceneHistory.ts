import type {SceneVersion} from './localCore';
import {linesDiff} from './proposalDiff';
import {rawOffset} from './editor';
import './sceneHistory.css';

interface Passage {olderFrom:number; from: number; to: number; older: string}
export function changedPassages(older: string, current: string): Passage[] {
  const passages: Passage[] = [];
  let position = 0, olderPosition=0;
  let pending: Passage | undefined;
  for (const line of linesDiff(older, current)) {
    if (line.kind === 'equal') pending = undefined;
    else {
      if (!pending) {
        pending = {olderFrom:olderPosition,from: position, to: position, older: ''};
        passages.push(pending);
      }
      if (line.kind === 'remove') pending.older += line.text;
      else pending.to += line.text.length;
    }
    if(line.kind!=='add') olderPosition+=line.text.length;
    if (line.kind !== 'remove') position += line.text.length;
  }
  return passages;
}

interface HistoryOptions {
  root: HTMLElement;
  title: string;
  current: string;
  list(): Promise<SceneVersion[]>;
  read(version: SceneVersion): Promise<string>;
  restore(from: number, to: number, text: string): boolean;
  focus(): void;
}

/** Freeze the reviewed range and bytes until the author explicitly confirms. */
function confirmSelection(parent: HTMLDialogElement, opener: HTMLButtonElement, current: string,
  from: number, to: number, restored: string, apply: () => void) {
  const inserting = from === to;
  const review = document.createElement('dialog');
  review.className = 'appearance-dialog scene-history restore-confirmation';
  const heading = document.createElement('h2');
  heading.textContent = inserting ? 'Review insertion' : 'Review replacement';
  review.setAttribute('aria-label', heading.textContent);
  heading.tabIndex = -1;

  const preceding = current.slice(0, from);
  const lastBreak = Math.max(preceding.lastIndexOf('\r'), preceding.lastIndexOf('\n'));
  const line = 1 + (preceding.match(/\r\n|[\r\n]/g)?.length ?? 0);
  const column = 1 + Array.from(preceding.slice(lastBreak + 1)).length;
  const location = document.createElement('p');
  location.id = 'restore-selection-location';
  const boundary = !current.length ? 'The scene is empty.' : from === 0 ? 'At the start of the scene.' :
    from === current.length ? 'At the end of the scene.' : '';
  location.textContent = [inserting ? 'Insert at' : 'Replace starting at', `line ${line}, column ${column}.`, boundary].filter(Boolean).join(' ');
  review.setAttribute('aria-describedby', location.id);
  review.append(heading, location);

  function showText(name: string, text: string) {
    const label = document.createElement('label');
    label.textContent = name;
    const field = document.createElement('textarea');
    field.readOnly = true;
    field.value = text;
    label.append(field);
    review.append(label);
    if (text.length && !text.trim()) {
      // VoiceOver can skip whitespace at its usual punctuation level.
      const note = document.createElement('p');
      const runs = text.match(/(?:\r\n|\r(?!\n)|(?<!\r)\n)+| +|\t+|[^ \t\r\n]+/gu) ?? [];
      note.textContent = runs.map(run => {
        const count = Array.from(run.replace(/\r\n/g, '\n')).length;
        const kind = run[0] === ' ' ? 'space' : run[0] === '\t' ? 'tab' :
          /[\r\n]/.test(run[0]) ? 'line break' : 'whitespace character';
        return `${count} ${kind}${count === 1 ? '' : 's'}`;
      }).join(', ');
      review.append(note);
    }
  }

  if (inserting) {
    // Preserve nearby whitespace and avoid cutting a surrogate pair at an excerpt edge.
    const left = current.slice(Math.max(0, from - 81), from).replace(/^[\uDC00-\uDFFF]/, '');
    const right = current.slice(to, to + 81).replace(/[\uD800-\uDBFF]$/, '');
    if (left) showText('Immediately before the insertion point', left);
    if (right) showText('Immediately after the insertion point', right);
  } else showText('Current text to replace', current.slice(from, to));
  showText(inserting ? 'Text to insert' : 'Replacement text', restored);

  const cancel = document.createElement('button');
  cancel.textContent = 'Back to selection';
  const confirm = document.createElement('button');
  confirm.textContent = inserting ? 'Confirm insertion' : 'Confirm replacement';
  function dismiss() {
    review.close();
    review.remove();
    opener.focus();
  }
  cancel.onclick = dismiss;
  review.oncancel = event => { event.preventDefault(); dismiss(); };
  confirm.onclick = () => {
    if (!review.open) return;
    dismiss();
    apply();
  };
  review.append(cancel, confirm);
  parent.append(review);
  review.showModal();
  heading.focus();
}

export function openSceneHistory(options: HistoryOptions) {
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  };
  const dialog = element('dialog');
  dialog.className = 'appearance-dialog scene-history';
  dialog.setAttribute('aria-label', 'Scene history');
  const close = element('button', 'Return to writing');
  function finish() { dialog.close(); dialog.remove(); options.focus(); }
  close.onclick = finish;
  dialog.oncancel = event => { event.preventDefault(); finish(); };
  const status = element('p', 'Loading local history…');
  status.setAttribute('role', 'status');
  const selectors = element('div'), comparison = element('section');
  dialog.append(element('h2', 'Scene history'), element('p', options.title), close, selectors, status, comparison);
  options.root.append(dialog);
  dialog.showModal();
  close.focus();

  const earlier = element('select'), later = element('select');
  let versions: SceneVersion[] = [];
  let request = 0;
  function picker(label: string, select: HTMLSelectElement) {
    const wrapper = element('label', label);
    wrapper.append(select);
    selectors.append(wrapper);
  }
  function error(reason: unknown) { status.textContent = 'Could not load scene history. ' + String(reason); }

  async function compare() {
    const ticket = ++request;
    comparison.replaceChildren();
    status.textContent = 'Comparing versions…';
    const live = later.value === 'current';
    try {
      const [before, after] = await Promise.all([
        options.read(versions[Number(earlier.value)]),
        live ? options.current : options.read(versions[Number(later.value)]),
      ]);
      if (!dialog.open || ticket !== request) return;
      const changes = changedPassages(before, after);
      if (!changes.length) { status.textContent = 'These versions have identical text.'; return; }
      const changePicker = element('select');
      const label = element('label', 'Changed passage');
      changes.forEach((change, i) => {
        const line = (change.older || after.slice(change.from, change.to)).trim().slice(0, 50);
        changePicker.add(new Option(`${i + 1} of ${changes.length} · ${line}`, String(i)));
      });
      label.append(changePicker);
      const detail = element('div');
      comparison.append(label, detail);
      function renderPassage() {
        const change = changes[Number(changePicker.value)];
        const destination = after.slice(change.from, change.to);
        detail.replaceChildren();
        function field(label: string, value: string) {
          const wrapper = element('label', label), area = element('textarea');
          area.readOnly = true; area.value = value; wrapper.append(area); detail.append(wrapper);
          return area;
        }
        const context = after.slice(Math.max(0, change.from - 120), change.from).trimEnd();
        detail.append(element('p', context ? 'Preceding text: ' + context : 'At the start of the scene.'));
        const source = field('Earlier passage', change.older);
        const target = field(live ? 'Current passage' : 'Compared passage', destination);
        if (!live) return;
        let custom = false;
        const customize = element('button', 'Choose a smaller selection');
        const help = element('p');
        const restore = element('button', 'Restore this passage');
        customize.onclick = () => {
          custom = true; customize.hidden = true;
          help.textContent = 'Select the exact earlier text, then select the current text to replace or place the cursor where it should go.';
          restore.textContent = 'Review selected restore…'; source.focus();
        };
        restore.onclick = () => {
          if (custom && source.selectionStart === source.selectionEnd) {
            status.textContent = 'Select text in Earlier passage first.'; source.focus(); return;
          }
          const start=change.olderFrom+(custom?rawOffset(change.older,source.selectionStart):0);
          const end=change.olderFrom+(custom?rawOffset(change.older,source.selectionEnd):change.older.length);
          const text = before.slice(start, end);
          const from = custom ? change.from + rawOffset(destination, target.selectionStart) : change.from;
          const to = custom ? change.from + rawOffset(destination, target.selectionEnd) : change.to;
          const apply = () => {
            if (options.restore(from, to, text)) finish();
            else { status.textContent = 'The scene changed or is unavailable. Reopen history to compare the latest text.'; restore.disabled = true; close.focus(); }
          };
          if (custom || text!==before.slice(start,end)) confirmSelection(dialog, restore, after, from, to, text, apply);
          else apply();
        };
        if (change.older) detail.append(customize);
        detail.append(help, restore);
      }
      changePicker.onchange = renderPassage;
      renderPassage();
      status.textContent = `${changes.length} changed ${changes.length === 1 ? 'passage' : 'passages'}.`;
    } catch (reason) { if (ticket === request) error(reason); }
  }

  void options.list().then(items => {
    if (!dialog.open) return;
    versions = items;
    if (!items.length) { status.textContent = 'No earlier versions yet. Saving a change keeps the previous scene text on this Mac.'; return; }
    later.add(new Option('Current scene, including unsaved edits', 'current'));
    items.forEach((item, i) => {
      const name = `${new Date(item.savedAt).toLocaleString()} · version ${items.length - i}`;
      earlier.add(new Option(name, String(i))); later.add(new Option(name, String(i)));
    });
    picker('Earlier version', earlier); picker('Compare with', later);
    earlier.onchange = later.onchange = () => void compare();
    void compare();
  }).catch(error);
}
