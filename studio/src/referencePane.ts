import type {Document,LocalCore} from './localCore';
import {frontmatterEnd,normalizeChapterText} from './assembledChapter';
import {createMarkdownReader} from './markdownReader';
export const REFERENCE_ACTION_MESSAGE='Activate this document to edit or review it.';
export interface ReferenceTarget {path:string;sceneId?:string}
export function createReferencePane(core:Pick<LocalCore,'readDocument'>,hooks:{binding():{session:string;generation:number}|null;edit(path:string):void;focusWriter():void}){
 const element=document.createElement('section');element.className='reference-pane';element.setAttribute('aria-label','Saved source reference');element.hidden=true;
 let request=0;let pending:{path:string;token:number}|null=null;let target:ReferenceTarget|null=null;let snapshot:{doc:Document;session:string}|null=null;let stale=false;let unavailable=false;let referenceOrigin=false;let detached=false;
 const heading=document.createElement('h2');heading.textContent='Reference';
 const path=document.createElement('p');path.className='reference-path';
 const description=document.createElement('p');description.className='reference-summary';description.textContent='Saved copy · no unsaved text';
 const details=document.createElement('details');details.className='reference-details';const summary=document.createElement('summary');summary.textContent='About this copy';const explanation=document.createElement('p');explanation.textContent='Snapshot of saved disk source. Unsaved and recovery writing is not included. Refresh reads saved source only; it does not change the main pane.';details.append(summary,explanation);
 const state=document.createElement('p');state.className='reference-state';state.setAttribute('role','status');state.tabIndex=0;
 const error=document.createElement('p');error.className='reference-error';error.setAttribute('role','status');
 const source=document.createElement('pre');source.className='reference-source';source.tabIndex=0;source.setAttribute('aria-label','Read-only saved source');
 const actions=document.createElement('div');actions.className='reference-actions';
 // A saved copy to read. It has no review marks and no click, selection or writing authority.
 let reading=false;
 const reader=createMarkdownReader({label:'Saved reference, reading view',showSource:()=>{reading=false;render();},content:()=>{const text=normalizeChapterText(snapshot?.doc.text??'');const body=frontmatterEnd(text)??0;return {text,ranges:[{from:body,to:text.length}],note:body?'Frontmatter is not shown in Reading. See Source.':undefined};}});
 const view=document.createElement('div');view.className='md-view-toggle';view.setAttribute('role','group');view.setAttribute('aria-label','Reference view');
 const make=(label:string,run:()=>void)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',run);return b;};
 const refresh=make('Refresh',()=>{if(target)void read(target);});
 const edit=make('Main pane',()=>{if(target&&!unavailable)hooks.edit(target.path);});
 const close=make('Close',()=>{clear();hooks.focusWriter();});actions.append(refresh,edit,close);
 refresh.setAttribute('aria-label','Refresh saved source');edit.setAttribute('aria-label','Open in main pane');close.setAttribute('aria-label','Close reference');
 const showSource=make('Source',()=>{reading=false;render();}),showReading=make('Reading',()=>{reading=true;render();});
 showSource.setAttribute('aria-label','Reference source');showReading.setAttribute('aria-label','Reference reading');view.append(showSource,showReading);
 element.append(heading,path,description,state,error,view,source,reader.element,actions,details);
 element.addEventListener('focusin',()=>{referenceOrigin=true;});element.addEventListener('pointerdown',()=>{referenceOrigin=true;});
 function renderPath(value:string){path.replaceChildren();for(const segment of value.split(/(?<=[/\-])/)){path.append(document.createTextNode(segment),document.createElement('wbr'));}}
 function render(){element.hidden=!snapshot;if(!snapshot)return;renderPath(snapshot.doc.path+(target&&target.path!==snapshot.doc.path?`\nCurrent source path: ${target.path}`:''));source.textContent=snapshot.doc.text;
  const markdown=/\.(md|markdown)$/i.test(snapshot.doc.path);if(!markdown)reading=false;
  view.hidden=!markdown;source.hidden=reading;reader.element.hidden=!reading;if(reading)reader.update();else reader.clear();
  showSource.setAttribute('aria-pressed',String(!reading));showReading.setAttribute('aria-pressed',String(reading));
  state.textContent=unavailable?'Unavailable · Historical copy.':stale?'Changed — refresh.':'Refresh to check.';
  edit.disabled=unavailable||detached;refresh.disabled=unavailable||detached;refresh.title=target&&target.path!==snapshot.doc.path?`Read current source ${target.path}`:'';
 }
 async function read(next:ReferenceTarget){
  const binding=hooks.binding();if(!binding)return false;const token=++request;pending={path:next.path,token};
  try {const doc=await core.readDocument(binding.session,next.path);const now=hooks.binding();if(token!==request||!now||now.session!==binding.session||now.generation!==binding.generation)return false;if(doc.path!==next.path||doc.generatedCompatibility)throw Error('Choose an existing source document for the reference pane.');
   target={...next};snapshot={doc,session:binding.session};stale=false;unavailable=false;error.textContent='';render();return true;
  }catch(e){const now=hooks.binding();if(token!==request||!now||now.session!==binding.session||now.generation!==binding.generation)return false;error.textContent=`Reference read failed for ${next.path}: ${String(e)}. ${snapshot?'Previous snapshot retained.':'No snapshot loaded.'}`;if(!snapshot){element.hidden=false;renderPath(next.path);state.textContent='No saved snapshot loaded.';source.textContent='';refresh.disabled=true;edit.disabled=true;}return false;}finally{if(pending?.token===token)pending=null;}
 }
 function clear(){reading=false;reader.clear();reader.element.hidden=true;source.hidden=false;request++;pending=null;target=null;snapshot=null;stale=false;unavailable=false;referenceOrigin=false;detached=false;element.hidden=true;error.textContent='';source.textContent='';path.textContent='';state.textContent='';}
 return {element,read,clear,hasSnapshot:()=>!!snapshot,fromReference:()=>referenceOrigin,activateWriter:()=>{referenceOrigin=false;},
  markChanged(changed:string){if(pending?.path===changed){request++;pending=null;}if(target?.path===changed||snapshot?.doc.path===changed){stale=true;render();}},
  reconcile(scenes:readonly {id:string;path:string}[]){if(!target?.sceneId)return;const scene=scenes.find(s=>s.id===target!.sceneId);if(!scene){unavailable=true;stale=true;request++;}else if(scene.path!==target.path){target={...target,path:scene.path};stale=true;request++;}else{unavailable=false;}render();},
  setDetached(value:boolean){detached=value;render();},snapshot:()=>snapshot,
 };
}
