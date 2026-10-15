// @vitest-environment jsdom
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createEditor, rawOffset} from './editor';
import {createSelectionAskAction} from './selectionAsk';
import type {SelectionQuestionState} from './selectionQuestion';
let editor: ReturnType<typeof createEditor> | undefined;
let action: ReturnType<typeof createSelectionAskAction> | undefined;
let source: string; let revision: number; let repositoryId: string; let blocked: boolean;
const ask = vi.fn(); const stale = vi.fn();
function current(): SelectionQuestionState | null {
  if (!editor) return null;
  const range = editor.view.state.selection.main;
  return {repositoryId, path: 'scene.md', sceneId: 'scene', source, from: rawOffset(source, range.from), to: rawOffset(source, range.to), revision, documentEpoch: 1, sourceHash: 'hash', readOnly: editor.view.state.readOnly, recoveryPending: blocked, busy: false, detached: false};
}
async function start() {
  const host = document.createElement('div'); const fallback = document.createElement('button'); document.body.append(host, fallback);
  editor = createEditor(host, source, text => {source = text; revision++;}, () => {});
  vi.spyOn(editor.view.dom, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  const coords = vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({top: 200, bottom: 220, left: 300, right: 301});
  action = createSelectionAskAction(editor.view, {current, ask, stale, fallback});
  editor.view.focus(); editor.view.dispatch({selection: {anchor: 2, head: 12}});
  await vi.waitFor(() => expect(action!.element.hidden).toBe(false)); return {coords, fallback};
}
beforeEach(() => {
  document.body.replaceChildren(); source = 'A passage with words.\r\nAnd a second line.'; revision = 0; repositoryId = 'repository'; blocked = false; ask.mockReset(); stale.mockReset();
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => {action?.destroy(); action = undefined; editor?.destroy(); editor = undefined; vi.restoreAllMocks();});
describe('contextual Ask Heinlein selection control', () => {
  it('appears for a highlighted passage and never asks automatically', async () => {
    const {fallback} = await start(); expect(action!.element.textContent).toBe('Ask Heinlein'); expect(fallback.disabled).toBe(false);
    expect(action!.element.getAttribute('aria-label')).toContain('highlighted passage'); expect(action!.element.tabIndex).toBe(0); expect(ask).not.toHaveBeenCalled();
    action!.element.click(); expect(ask).toHaveBeenCalledOnce(); expect(ask.mock.calls[0][0]).toMatchObject({from: 2, to: 12, source});
  });
  it('preserves editor focus and exact selection on pointerdown', async () => {
    await start(); const before = editor!.view.state.selection;
    const pointer = new MouseEvent('pointerdown', {button: 0, bubbles: true, cancelable: true}); action!.element.dispatchEvent(pointer);
    expect(pointer.defaultPrevented).toBe(true); expect(document.activeElement).toBe(editor!.view.contentDOM); expect(editor!.view.state.selection).toBe(before);
    action!.element.click(); expect(ask.mock.calls[0][0].source.slice(ask.mock.calls[0][0].from, ask.mock.calls[0][0].to)).toBe(source.slice(2, 12));
  });
  it('invalidates a visible action synchronously when the selection changes', async () => {
    await start(); editor!.view.dispatch({selection: {anchor: 5, head: 5}});
    expect(action!.element.hidden).toBe(true); action!.element.click(); expect(ask).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(action!.element.hidden).toBe(true));
  });
  it('rejects source, revision, or repository changes even before a repaint', async () => {
    await start(); repositoryId = 'different'; action!.element.click(); expect(ask).not.toHaveBeenCalled(); expect(stale).toHaveBeenCalledOnce();
    repositoryId = 'repository'; action!.refresh(); await vi.waitFor(() => expect(action!.element.hidden).toBe(false));
    revision++; action!.element.click(); expect(ask).not.toHaveBeenCalled(); expect(stale).toHaveBeenCalledTimes(2);
  });
  it('uses the visible end of a multiline selection and clamps the action at viewport edges', async () => {
    const {coords} = await start();
    editor!.view.dispatch({selection: {anchor: 2, head: editor!.view.state.doc.length}});
    coords.mockReturnValue({top: 1, bottom: 21, left: window.innerWidth - 2, right: window.innerWidth - 1});
    vi.spyOn(action!.element, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 190, 60)); action!.refresh();
    await vi.waitFor(() => expect(Number.parseFloat(action!.element.style.left)).toBe(window.innerWidth - 198));
    expect(Number.parseFloat(action!.element.style.top)).toBe(29);
    coords.mockImplementation(position => position === editor!.view.state.selection.main.head ? {top: -100, bottom: -80, left: 40, right: 41} : {top: 180, bottom: 200, left: 80, right: 81});
    document.dispatchEvent(new Event('scroll')); await vi.waitFor(() => expect(Number.parseFloat(action!.element.style.left)).toBe(80));
  });
  it('repositions on scroll/resize and hides when the selection is outside the viewport', async () => {
    const {coords, fallback} = await start(); coords.mockReturnValue({top: 350, bottom: 370, left: 450, right: 451});
    document.dispatchEvent(new Event('scroll')); await vi.waitFor(() => expect(action!.element.style.left).toBe('450px'));
    coords.mockReturnValue({top: -100, bottom: -80, left: 40, right: 41}); window.dispatchEvent(new Event('resize'));
    await vi.waitFor(() => expect(action!.element.hidden).toBe(true)); expect(fallback.disabled).toBe(false);
  });
  it('hides on focus leaving the editor but remains keyboard-focusable itself', async () => {
    await start(); action!.element.focus(); action!.refresh(); await new Promise(resolve => setTimeout(resolve, 30)); expect(action!.element.hidden).toBe(false);
    const outside = document.createElement('button'); document.body.append(outside); outside.focus(); await vi.waitFor(() => expect(action!.element.hidden).toBe(true));
  });
  it('disables both controls for read-only, recovery, and empty selections', async () => {
    const {fallback} = await start(); editor!.setEditable(false); await vi.waitFor(() => expect(fallback.disabled).toBe(true)); expect(action!.element.hidden).toBe(true);
    editor!.setEditable(true); blocked = true; action!.refresh(); await vi.waitFor(() => expect(fallback.disabled).toBe(true));
    blocked = false; editor!.view.dispatch({selection: {anchor: 2, head: 2}}); action!.refresh(); await vi.waitFor(() => expect(fallback.disabled).toBe(true));
  });
  it('removes the portal and ignores queued layout callbacks after destroy', async () => {
    await start(); document.dispatchEvent(new Event('scroll')); action!.destroy(); await new Promise(resolve => setTimeout(resolve, 30));
    expect(document.querySelector('.selection-ask-action')).toBeNull(); expect(ask).not.toHaveBeenCalled();
  });
});
