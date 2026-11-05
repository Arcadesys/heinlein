// @vitest-environment jsdom
import {afterEach, describe, expect, it, vi} from 'vitest';
import {EditorState, Transaction} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {createTypingChrome, isWritingInput} from './typingChrome';

const cleanup: (() => void)[] = [];
afterEach(() => {cleanup.splice(0).reverse().forEach(run => run());document.body.replaceChildren();vi.restoreAllMocks();});
function fixture() {
  const root = document.createElement('main'), pane = document.createElement('section'), controls = document.createElement('nav');
  const tab = document.createElement('button');tab.textContent = 'Document';controls.append(tab);
  const canHide = vi.fn(() => true);
  const chrome = createTypingChrome({root,writerPane:pane,controls:[controls],canHide});
  root.append(chrome.element,pane);document.body.append(root);
  const view = new EditorView({parent:pane,state:EditorState.create({doc:'Original — prose.',extensions:[chrome.extension]})});
  view.focus();
  cleanup.push(() => {view.destroy();chrome.destroy();});
  const type = (event = 'input.type') => view.dispatch({changes:{from:0,insert:'x'},annotations:Transaction.userEvent.of(event)});
  const collapsed = () => chrome.element.classList.contains('is-typing');
  return {root,pane,controls,tab,chrome,view,type,collapsed,canHide};
}
describe('writing input classification', () => {
  const state = EditorState.create({doc:'prose'});
  for (const event of ['input.type','input.type.compose','delete.backward','delete.selection']) it(`recognizes ${event}`, () => {
    expect(isWritingInput([state.update({changes:{from:0,insert:'a'},annotations:Transaction.userEvent.of(event)})])).toBe(true);
  });
  for (const event of ['input.paste','input.drop','undo','redo','move.drop','select.pointer',undefined]) it(`ignores ${event ?? 'programmatic'} edits`, () => {
    expect(isWritingInput([state.update({changes:{from:0,insert:'a'},annotations:event?Transaction.userEvent.of(event):[]})])).toBe(false);
  });
  it('recognizes Enter replacing a multiline selection', () => {
    const selected = EditorState.create({doc:'first\nsecond\nthird'});
    expect(isWritingInput([selected.update({changes:{from:0,to:12,insert:'\n'},annotations:Transaction.userEvent.of('input')})])).toBe(true);
  });
  it('recognizes Enter but not an input annotation without an edit', () => {
    expect(isWritingInput([state.update({changes:{from:0,insert:'\n'},annotations:Transaction.userEvent.of('input')})])).toBe(true);
    expect(isWritingInput([state.update({selection:{anchor:2},annotations:Transaction.userEvent.of('input.type')})])).toBe(false);
  });
});
describe('typing chrome lifecycle', () => {
  it('preserves the writer and selection through repeated conceal/reveal and makes controls inert', () => {
    const f=fixture();
    for(let n=0;n<3;n++){
      f.type();expect(f.collapsed()).toBe(true);expect(f.controls.parentElement!.inert).toBe(true);
      const selection=f.view.state.selection,text=f.view.state.doc.toString();
      f.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      expect(f.collapsed()).toBe(false);expect(f.view.state.selection).toBe(selection);expect(f.view.state.doc.toString()).toBe(text);expect(f.view.hasFocus).toBe(true);
    }
  });
  it('ignores other editors, nonwriter focus, programmatic changes and blocked UI', () => {
    const f=fixture();
    f.type('input.paste');expect(f.collapsed()).toBe(false);
    f.canHide.mockReturnValue(false);f.type();expect(f.collapsed()).toBe(false);f.canHide.mockReturnValue(true);
    const dialog=document.createElement('dialog');dialog.open=true;f.root.append(dialog);f.type();expect(f.collapsed()).toBe(false);dialog.remove();
    f.tab.focus();f.type();expect(f.collapsed()).toBe(false);
    const chat=document.createElement('textarea');f.root.append(chat);chat.focus();chat.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:'hello'}));expect(f.collapsed()).toBe(false);
  });
  it('lets editor Escape handling and composition cancellation take priority', () => {
    const f=fixture();f.type();
    const consume=(e:Event)=>e.preventDefault();f.view.contentDOM.addEventListener('keydown',consume);
    f.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));expect(f.collapsed()).toBe(true);
    f.view.contentDOM.removeEventListener('keydown',consume);
    f.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,isComposing:true}));expect(f.collapsed()).toBe(true);
    f.chrome.reveal();f.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));f.type('input.type.compose');expect(f.collapsed()).toBe(false);
  });
  it('reveals on keyboard traversal, outside focus, explicit restore, and reset', () => {
    const f=fixture();f.type();f.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true}));expect(f.collapsed()).toBe(false);
    f.type();const chat=document.createElement('textarea');f.root.append(chat);chat.focus();expect(f.collapsed()).toBe(false);
    f.view.focus();f.type();const restore=f.chrome.element.querySelector<HTMLButtonElement>('.typing-chrome-reveal')!;restore.focus();restore.click();expect(f.collapsed()).toBe(false);expect(document.activeElement).toBe(f.tab);
    f.view.focus();f.type();f.chrome.reveal();expect(f.collapsed()).toBe(false);
  });
  it('clears an interrupted composition when a document is remounted', () => {
    const f=fixture();f.view.contentDOM.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));f.type('input.type.compose');expect(f.collapsed()).toBe(false);
    f.chrome.reveal();f.type();expect(f.collapsed()).toBe(true);
  });
  it('disposes listeners without leaving controls inert', () => {
    const f=fixture();f.type();f.chrome.destroy();expect(f.controls.parentElement!.inert).toBe(false);f.type();expect(f.collapsed()).toBe(false);
  });
});
