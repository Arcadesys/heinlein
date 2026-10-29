import {emit,listen} from '@tauri-apps/api/event';
import {EditorView} from '@codemirror/view';
import {mountStudio} from '../../../../src/studio';
import {localCore,type LocalCore} from '../../../../src/localCore';
import type {DraftPreview,StandaloneDraft} from '../../../../src/standaloneDrafts';
import {expected,expectedHash,createDiagnostics} from '../ack';
import '../../../../src/style.css';

const config=(globalThis as unknown as {__HEINLEIN_NATIVE47__:{phase:'picker'|'picker-reopen';id:string}}).__HEINLEIN_NATIVE47__;
const assert=(value:unknown,message:string)=>{if(!value)throw Error(message);};
let terminal=false,opened=false,closeReady=false,previewCalls=0,previewSettled=0,placeCalls=0,placeSettled=0,evidenceReady=false,lastToken='';
let restored:StandaloneDraft|undefined;
const readbacks:{stage:string;nativeActions:number;originalExact:boolean;copyExact:boolean;publicationAbsent:boolean;bytes:number;hash:string;draftId:string;revision:number;placements:number}[]=[];
function failed(error:unknown){if(terminal)return;terminal=true;void emit('native47-diagnostic',{stage:'renderer-failed',detail:String(error).slice(0,240)}).catch(()=>{});}
const diagnostics=createDiagnostics((stage,extra)=>emit('native47-diagnostic',{stage,...extra}),()=>failed('Diagnostic emission rejected'));
const stage=(name:string,extra:object={})=>diagnostics.emit(name,extra);
async function barrier(){await diagnostics.flush(3000);assert(!terminal,'Fixture terminal');}
async function waitFor(predicate:()=>boolean,label:string){const deadline=performance.now()+18000;while(!predicate()){if(terminal||performance.now()>deadline)throw Error(`Picker fixture timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,10));}}
async function verify(stageName:string,actions:number,placed:boolean){const before=readbacks.length;stage(stageName);await barrier();await waitFor(()=>readbacks.length>before,stageName+' native readback');const value=readbacks[before];assert(value.stage===stageName&&value.nativeActions===actions&&value.originalExact&&value.copyExact===placed&&value.publicationAbsent===!placed&&value.bytes===94&&value.hash===expectedHash&&value.draftId===config.id,'Actual native readback binding');return value;}
const forbidden=async():Promise<never>=>{failed('Forbidden fixture service');throw Error('Forbidden fixture service');};
const inert=async()=>{stage('inert-startup-dependency');return [];};
const core:LocalCore={available:()=>true,pickRepository:forbidden,recentRepositories:inert,openRecentRepository:forbidden,listDirectory:forbidden,readDocument:forbidden,loadManuscript:forbidden,listSystemFonts:inert,saveDocument:forbidden,readRecovery:forbidden,stageRecovery:forbidden,discardRecovery:forbidden,
 setUnsavedChanges:dirty=>localCore.setUnsavedChanges(dirty),finishQuitRequest:()=>localCore.finishQuitRequest!(),onQuitRefused:callback=>localCore.onQuitRefused!(callback),
 onCloseRequested:async callback=>{const stop=await localCore.onCloseRequested(callback);closeReady=true;return stop;},
 requestClose:async discard=>{assert(discard===true&&evidenceReady&&!terminal,'Only unchanged production guards may request final close');stage('request-close-from-production');await barrier();return localCore.requestClose(discard);},
 standalone:async request=>{
  const result=await localCore.standalone!(request);
  if(request.kind==='open'){
   const draft=(result as {loaded:{draft:StandaloneDraft}}).loaded.draft;assert(draft.id===config.id&&draft.text===expected&&draft.textHash===expectedHash,'Actual private source exact raw bytes');restored=draft;opened=true;
  }
  if(request.kind==='preview'){
   previewCalls++;assert(config.phase==='picker'&&request.destination==='file','Only actual new local file picker');
   if(previewCalls===1){assert(result===null,'Actual NSSavePanel Cancel returns null');await verify('picker-cancel-real-null',1,false);}
   else{
    assert(previewCalls===2||previewCalls===3,'No implicit picker retry');const preview=result as DraftPreview;assert(preview&&typeof preview.token==='string'&&preview.token.length>0&&preview.destination.endsWith('/copy-targets/draft.md')&&preview.text===expected&&preview.hash===expectedHash&&preview.revision===1,'Actual retained picker preview token');lastToken=preview.token;await verify('picker-preview-real-token',previewCalls===2?2:4,false);
   }
   previewSettled=previewCalls;
  }
  if(request.kind==='place'){
   placeCalls++;assert(config.phase==='picker'&&placeCalls<=2,'No extra placement');
   if(placeCalls===1){assert(result===null,'Actual parented NSAlert Cancel returns null');await verify('picker-place-cancel-real-null',3,false);}
   else{const draft=result as StandaloneDraft;assert(draft.text===expected&&draft.textHash===expectedHash&&draft.id===config.id&&draft.placements.length===1,'Actual copy receipt retains original');await verify('picker-copy-real-receipt',5,true);}
   placeSettled=placeCalls;
  }
  return result;
 },
};
function button(label:string,root:ParentNode=document){const b=[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);assert(b,`Missing ${label}`);return b!;}
const destination=()=>document.querySelector<HTMLDialogElement>('dialog[aria-label="Choose a destination"]');
async function chooseDestination(){button('Choose a destination…').click();await waitFor(()=>Boolean(destination()?.open),'production destination dialog');const select=destination()!.querySelector('select')!;assert(select.value==='file','Default local file mode');}
async function main(){
 assert(config&&['picker','picker-reopen'].includes(config.phase),'Explicit picker startup');
 await listen<typeof readbacks[number]>('native47-picker-readback',event=>readbacks.push(event.payload));
 if(config.phase==='picker'){
  const created=await localCore.standalone!({kind:'create',text:expected}) as {handle:string;loaded:{draft:StandaloneDraft}};
  assert(created.loaded.draft.text===expected&&created.loaded.draft.textHash===expectedHash&&created.loaded.draft.revision===1,'Independent synthetic source seed');config.id=created.loaded.draft.id;stage('seed-identity',{id:config.id});await barrier();await localCore.standalone!({kind:'release',handle:created.handle});
 }
 mountStudio(document.querySelector<HTMLElement>('#app')!,core);
 await waitFor(()=>opened&&closeReady&&Boolean(document.querySelector('.cm-content')),'production editor open');
 const view=EditorView.findFromDOM(document.querySelector('.cm-content')!)!;assert(view,'Production editor mounted');stage('production-editor-ready');await waitFor(()=>view.hasFocus&&document.activeElement===view.contentDOM&&document.hasFocus(),'production editor focus');stage('production-editor-focused',{editorHasFocus:view.hasFocus,activeElement:document.activeElement===view.contentDOM,documentHasFocus:document.hasFocus()});await barrier();
 if(config.phase==='picker'){
  await chooseDestination();button('Choose location and preview…',destination()!).click();await waitFor(()=>previewSettled===1,'actual picker Cancel + native readback');assert(![...destination()!.querySelectorAll('button')].some(b=>b.textContent==='Place copy…'),'Cancelled picker creates no preview action');
  button('Choose location and preview…',destination()!).click();await waitFor(()=>previewSettled===2&&Boolean([...destination()!.querySelectorAll('button')].find(b=>b.textContent==='Place copy…')),'actual picker OK preview rendered');
  button('Place copy…',destination()!).click();await waitFor(()=>placeSettled===1,'actual parented Place Cancel');button('Cancel',destination()!).click();await waitFor(()=>!destination(),'production destination dialog cancelled');
  await chooseDestination();button('Choose location and preview…',destination()!).click();await waitFor(()=>previewSettled===3&&Boolean([...destination()!.querySelectorAll('button')].find(b=>b.textContent==='Place copy…')),'fresh actual picker preview');
  button('Place copy…',destination()!).click();await waitFor(()=>placeSettled===2&&Boolean([...document.querySelectorAll('h2')].find(h=>h.textContent==='Copy placed')),'actual Place confirm + durable copy receipt');
  // Replaying the consumed native token must not authorize another write or dialog.
  let denied=false;try{await localCore.standalone!({kind:'place',token:lastToken});}catch{denied=true;}assert(denied,'Consumed native destination token cannot be replayed');await verify('picker-replay-denied',5,true);
  button('Keep editing original').click();assert(view.state.doc.toString()===expected.replace(/\r\n|\r/g,'\n'),'Original visible writing retained');
 }else{
  assert(restored!.placements.length===1,'Durable copy receipt after restart');await verify('picker-reopened-both',0,true);
 }
 evidenceReady=true;stage('picker-all-evidence-ready');await barrier();
}
window.addEventListener('error',event=>failed(event.message));window.addEventListener('unhandledrejection',event=>failed(event.reason));window.addEventListener('securitypolicyviolation',()=>failed('CSP blocked external resource'));
void main().catch(failed);
