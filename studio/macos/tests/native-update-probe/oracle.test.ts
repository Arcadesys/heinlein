// @vitest-environment jsdom
import {expect,it} from 'vitest';
import {createEditor} from '../../../src/editor';
import {seed,addition,expected} from '../native-standalone-probe/ack';
import {visibleSeed,visibleExpected} from './oracle';
it('separates production LF display from exact mixed-newline source before/after edits',()=>{
  const editor=createEditor(document.createElement('div'),seed,()=>{},()=>{});
  try{
    expect(editor.view.state.doc.toString()).toBe(visibleSeed);
    expect(editor.view.state.doc.toString()).not.toBe(seed); // Reproduces the faulty fixture comparison.
    expect(editor.text()).toBe(seed);
    editor.view.dispatch({changes:{from:editor.view.state.doc.length,insert:addition}});
    expect(editor.view.state.doc.toString()).toBe(visibleExpected);
    expect(editor.text()).toBe(expected);
    expect(editor.text().slice(0,seed.length)).toBe(seed);
  }finally{editor.destroy();}
});
