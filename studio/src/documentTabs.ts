import {actionMenu} from './actionMenu';
import type {Chapter} from './localCore';
/** Session-only navigation identities. Inactive tabs never contain writing buffers. */
export interface DocumentTab {id:string;path:string;kind:'source'|'assembled';title?:string;sceneId?:string;chapter?:Chapter;unavailable?:boolean;position?:{hash:string;anchor:number;head:number;scrollTop:number}}
export type TabTarget=Omit<DocumentTab,'id'>;
let nextId=0;
export function createDocumentTabs(hooks:{open(tab:DocumentTab):Promise<unknown>;close(tab:DocumentTab):Promise<unknown>;read(tab:DocumentTab):void}){
 let editorActions:HTMLElement|null=null;
 let currentActions:ReturnType<typeof actionMenu>|null=null;
 const compactMedia=window.matchMedia?.('(max-width:760px), (max-height:600px)');
 const resize=()=>render();compactMedia?.addEventListener?.('change',resize);
 let dismissPopup:(()=>void)|null=null;
 let entries:DocumentTab[]=[];let activeId:string|undefined;let blocked=false;
 const element=document.createElement('nav');element.className='document-tabs';element.setAttribute('aria-label','Open documents');
 const same=(a:TabTarget,b:TabTarget)=>a.kind===b.kind&&(a.sceneId&&b.sceneId?a.sceneId===b.sceneId:a.path===b.path);
 function name(tab:DocumentTab){
  return tab.title?.trim() || tab.chapter?.title?.trim() || tab.path.split('/').at(-1)!;
 }
 function label(tab:DocumentTab){
  const base=name(tab),parts=tab.path.split('/');
  const peers=entries.filter(t=>t.path!==tab.path&&name(t)===base);let display=base;
  if(peers.length){
   if(tab.title?.trim() || tab.chapter?.title?.trim()){
    const paths=[...new Set(entries.filter(t=>name(t)===base).map(t=>t.path))];
    display+=` · ${paths.indexOf(tab.path)+1}`;
   }else{
    let parent='';
    for(let depth=1;depth<parts.length;depth++){parent=parts.slice(-depth-1,-1).join('/');if(peers.every(t=>t.path.split('/').slice(-depth-1,-1).join('/')!==parent))break;}
    if(parent)display=parent+'/'+base;
   }
  }
  const kind=tab.kind==='assembled'?' · Assembled':entries.some(t=>t.path===tab.path&&t.kind!==tab.kind)?' · Source':'';
  return display+kind+(tab.unavailable?' · Unavailable':'');
 }
 function accessibleLabel(tab:DocumentTab){
  return tab.title?.trim() || tab.chapter?.title?.trim() ? label(tab) : tab.path+(tab.kind==='assembled'?' · Assembled':entries.some(t=>t.path===tab.path&&t.kind!==tab.kind)?' · Source':'')+(tab.unavailable?' · Unavailable':'');
 }
 function popup(title:string,opener:HTMLButtonElement,fill:(body:HTMLElement,close:()=>void)=>void){
  const dialog=document.createElement('dialog');dialog.className='appearance-dialog workspace-actions-dialog';dialog.setAttribute('aria-label',title);const heading=document.createElement('h2');heading.textContent=title;
  const done=document.createElement('button');done.type='button';done.textContent='Return to writing';const body=document.createElement('div');body.className='workspace-action-controls';
  const close=()=>{dismissPopup=null;if(dialog.open&&typeof dialog.close==='function')dialog.close();dialog.remove();const target=opener.closest('[hidden]')?currentActions?.button:opener;if(target?.isConnected)target.focus({preventScroll:true});};dismissPopup=close;done.addEventListener('click',close);dialog.addEventListener('cancel',event=>{event.preventDefault();close();});fill(body,close);dialog.append(heading,done,body);element.append(dialog);if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');done.focus();
 }
 function render(){
  dismissPopup?.();currentActions?.destroy();
  const focused=(document.activeElement as HTMLElement|null)?.dataset.tabFocus;const oldScroll=element.querySelector('.document-tab-area')?.scrollLeft??0;
  element.replaceChildren();element.hidden=!entries.length;
  const area=document.createElement('div');area.className='document-tab-area';
  // Share grid columns so each close button sits beside its tab, outside the tablist.
  const strip=document.createElement('div');strip.className='document-tab-strip';strip.style.setProperty('--tab-count',String(entries.length));
  const list=document.createElement('div');list.setAttribute('role','tablist');list.setAttribute('aria-label','Open documents');list.setAttribute('aria-orientation','horizontal');
  const closes=document.createElement('div');closes.className='document-tab-closes';closes.setAttribute('role','group');closes.setAttribute('aria-label','Close open documents');
  const reveal=(b:HTMLElement)=>{const r=b.getBoundingClientRect(),a=area.getBoundingClientRect();if(r.left<a.left)area.scrollLeft+=r.left-a.left;else if(r.right>a.right)area.scrollLeft+=r.right-a.right;};
  for(const [index,tab] of entries.entries()){
   const b=document.createElement('button');b.type='button';b.id=tab.id;b.textContent=label(tab);b.setAttribute('aria-label',accessibleLabel(tab));b.setAttribute('role','tab');b.setAttribute('aria-selected',String(tab.id===activeId));b.setAttribute('aria-controls','active-document-pane');b.setAttribute('aria-description','Full path is in Document details. Delete closes this tab through the existing guard.');b.tabIndex=!tab.unavailable&&tab.id===(activeId??entries.find(t=>!t.unavailable)?.id)?0:-1;b.disabled=blocked||!!tab.unavailable;b.dataset.tabFocus=tab.id;
   b.addEventListener('click',()=>void activate(tab));b.addEventListener('focus',()=>reveal(b));b.addEventListener('keydown',event=>{
    if(event.key==='Delete'){event.preventDefault();void hooks.close(tab);return;}
    if(!['ArrowRight','ArrowLeft','ArrowUp','ArrowDown','Home','End'].includes(event.key))return;event.preventDefault();const buttons=[...list.querySelectorAll<HTMLButtonElement>('[role=tab]')].filter(control=>!control.disabled);let i=buttons.indexOf(b);i=event.key==='Home'?0:event.key==='End'?buttons.length-1:(i+(['ArrowRight','ArrowDown'].includes(event.key)?1:-1)+buttons.length)%buttons.length;buttons.forEach((control,n)=>control.tabIndex=n===i?0:-1);buttons[i].focus({preventScroll:true});reveal(buttons[i]);
   });b.style.gridColumn=String(index*2+1);list.append(b);
   const close=document.createElement('button');close.type='button';close.className='document-tab-close';close.textContent='Close';close.setAttribute('aria-label',`Close sheet ${accessibleLabel(tab)}`);close.title=`Close sheet ${label(tab)}`;close.dataset.tabFocus=`close-${tab.id}`;close.disabled=blocked;close.style.gridColumn=String(index*2+2);close.addEventListener('focus',()=>reveal(close));close.addEventListener('click',async()=>{
    await hooks.close(tab);
    // Removing a cancelled guard dialog can leave focus on the page body.
    if(entries.includes(tab)&&document.activeElement===document.body)[...closes.querySelectorAll<HTMLButtonElement>('button')].find(control=>control.dataset.tabFocus===`close-${tab.id}`)?.focus({preventScroll:true});
   });closes.append(close);
  }
  strip.append(list,closes);area.append(strip);const actions=document.createElement('div');actions.className='document-tab-actions';actions.setAttribute('role','group');actions.setAttribute('aria-label','Document actions');
  const details=document.createElement('button');details.type='button';details.textContent='Details';details.setAttribute('aria-label','Document details');details.dataset.tabFocus='details';details.disabled=blocked;details.addEventListener('click',()=>popup('Document details',details,(body,done)=>{for(const tab of entries){const entry=document.createElement('details'),summary=document.createElement('summary'),path=document.createElement('p');summary.textContent=label(tab);path.textContent=tab.path;path.className='document-full-path';entry.append(summary,path);if(tab.unavailable){const reason=document.createElement('p');reason.textContent='Unavailable. Close this document to remove its navigation identity.';entry.append(reason);}const remove=document.createElement('button');remove.type='button';remove.textContent='Close this document';remove.setAttribute('aria-label',`Close document ${accessibleLabel(tab)}`);remove.addEventListener('click',()=>{done();void hooks.close(tab);});entry.append(remove);body.append(entry);}}));
  const read=document.createElement('button');read.type='button';read.textContent='Read beside…';read.setAttribute('aria-label','Read beside…');read.dataset.tabFocus='read-beside';read.disabled=blocked;read.addEventListener('click',()=>popup('Read beside',read,(body,done)=>{for(const tab of entries){const choice=document.createElement('button');choice.type='button';choice.textContent=label(tab);choice.setAttribute('aria-label',`${tab.kind==='assembled'?'Assembled: ':'Read beside active document: '}${tab.title?.trim() || tab.chapter?.title?.trim() ? label(tab) : tab.path}`);choice.disabled=tab.kind!=='source'||!!tab.unavailable;choice.addEventListener('click',()=>{done();hooks.read(tab);});body.append(choice);if(choice.disabled){const p=document.createElement('p');p.textContent=tab.kind==='assembled'?'Assembled documents cannot be a saved-source reference. Choose a source file.':'This source is unavailable.';body.append(p);}}}));
  const secondary=[details,read,...(editorActions?[editorActions]:[])];
  currentActions=actionMenu('Document actions',secondary,element);currentActions.button.textContent=compactMedia?.matches?'Actions':'Document actions';currentActions.button.setAttribute('aria-label','Document actions');currentActions.button.dataset.tabFocus='documents';currentActions.button.disabled=blocked;
  element.classList.toggle('tabs-compact',!!compactMedia?.matches);actions.append(currentActions.button);element.append(area,actions,currentActions.storage);area.scrollLeft=oldScroll;
  if(focused){const target=[...element.querySelectorAll<HTMLElement>('[data-tab-focus]')].find(e=>e.dataset.tabFocus===focused);(target?.closest('[hidden]')?currentActions.button:target)?.focus({preventScroll:true});}
 }
 function ensure(target:TabTarget){let tab=entries.find(t=>same(t,target));if(!tab){tab={...target,id:`document-tab-${++nextId}`};entries.push(tab);}else Object.assign(tab,target,{unavailable:false});return tab;}
 async function activate(tab:DocumentTab){if(!blocked&&!tab.unavailable&&entries.includes(tab))await hooks.open(tab);}
 return {element,setEditorActions(button:HTMLElement|null){editorActions=button;render();},destroy(){compactMedia?.removeEventListener?.('change',resize);dismissPopup?.();currentActions?.destroy();entries=[];element.replaceChildren();},items:()=>entries.slice(),active:()=>entries.find(t=>t.id===activeId),activate,
  register(target:TabTarget){const tab=ensure(target);render();return tab;},
  mount(target:TabTarget){const tab=ensure(target);activeId=tab.id;render();return tab;},
  remove(tab:DocumentTab){entries=entries.filter(t=>t!==tab);if(activeId===tab.id)activeId=undefined;render();},
  renamePath(source:string,destination:string){const tab=entries.find(t=>t.kind==='source'&&t.path===source);if(tab){const duplicate=entries.find(t=>t!==tab&&t.kind==='source'&&t.path===destination);if(duplicate){entries=entries.filter(t=>t!==duplicate);if(activeId===duplicate.id)activeId=tab.id;}tab.path=destination;tab.position=undefined;tab.unavailable=false;render();}},
  invalidate(path:string,unavailable=false){for(const tab of entries){if(tab.path===path){tab.position=undefined;if(unavailable)tab.unavailable=true;}}render();},
  unmount(){activeId=undefined;render();},
  focus(){element.querySelector<HTMLButtonElement>('[aria-selected=true]')?.focus({preventScroll:true});},
  reconcile(scenes:readonly {id:string;path:string;title?:string}[]){for(const tab of entries){if(tab.kind==='assembled'&&tab.chapter){tab.unavailable=true;tab.position=undefined;continue;}if(!tab.sceneId)continue;const found=scenes.find(s=>s.id===tab.sceneId);if(found){if(tab.path!==found.path)tab.position=undefined;tab.path=found.path;tab.title=found.title;tab.unavailable=false;}else{tab.unavailable=true;tab.position=undefined;}}render();},
  setBlocked(value:boolean){blocked=value;render();},
  clear(){entries=[];activeId=undefined;blocked=false;render();}
 };
}
