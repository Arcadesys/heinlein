// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {mountStudio} from './studio';
import type {Document, DraftingState, LocalCore} from './localCore';

const session={id:'export-fixture',name:'Synthetic book',manifests:[]};
const documentFor=(path:string,text='Disk source.'):Document=>({path,text,contentHash:'hash',sizeBytes:text.length,frontmatter:null,generatedCompatibility:false});
const state:DraftingState={manifestPath:'ms/manuscript.json',revision:'r',project:'Synthetic book',groups:[{id:'g',title:'Group'}],scenes:[{id:'s',title:'Scene',path:'ms/scene.md',groupId:'g'}],untrackedPaths:[],missingPaths:[]};
let app:ReturnType<typeof mountStudio>;
beforeEach(()=>{
  localStorage.clear();document.body.replaceChildren();
  Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect=()=>new DOMRect();
  HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};
  HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};
});
afterEach(()=>app?.destroy());

it('exports the live author buffer while an ordinary save/recovery snapshot is in flight, without issuing another source write',async()=>{
  let finishSave!:(doc:Document)=>void;
  const pending=new Promise<Document>(resolve=>{finishSave=resolve;});
  const saveDocument=vi.fn(()=>pending);const saveMarkdownExport=vi.fn(async()=>true);
  const core={available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>[],openRecentRepository:async()=>session,
    listDirectory:async()=>[],loadManuscript:async()=>{throw Error('None');},readDocument:async(_id:string,path:string)=>documentFor(path),
    saveDocument,saveMarkdownExport,readRecovery:async()=>null,stageRecovery:async(_id:string,path:string,baseHash:string,text:string)=>({id:'draft',path,baseHash,text,updatedAt:0}),discardRecovery:async()=>{},
    setUnsavedChanges:async()=>{},requestClose:async()=>{},onCloseRequested:async()=>()=>{},listSystemFonts:async()=>[],loadDrafting:async()=>state,
    previewDraftingChange:vi.fn(),applyDraftingChange:vi.fn(),undoDraftingChange:vi.fn()} as unknown as LocalCore;
  app=mountStudio(document.body,core);await app.selectRepository(async()=>session);await app.showDocument('ms/scene.md');
  const view=EditorView.findFromDOM(document.querySelector('.active-document-pane .cm-editor') as HTMLElement)!;
  const current='Live — 🐺.\n\nPunch.'; view.dispatch({changes:{from:0,to:view.state.doc.length,insert:current}});
  const saving=app.saveCurrent(); await vi.waitFor(()=>expect(saveDocument).toHaveBeenCalledOnce());
  const menu=document.querySelector('summary[aria-label="Actions for Group"]')!.parentElement as HTMLDetailsElement;
  menu.open=true;menu.dispatchEvent(new Event('toggle'));
  [...document.querySelectorAll<HTMLButtonElement>('.row-menu-items button')].find(button=>button.textContent==='Export group…')!.click();
  const choose=()=>[...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button=>button.textContent==='Choose export location…');
  await vi.waitFor(()=>expect(choose()?.disabled).toBe(false)); choose()!.click();
  await vi.waitFor(()=>expect(saveMarkdownExport).toHaveBeenCalledOnce());
  expect(saveMarkdownExport.mock.calls[0]).toEqual(['export-fixture','Group.md',`# Group\n\n## Scene\n\n${current}\n\n`]);
  expect(saveDocument).toHaveBeenCalledOnce();expect(view.state.doc.toString()).toBe(current);
  finishSave(documentFor('ms/scene.md',current));await saving;
});

it('puts manuscript export before recent projects and provides a visible direct entry',async()=>{
 const core={available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>Array.from({length:12},(_,n)=>({id:`recent-${n}`,name:`Synthetic recent ${n}`})),openRecentRepository:vi.fn(async()=>session),listDirectory:async()=>[],loadManuscript:async()=>{throw Error('None');},readDocument:async(_id:string,path:string)=>documentFor(path),saveDocument:vi.fn(),saveMarkdownExport:vi.fn(async()=>true),readRecovery:async()=>null,stageRecovery:vi.fn(),discardRecovery:vi.fn(),setUnsavedChanges:async()=>{},requestClose:async()=>{},onCloseRequested:async()=>()=>{},listSystemFonts:async()=>[],loadDrafting:async()=>state,previewDraftingChange:vi.fn(),applyDraftingChange:vi.fn(),undoDraftingChange:vi.fn()} as unknown as LocalCore;
 app=mountStudio(document.body,core);await app.selectRepository(async()=>session);await app.showDocument('ms/scene.md');
 expect(document.querySelector<HTMLButtonElement>('.tree-project > .project-export')!.hidden).toBe(false);
 const menu=document.querySelector<HTMLDetailsElement>('details.project-menu')!;menu.open=true;menu.dispatchEvent(new Event('toggle'));
 const actions=document.querySelector('.row-menu-items[aria-label="Project actions"]')!;expect(actions.querySelector('button')?.textContent).toBe('Export manuscript…');
 [...actions.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='Export manuscript…')!.click();
 await vi.waitFor(()=>expect(document.querySelector('dialog[aria-label="Export manuscript"]')).not.toBeNull());expect(core.openRecentRepository).not.toHaveBeenCalled();
});
