import '../../src/style.css';
import {createDraftingPanel} from '../../src/draftingPanel';
import type {DraftingChange,DraftingState,LocalCore} from '../../src/localCore';
const key='heinlein-pointer-fixture';
const initial:DraftingState={manifestPath:'ms/manuscript.json',revision:'1',project:'Synthetic drag check',groups:[{id:'opening',title:'Opening'},{id:'ending',title:'Ending'}],scenes:[{id:'a',title:'Alpha',path:'ms/a.md',groupId:'opening'},{id:'b',title:'Beta',path:'ms/b.md',groupId:'opening'},{id:'c',title:'Gamma',path:'ms/c.md',groupId:'ending'}],library:[{id:'opening',kind:'group',parentId:null},{id:'a',kind:'scene',parentId:'opening'},{id:'b',kind:'scene',parentId:'opening'},{id:'ending',kind:'group',parentId:null},{id:'c',kind:'scene',parentId:'ending'}],untrackedPaths:[],missingPaths:[]};
if (new URLSearchParams(location.search).has('long')) {
 for (let i=0;i<30;i++) { const id=`extra-${i}`; initial.scenes.push({id,title:`Extra ${i}`,path:`ms/${id}.md`,groupId:'opening'}); initial.library!.splice(initial.library!.findIndex(e=>e.id==='ending'),0,{id,kind:'scene',parentId:'opening'}); }
}
let state:DraftingState=JSON.parse(localStorage.getItem(key)??JSON.stringify(initial));
let change:DraftingChange;
const core={loadDrafting:async()=>structuredClone(state),previewDraftingChange:async(_id:string,_revision:string,c:DraftingChange)=>{change=c;return{id:'preview',summary:'Organize',changes:[],warnings:[]};},applyDraftingChange:async()=>{
 if(change.kind!=='organizeLibrary')throw Error('Only library metadata is allowed');
 const scenes=state.scenes.map(s=>({...s,title:change.kind==='organizeLibrary'?change.sceneTitles.find(t=>t.id===s.id)!.title:s.title,groupId:change.kind==='organizeLibrary'?change.entries.find(e=>e.id===s.id)!.parentId:s.groupId}));
 const ordered:typeof scenes=[];const entries=change.entries;
 const walk=(parent:string|null)=>{for(const e of entries.filter(e=>e.parentId===parent)){if(e.kind==='group')walk(e.id);else ordered.push(scenes.find(s=>s.id===e.id)!);}};walk(null);
 state={...state,revision:String(Number(state.revision)+1),groups:change.groups,scenes:ordered,library:entries};localStorage.setItem(key,JSON.stringify(state));return{state:structuredClone(state),undoId:null};
},undoDraftingChange:async()=>state} as unknown as LocalCore;
const root=document.querySelector<HTMLElement>('#app')!;
const panel=createDraftingPanel(core,{root,repository:()=>({id:'fixture',name:'Synthetic drag check',manifests:[]}),run:async fn=>fn(),show:()=>{},open:path=>{document.querySelector('#opened')!.textContent=path;},changed:async()=>{},report:message=>{document.querySelector('#status')!.textContent=message;}});
root.append(panel.element);if(new URLSearchParams(location.search).has('long')){panel.element.style.height='300px';panel.element.style.overflowY='auto';}void panel.load();
