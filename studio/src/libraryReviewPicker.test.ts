// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {openLibraryReviewPicker} from './libraryReviewPicker';
import type {Document,DraftingState} from './localCore';
afterEach(()=>document.body.replaceChildren());
it('replaces the default active target when a different group is explicitly chosen',async()=>{
 const state:DraftingState={manifestPath:'ms/manuscript.json',revision:'r',project:'Synthetic',groups:[{id:'g',title:'Other group'}],scenes:[{id:'a',title:'Active',path:'ms/a.md',groupId:null},{id:'b',title:'Other',path:'ms/b.md',groupId:'g'}],library:[{id:'a',kind:'scene',parentId:null},{id:'g',kind:'group',parentId:null},{id:'b',kind:'scene',parentId:'g'}],untrackedPaths:[],missingPaths:[]};
 const documentFor=(path:string):Document=>({path,text:'Synthetic',sizeBytes:9,contentHash:'a'.repeat(64),frontmatter:null,generatedCompatibility:false});
 const ready=vi.fn();openLibraryReviewPicker({root:document.body,state,activeId:'a',active:()=>({id:'a',document:documentFor('ms/a.md')}),read:async path=>documentFor(path),ready});
 const group=[...document.querySelectorAll('fieldset')].find(node=>node.querySelector('legend')?.textContent==='Revision target groups, including descendants')!;
 group.querySelector('input')!.click();
 const active=[...document.querySelectorAll('label')].find(node=>node.textContent?.trim()==='Active' && node.closest('fieldset')?.querySelector('legend')?.textContent==='Revision target sheets')!.querySelector('input')!;
 expect(active.checked).toBe(false);
 [...document.querySelectorAll('button')].find(node=>node.textContent==='Prepare review')!.click();
 await vi.waitFor(()=>expect(ready).toHaveBeenCalledOnce());
 const [capture,,defaultTarget]=ready.mock.calls[0]; expect(capture.targets.map((item:{sceneId:string})=>item.sceneId)).toEqual(['b']); expect(capture.context.map((item:{sceneId:string})=>item.sceneId)).toEqual(['a']); expect(defaultTarget).toBe(false);
});
