import {openSceneHistory} from '../../../src/sceneHistory';
import {createEditor} from '../../../src/editor';
import {emit} from '@tauri-apps/api/event';
import {createDraftingPanel} from '../../../src/draftingPanel';
import {localCore} from '../../../src/localCore';
import '../../../src/style.css';
const config=(globalThis as any).__SCENE_FIXTURE__ as {repositoryId:string;phase:string};
const root=document.querySelector('main')!;
const assert=(ok:unknown,label:string)=>{if(!ok)throw Error(label);};
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(check:()=>boolean){for(let i=0;i<300;i++){if(check())return;await tick();}throw Error('Fixture wait timed out');}
let changes=0,previews=0,applies=0;
const core={...localCore,
 previewDraftingChange:async(...args:Parameters<NonNullable<typeof localCore.previewDraftingChange>>)=>{previews++;return localCore.previewDraftingChange!(...args);},
 applyDraftingChange:async(...args:Parameters<NonNullable<typeof localCore.applyDraftingChange>>)=>{applies++;return localCore.applyDraftingChange!(...args);},
};
const panel=createDraftingPanel(core,{
 root,repository:()=>({id:config.repositoryId,name:'Disposable scene fixture'} as any),
 run:async action=>{await action();},show:()=>{},open:()=>{},
 changed:async()=>{changes++;},report:(message,error)=>{if(error)throw Error(message);},
});
root.append(panel.element);
function button(label:string,parent:ParentNode=document){const b=[...parent.querySelectorAll('button')].find(b=>b.textContent===label);assert(b,`Missing ${label}`);return b!;}
async function action(label:string){
 const menu=document.querySelector<HTMLElement>('summary[aria-label="Actions for anchor"]')!.parentElement as HTMLDetailsElement;
 menu.querySelector('summary')!.click();await until(()=>menu.open);
 button(label,document.querySelector('.row-menu-items[aria-label="Actions for anchor"]')!).click();
 await until(()=>!!document.querySelector('dialog[open]'));
}
async function runHistory(){
 const finalPath='ms/part-two/renamed.md';
 const expected='Exact — e\u0301 🦊 writing.\r\nNewer writing stays.\r\n';
 if(config.phase==='history-first') {
  let doc=await localCore.readDocument(config.repositoryId,'ms/anchor.md');
  const current=doc.text.replace('e\u0301','XX')+'Newer writing stays.\r\n';
  await localCore.saveDocument(config.repositoryId,doc.path,doc.contentHash,current);
  for(const change of [
   {kind:'renameFile',sourcePath:'ms/anchor.md',path:'ms/renamed.md'},
   {kind:'moveScene',sceneId:(await localCore.loadDrafting!(config.repositoryId)).scenes.find(s=>s.title==='anchor')!.id,path:finalPath},
  ] as const) {
   const state=await localCore.loadDrafting!(config.repositoryId);
   const plan=await localCore.previewDraftingChange!(config.repositoryId,state.revision,change).catch(error=>{throw Error(`${change.kind} preview: ${error}`);});
   await localCore.applyDraftingChange!(config.repositoryId,plan.id).catch(error=>{throw Error(`${change.kind} apply: ${error}`);});
  }
  doc=await localCore.readDocument(config.repositoryId,finalPath);
  const host=document.createElement('section');root.append(host);
  const editor=createEditor(host,doc.text,()=>{},()=>{});
  let restored=0;
  openSceneHistory({root,title:finalPath,current:doc.text,
   list:()=>localCore.sceneVersions!(config.repositoryId,finalPath),
   read:v=>localCore.readSceneVersion!(config.repositoryId,finalPath,v),
   restore:(from,to,text)=>{editor.restorePassage(from,to,text);restored++;return true;},
   focus:()=>editor.view.focus(),
  });
  await until(()=>!!document.querySelector('.scene-history textarea'));
  button('Choose a smaller selection').click();
  const areas=document.querySelectorAll<HTMLTextAreaElement>('.scene-history textarea');
  const from=areas[0].value.indexOf('e\u0301'),to=areas[1].value.indexOf('XX');
  assert(from>=0&&to>=0,'Exact historical/current selection available after native move');
  areas[0].setSelectionRange(from,from+2);areas[1].setSelectionRange(to,to+2);
  button('Review selected restore…').click();
  assert(restored===0&&editor.text()===doc.text,'Preview cannot mutate text');
  button('Back to selection').click();assert(restored===0,'Cancel preserves exact scene');
  button('Review selected restore…').click();button('Confirm replacement').click();
  assert(restored===1&&editor.text()===expected,'Only chosen passage restored, newer bytes retained');
  await localCore.saveDocument(config.repositoryId,finalPath,doc.contentHash,editor.text());
  editor.destroy();host.remove();
 }
 const persisted=await localCore.readDocument(config.repositoryId,finalPath);
 assert(persisted.text===expected,'Restored bytes persist across native process restart');
 const versions=await localCore.sceneVersions!(config.repositoryId,finalPath);
 assert(versions.length===2,'Native moved history persists across restart');
 const original=await localCore.readSceneVersion!(config.repositoryId,finalPath,versions[1]);
 assert(original==='Exact — e\u0301 🦊 writing.\r\n','Original history remains readable');
 await emit('scene-fixture-finish');
}
async function run(){
 if(config.phase.startsWith('history-')){await runHistory();return;}
 await panel.load();
 const initial=structuredClone(panel.state);
 if(config.phase==='first'){
  for(const label of ['Add scene above','Add scene below']){
   await action(label);button('Cancel',document.querySelector('dialog')!).click();
   assert(!document.querySelector('dialog'),'Cancel closes modal');
   assert(previews===0&&applies===0,'Cancel never sends a mutation');
   assert(JSON.stringify(await localCore.loadDrafting!(config.repositoryId))===JSON.stringify(initial),'Cancel retains exact native state');
  }
  for(const [label,title] of [['Add scene above','Above 1'],['Add scene below','Below 1'],['Add scene above','Above 2'],['Add scene below','Below 2']]){
   const previous=changes;await action(label);
   const dialog=document.querySelector('dialog')!;dialog.querySelector('input')!.value=title;
   button('Create scene',dialog).click();await until(()=>changes===previous+1);
   assert(!document.querySelector('dialog'),'Submit closes modal');
  }
  assert(previews===4&&applies===4,'Exactly one preview and apply per creation');
 }
 await panel.load();
 assert(JSON.stringify(panel.state!.scenes.map(s=>s.title))===JSON.stringify(['Above 1','Above 2','anchor','Below 2','Below 1','missing']),'Native order after creation/reopen');
 assert(panel.state!.untrackedPaths.join()==='ms/notes.md','Unlisted notes retained');
 assert(panel.state!.missingPaths.join()==='ms/missing.md','Missing metadata retained');
 await emit('scene-fixture-finish');
}
window.addEventListener('unhandledrejection',e=>{void emit('scene-fixture-failed',String(e.reason));});
void run().catch(e=>emit('scene-fixture-failed',String(e)));
