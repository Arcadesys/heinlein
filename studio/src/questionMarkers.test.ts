// @vitest-environment jsdom
import {afterEach, describe, expect, it} from 'vitest';
import {createEditor} from './editor';
let editor: ReturnType<typeof createEditor>;
afterEach(()=>{editor?.destroy();document.body.replaceChildren();});
describe('question passage decorations',()=>{
  it('converts raw CRLF anchors without changing source and clears markers on edits',()=>{
    const host=document.createElement('div');document.body.append(host);const source='Before\r\nRain — 🐺.\r\nAfter';editor=createEditor(host,source,()=>{},()=>{});
    const from=source.indexOf('Rain'),to=source.indexOf('\r\nAfter');
    editor.setPassages([{id:'one',from,to,label:'1 suggestion',active:true,open:()=>{}}]);editor.selectPassage(from,to);
    expect(editor.view.state.sliceDoc(editor.view.state.selection.main.from,editor.view.state.selection.main.to)).toBe('Rain — 🐺.');expect(editor.text()).toBe(source);
    expect(host.querySelector('.question-passage-chip')?.textContent).toBe('1 suggestion');
    editor.view.dispatch({changes:{from:0,insert:'x'}});expect(host.querySelector('.question-passage-chip')).toBeNull();
  });
  it('groups adjacent anchors into a single large target with a toolbar/pane equivalent',()=>{
    const host=document.createElement('div');document.body.append(host);editor=createEditor(host,'one\ntwo\nthree',()=>{},()=>{});
    editor.setPassages([{id:'one',from:0,to:3,label:'Answer ready',active:false,open:()=>{}},{id:'two',from:4,to:7,label:'1 suggestion',active:false,open:()=>{}}]);
    expect(host.querySelectorAll('.question-passage-chip')).toHaveLength(1);expect(host.querySelector('.question-passage-chip')?.textContent).toBe('2 passages');
    expect(host.querySelector<HTMLButtonElement>('.question-passage-chip')?.tabIndex).toBe(-1);
  });
});
