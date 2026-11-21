import { imageMarkdown } from './illustrationLinks';
import type { EditorView } from '@codemirror/view';
import { isolateHistory } from '@codemirror/commands';
import type { LocalCore } from './localCore';

export interface PickedImage {
  id: string;
  name: string;
  width: number;
  height: number;
}
export interface ImageHost {
  pick(project: string, scene: string): Promise<PickedImage | null>;
  read(project: string, scene: string, url: string): Promise<string>;
  commit(project: string, scene: string, id: string): Promise<string>;
  describe(project: string, scene: string, id: string): Promise<string>;
  discard(project: string, scene: string, id: string): Promise<void>;
}

export async function insertIllustration(
  root: HTMLElement,
  core: LocalCore,
  project: string,
  scene: string,
  view: EditorView,
  editable: () => boolean,
  report: (message: string) => void
) {
  const host = core.images;
  if (!host || !editable()) return;
  let capturedDoc = view.state.doc;
  const initialDoc = capturedDoc;
  const initialSelection = view.state.selection;
  function returnToEditor(restoreSelection: boolean) {
    if (!editable()) return;
    view.focus();
    if (restoreSelection && view.state.doc === initialDoc && !view.state.selection.eq(initialSelection))
      view.dispatch({ selection: initialSelection });
  }
  let selection = initialSelection.main;
  let offset = selection.to,
    selected = !selection.empty;
  let pick: PickedImage | null;
  try {
    pick = await host.pick(project, scene);
  } catch (error) {
    report(String(error));
    return;
  }
  // The native picker returns focus to its invoking window. Keep the editor selection intact.
  if (!pick) return;
  const id = pick.id;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {
    const node = window.document.createElement(tag);
    node.textContent = text;
    return node;
  };
  const dialog = el('dialog');
  dialog.className = 'appearance-dialog scene-history illustration-dialog';
  dialog.setAttribute('aria-label', 'Insert illustration');
  const position = el('p'),
    label = el('label', 'Image description'),
    description = el('textarea');
  description.maxLength = 4000;
  label.append(description);
  const decorativeLabel = el('label'),
    decorative = el('input');
  decorative.type = 'checkbox';
  decorativeLabel.append(decorative, ' Decorative image');
  const ai = el('button', 'Draft description with AI'),
    disclosure = el('p', 'Drafting sends a copy of this image with metadata removed to OpenAI.');
  const status = el('p');
  status.setAttribute('role', 'status');
  const choose = el('button', 'Choose new insertion point'),
    point = el('textarea'),
    pointLabel = el('label', 'Select a new position in the current scene');
  point.readOnly = true;
  pointLabel.append(point);
  pointLabel.hidden = true;
  const insert = el('button', 'Insert image'),
    cancel = el('button', 'Cancel');
  let busy = false,
    describing = false,
    choosing = false;
  const current = () =>
    editable() && view.state.doc === capturedDoc && selection.eq(view.state.selection.main);
  function update() {
    const line = capturedDoc.lineAt(offset);
    position.textContent = `${selected ? 'After selected prose' : 'At cursor'} in ${scene}, line ${line.number}, column ${Array.from(line.text.slice(0, offset - line.from)).length + 1}.`;
    const stale = !current();
    choose.hidden = !choosing && !stale;
    choose.disabled = busy || !editable();
    insert.disabled =
      busy || describing || choosing || stale || (!decorative.checked && !description.value.trim());
    description.disabled = busy || decorative.checked;
    ai.disabled = busy || describing || decorative.checked;
    if (stale && !choosing)
      status.textContent =
        'The scene or selection changed. Choose a new insertion point. Your description is kept.';
  }
  function close(restoreSelection = true) {
    dialog.close();
    dialog.remove();
    void host!.discard(project, scene, id).catch(() => {});
    returnToEditor(restoreSelection);
  }
  choose.onclick = () => {
    if (!editable()) {
      update();
      return;
    }
    if (!choosing || point.value !== view.state.doc.toString()) {
      point.value = view.state.doc.toString();
      pointLabel.hidden = false;
      choosing = true;
      choose.textContent = 'Use selected position';
      status.textContent = 'Place the cursor or select prose. The image goes after the selection.';
      update();
      point.focus();
      return;
    }
    capturedDoc = view.state.doc;
    selection = view.state.selection.main;
    offset = point.selectionEnd;
    selected = point.selectionStart !== point.selectionEnd;
    choosing = false;
    pointLabel.hidden = true;
    choose.textContent = 'Choose new insertion point';
    status.textContent = 'Insertion point updated.';
    update();
    description.focus();
  };
  description.oninput = update;
  decorative.onchange = update;
  ai.onclick = async () => {
    describing = true;
    const original = description.value;
    update();
    status.textContent = 'Drafting description with OpenAI…';
    try {
      const draft = await host.describe(project, scene, id);
      if (dialog.open) {
        if (description.value === original) {
          description.value = draft;
          status.textContent = 'Draft ready. Review and edit the image description.';
        } else {
          status.textContent =
            'Your description changed while OpenAI was drafting. Your wording was kept.';
        }
      }
    } catch (error) {
      if (dialog.open)
        status.textContent = `Description unavailable. You can type your own. ${String(error)}`;
    } finally {
      describing = false;
      if (dialog.open) {
        update();
        description.focus();
      }
    }
  };
  insert.onclick = async () => {
    if (!current()) {
      update();
      choose.focus();
      return;
    }
    busy = true;
    update();
    cancel.disabled = true;
    decorative.disabled = true;
    try {
      const url = await host.commit(project, scene, id);
      if (!current()) {
        status.textContent = 'Choose a new insertion point.';
        return;
      }
      const markdown = imageMarkdown(decorative.checked ? '' : description.value.trim(), url);
      view.dispatch({
        changes: { from: offset, insert: markdown },
        selection: { anchor: offset + markdown.length },
        annotations: isolateHistory.of('full'),
        userEvent: 'input.illustration'
      });
      close(false);
      report('Illustration inserted.');
    } catch (error) {
      status.textContent = String(error);
    } finally {
      busy = false;
      if (dialog.open) {
        cancel.disabled = false;
        decorative.disabled = false;
        update();
      }
    }
  };
  dialog.oncancel = (e) => {
    e.preventDefault();
    if (!busy) close();
  };
  cancel.onclick = () => close();
  dialog.append(
    el('h2', 'Insert illustration'),
    el('p', `${pick.name}, ${pick.width} by ${pick.height} pixels`),
    position,
    label,
    decorativeLabel,
    disclosure,
    ai,
    status,
    pointLabel,
    choose,
    insert,
    cancel
  );
  root.append(dialog);
  dialog.showModal();
  update();
  description.focus();
  // A structural operation or later editor transaction can invalidate the captured position.
  const check = window.setInterval(() => {
    if (!dialog.isConnected && dialog.open) close(false);
    if (!dialog.open) {
      window.clearInterval(check);
      return;
    }
    if (!current() && !choosing && choose.hidden) update();
  }, 250);
}
