import '../../src/style.css';
import {createDraftingPanel} from '../../src/draftingPanel';
import type {DraftingState, LocalCore} from '../../src/localCore';
const state: DraftingState = {manifestPath:'ms/manuscript.json',revision:'fixture',project:'Synthetic book',groups:[{id:'g',title:'Group'},{id:'n',title:'Nested'}],scenes:[{id:'a',title:'First',path:'ms/a.md',groupId:'g'},{id:'b',title:'Second',path:'ms/b.md',groupId:'n'}],library:[{id:'g',kind:'group',parentId:null},{id:'n',kind:'group',parentId:'g'},{id:'b',kind:'scene',parentId:'n'},{id:'a',kind:'scene',parentId:'g'}],untrackedPaths:[],missingPaths:[]};
const core = {loadDrafting:async()=>state,readDocument:async()=>({text:'Synthetic prose'}),previewDraftingChange:async()=>({id:'preview',summary:'Organize',changes:[],warnings:[]}),applyDraftingChange:async()=>({state,undoId:'undo'}),undoDraftingChange:async()=>state} as unknown as LocalCore;
const root = document.querySelector<HTMLElement>('#app')!;
const panel = createDraftingPanel(core,{root,repository:()=>({id:'fixture',name:'Synthetic book',manifests:[]}),run:async action=>action(),show:()=>{},open:()=>{},changed:async()=>{},report:()=>{}});
root.append(panel.element); void panel.load();
