import type {Chapter} from './localCore';
/** Session-only navigation identities. Inactive tabs never contain writing buffers. */
export interface DocumentTab {id:string;path:string;kind:'source'|'assembled';sceneId?:string;chapter?:Chapter;unavailable?:boolean;position?:{hash:string;anchor:number;head:number;scrollTop:number}}
export type TabTarget=Omit<DocumentTab,'id'>;
let nextId=0;
export function createDocumentTabs(hooks:{open(tab:DocumentTab):Promise<unknown>;close(tab:DocumentTab):Promise<unknown>;read(tab:DocumentTab):void}){
 let entries:DocumentTab[]=[];let activeId:string|undefined;let blocked=false;
 const element=document.createElement('nav');element.className='document-tabs';element.setAttribute('aria-label','Open documents');
 const same=(a:TabTarget,b:TabTarget)=>a.kind===b.kind&&(a.sceneId&&b.sceneId?a.sceneId===b.sceneId:a.path===b.path);
 function render(){
  const focused=(document.activeElement as HTMLElement|null)?.dataset.tabFocus;
  element.replaceChildren();element.hidden=!entries.length;
  const title=document.createElement('h2');title.textContent='Open documents';title.className='document-tabs-title';
  const list=document.createElement('div');list.setAttribute('role','tablist');list.setAttribute('aria-label','Open documents');list.setAttribute('aria-orientation','vertical');
  const area=document.createElement('div');area.className='document-tab-area';area.style.setProperty('--tab-count',String(entries.length));
  const actions=document.createElement('div');actions.className='document-tab-action-list';actions.setAttribute('role','group');actions.setAttribute('aria-label','Document tab actions');
  list.style.gridRow=actions.style.gridRow=`1 / span ${entries.length*2}`;
  for(const [index,tab] of entries.entries()){
   const row=document.createElement('div');row.className='document-tab-row';row.setAttribute('role','group');row.setAttribute('aria-label',`Actions for ${tab.path}`);row.style.setProperty('--tab-index',String(index));
   const b=document.createElement('button');b.type='button';b.id=tab.id;b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab.id===activeId));b.setAttribute('aria-controls','active-document-pane');b.tabIndex=!tab.unavailable&&tab.id===(activeId??entries.find(t=>!t.unavailable)?.id)?0:-1;if(tab.kind==='assembled')b.append(document.createTextNode('Assembled: '));for(const segment of tab.path.split(/(?<=[/\-])/)){b.append(document.createTextNode(segment),document.createElement('wbr'));}if(tab.unavailable)b.append(document.createTextNode(' · Unavailable'));b.disabled=blocked||!!tab.unavailable;b.dataset.tabFocus=tab.id;b.style.setProperty('--tab-index',String(index));
   b.addEventListener('click',()=>void activate(tab));b.addEventListener('keydown',event=>{
    const buttons=[...list.querySelectorAll<HTMLButtonElement>('[role=tab]')].filter(control=>!control.disabled);let index=buttons.indexOf(b);const key=event.key;
    if(!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End'].includes(key))return;event.preventDefault();index=key==='Home'?0:key==='End'?buttons.length-1:(index+(key==='ArrowRight'||key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
    buttons.forEach((control,i)=>control.tabIndex=i===index?0:-1);buttons[index].focus();
   });
   const close=document.createElement('button');close.type='button';close.textContent='Close';close.setAttribute('aria-label',`Close document ${tab.path}`);close.disabled=blocked;close.dataset.tabFocus=`close-${tab.id}`;close.addEventListener('click',()=>void hooks.close(tab));
   const read=document.createElement('button');read.type='button';read.dataset.tabFocus=`read-${tab.id}`;read.textContent='Read beside';read.setAttribute('aria-label',`Read beside active document: ${tab.path}`);read.disabled=blocked||tab.kind!=='source'||!!tab.unavailable;read.addEventListener('click',()=>hooks.read(tab));
   row.append(close,read);list.append(b);actions.append(row);
  }
  area.append(list,actions);element.append(title,area);if(focused)[...element.querySelectorAll<HTMLElement>('[data-tab-focus]')].find(e=>e.dataset.tabFocus===focused)?.focus({preventScroll:true});
 }
 function ensure(target:TabTarget){let tab=entries.find(t=>same(t,target));if(!tab){tab={...target,id:`document-tab-${++nextId}`};entries.push(tab);}else Object.assign(tab,target,{unavailable:false});return tab;}
 async function activate(tab:DocumentTab){if(!blocked&&!tab.unavailable&&entries.includes(tab))await hooks.open(tab);}
 return {element,items:()=>entries.slice(),active:()=>entries.find(t=>t.id===activeId),activate,
  register(target:TabTarget){const tab=ensure(target);render();return tab;},
  mount(target:TabTarget){const tab=ensure(target);activeId=tab.id;render();return tab;},
  remove(tab:DocumentTab){entries=entries.filter(t=>t!==tab);if(activeId===tab.id)activeId=undefined;render();},
  unmount(){activeId=undefined;render();},
  focus(){element.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus({preventScroll:true});},
  reconcile(scenes:readonly {id:string;path:string}[]){for(const tab of entries){if(tab.kind==='assembled'&&tab.chapter){tab.unavailable=true;tab.position=undefined;continue;}if(!tab.sceneId)continue;const found=scenes.find(s=>s.id===tab.sceneId);if(found){if(tab.path!==found.path)tab.position=undefined;tab.path=found.path;tab.unavailable=false;}else{tab.unavailable=true;tab.position=undefined;}}render();},
  setBlocked(value:boolean){blocked=value;render();},
  clear(){entries=[];activeId=undefined;blocked=false;render();}
 };
}
