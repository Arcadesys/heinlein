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
async function run(){
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
