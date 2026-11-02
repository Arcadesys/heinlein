import {describe, expect, it, vi} from 'vitest';
import {captureLibraryScope} from './librarySnapshot';
import type {Document, DraftingState} from './localCore';
const state: DraftingState = {manifestPath:'ms/manuscript.json',revision:'r',project:'Synthetic',groups:[{id:'g',title:'Group'}],scenes:[{id:'a',title:'A',path:'ms/a.md',groupId:'g'},{id:'b',title:'B',path:'ms/b.md',groupId:'g'}],library:[{id:'g',kind:'group',parentId:null},{id:'b',kind:'scene',parentId:'g'},{id:'a',kind:'scene',parentId:'g'}],untrackedPaths:[],missingPaths:[]};
const doc = (path:string,text:string): Document => ({path,text,sizeBytes:text.length,contentHash:'a'.repeat(64),frontmatter:null,generatedCompatibility:false});
const selection = {contextSheets:['a'],contextGroups:['g'],targetSheets:['a'],targetGroups:[]};
describe('library revision snapshots', () => {
  it('deduplicates in library order and keeps context distinct from targets and active buffer', async () => {
    const read = vi.fn(async (path:string) => doc(path,'disk'));
    const scope = await captureLibraryScope(state,selection,{id:'a',document:doc('ms/a.md','unsaved')},read);
    expect(scope.context.map(s=>s.sceneId)).toEqual(['b','a']);
    expect(scope.targets.map(s=>s.sceneId)).toEqual(['a']);
    expect(scope.targets[0].source).toBe('unsaved'); expect(read).toHaveBeenCalledTimes(1);
  });
  it('fails rather than omitting oversized, missing or generated sources', async () => {
    await expect(captureLibraryScope(state,selection,null,async path=>doc(path,'long'),3)).rejects.toThrow(/Choose fewer/);
    await expect(captureLibraryScope(state,{...selection,targetSheets:['missing']},null,async path=>doc(path,'x'))).rejects.toThrow(/no longer/);
    await expect(captureLibraryScope(state,selection,null,async path=>({...doc(path,'x'),generatedCompatibility:true}))).rejects.toThrow(/generated/);
  });
  it('keeps the old flat sheet order when an existing library has not been reorganized', async () => {
    const result = await captureLibraryScope({...state, libraryLegacy:true}, {...selection,targetGroups:['g']}, null, async path => doc(path,'Synthetic'));
    expect(result.ordered.map(item => item.sceneId)).toEqual(['a','b']);
  });
});
