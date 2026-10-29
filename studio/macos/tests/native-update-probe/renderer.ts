import {emit,listen} from '@tauri-apps/api/event';
import {EditorView} from '@codemirror/view';
import {mountStudio} from '../../../src/studio';
import {localCore,type LocalCore} from '../../../src/localCore';
import type {StandaloneDraft} from '../../../src/standaloneDrafts';
import {seed,addition,expected,expectedHash,validateRequest,validateDurable,createDiagnostics} from '../native-standalone-probe/ack';
import {visibleSeed,visibleExpected} from './oracle';
import {freshStatusCycle,statusReturns,type BackendEvent} from './statusCycle';
import '../../../src/style.css';

const assert=(condition:unknown,message:string)=>{if(!condition)throw Error(message);};
let terminal=false,opened=false,closeReady=false,id='',closeCalls=0,quitFinished=0,saveCalls=0,staleRejected=false,heldSave=false,ackReleased=false;
let releaseSave!:()=>void;
const heldAck=new Promise<void>(resolve=>{releaseSave=resolve;});
const backendEvents:BackendEvent[]=[];
function failed(error:unknown){if(terminal)return;terminal=true;void emit('native42-diagnostic',{stage:'renderer-failed',detail:String(error).slice(0,240)}).catch(()=>{});}
const diagnostics=createDiagnostics((stage,extra)=>emit('native42-diagnostic',{stage,...extra}),()=>failed('Diagnostic rejected'));
const stage=(name:string,extra:object={})=>diagnostics.emit(name,extra);
async function barrier(){await diagnostics.flush(3000);assert(!terminal,'Terminal fixture');}
async function waitFor(predicate:()=>boolean,label='condition'){const deadline=performance.now()+12000;while(!predicate()){if(terminal||performance.now()>deadline)throw Error(`Fixture renderer timeout: ${label}`);await new Promise(resolve=>setTimeout(resolve,10));}}
const tick=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())));
const forbidden=async():Promise<never>=>{failed('Forbidden service dependency');throw Error('Forbidden dependency');};
const inert=async()=>[];
const core:LocalCore={available:()=>true,pickRepository:forbidden,recentRepositories:inert,openRecentRepository:forbidden,listDirectory:forbidden,readDocument:forbidden,loadManuscript:forbidden,listSystemFonts:inert,saveDocument:forbidden,readRecovery:forbidden,stageRecovery:forbidden,discardRecovery:forbidden,
  setUnsavedChanges:dirty=>localCore.setUnsavedChanges(dirty),
  finishQuitRequest:async()=>{await localCore.finishQuitRequest!();quitFinished++;},
  onQuitRefused:callback=>localCore.onQuitRefused!(callback),
  onCloseRequested:async callback=>{const stop=await localCore.onCloseRequested(callback);closeReady=true;return stop;},
  // Real LocalCore -> registered update_request -> native gates/backend/parser. No JS status substitute.
  updateRequest:action=>localCore.updateRequest!(action),
  requestClose:async discard=>{
    closeCalls++;assert(discard===true,'Keep guarded production close boolean');
    if(closeCalls===1){
      let rejected=false;try{await localCore.requestClose(discard);}catch(error){rejected=String(error).includes('Wait for the update check');}
      assert(rejected,'Actual native operation guard must refuse Quit');stage('quit-refused-during-check');throw Error('Expected held update operation refusal');
    }
    assert(closeCalls===2&&ackReleased&&saveCalls===2&&!terminal,'No exit without validated real save acknowledgment');
    stage('production-request-close');await barrier();return localCore.requestClose(discard);
  },
  standalone:async request=>{
    if(request.kind==='save'){
      saveCalls++;validateRequest(request.text,request.revision,request.hash);
      if(saveCalls===1){
        let rejected=false;try{await localCore.standalone!({...request,revision:0});}catch{rejected=true;}
        assert(rejected,'Real native revision guard must reject stale save');staleRejected=true;throw Error('Synthetic stale revision rejected by real native save');
      }
      assert(saveCalls===2,'No implicit save retry');
      const result=await localCore.standalone!(request) as StandaloneDraft;
      validateDurable(result,id,request.revision);heldSave=true;
      await heldAck;assert(!terminal,'No release after terminal failure');ackReleased=true;stage('genuine-save-ack-released',{textHash:result.textHash,revision:result.revision});return result;
    }
    const result=await localCore.standalone!(request);
    if(request.kind==='open'){
      const draft=(result as {loaded:{draft:StandaloneDraft}}).loaded.draft;
      assert(draft.id===id&&draft.text===seed,'Exact synthetic seed open');opened=true;
    }
    return result;
  },
};
function button(label:string,root:ParentNode=document){const b=[...root.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label);assert(b,`Missing button ${label}`);return b!;}
const panel=()=>document.querySelector<HTMLDialogElement>('.update-panel')!;
const status=()=>panel().querySelector('[role=status]')?.textContent??'';
async function openUpdates(){const before=statusReturns(backendEvents);button('Updates…').click();await waitFor(()=>freshStatusCycle(before,backendEvents,panel().open,panel().getAttribute('aria-busy')==='true',!button('Check for updates').disabled),'fresh native status/render cycle');}
function entered(index:number){return backendEvents.some(e=>e.stage==='entered'&&e.action==='check'&&e.index===index);}
async function main(){
  await listen<typeof backendEvents[number]>('native42-backend',event=>backendEvents.push(event.payload));
  const created=await localCore.standalone!({kind:'create',text:seed}) as {handle:string;loaded:{draft:{id:string}}};id=created.loaded.draft.id;await localCore.standalone!({kind:'release',handle:created.handle});
  mountStudio(document.querySelector<HTMLElement>('#app')!,core);
  await waitFor(()=>opened&&closeReady&&Boolean(document.querySelector('.cm-content')));
  const view=EditorView.findFromDOM(document.querySelector('.cm-content')!)!;assert(view,'Production editor');
  await waitFor(()=>view.hasFocus&&document.activeElement===view.contentDOM&&document.hasFocus());stage('fixture-editor-focused',{editorHasFocus:view.hasFocus,activeElement:document.activeElement===view.contentDOM});await barrier();
  await openUpdates();assert(status().includes('No update check yet'),'Initial native status');assert(panel().textContent?.includes('Installed 111111111111')&&panel().textContent?.includes('Install 7'),'Source labels');stage('updates-initial-status');
  button('Check for updates').click();await waitFor(()=>entered(1));
  assert(button('Check for updates').disabled&&panel().getAttribute('aria-busy')==='true','Busy UI');button('Check for updates').click();stage('check-busy-duplicate-suppressed');
  await emit('native42-control',{action:'native-quit'});await waitFor(()=>closeCalls===1&&quitFinished>0);await barrier();
  assert(panel().open&&!document.querySelector<HTMLElement>('#app')!.inert,'Refused native Quit keeps app usable');
  await emit('native42-control',{action:'release-check',index:1});await waitFor(()=>status().includes('could not be checked')&&!button('Check for updates').disabled);stage('check-failed-visible');
  button('Check for updates').click();await waitFor(()=>status().includes('newer main-source')&&!button('Check for updates').disabled);assert(entered(2),'Explicit native retry');stage('explicit-retry-available');
  button('Close updates').click();assert(!panel().open,'Close updates closes dialog');assert(view.state.doc.toString()===visibleSeed,'Defer retains editor text');assert(!backendEvents.some(e=>e.action==='schedule'),'No schedule on defer');stage('deferred-writing-retained');
  await openUpdates();button('Check for updates').click();await waitFor(()=>entered(3),'third native check entered');button('Close updates').click();
  const observed:string[]=[];const observer=new MutationObserver(()=>observed.push(status()));observer.observe(panel().querySelector('[role=status]')!,{childList:true,subtree:true,characterData:true});
  button('Updates…').click();await emit('native42-control',{action:'release-check',index:3});await waitFor(()=>status().includes('newer main-source')&&!button('Check for updates').disabled);observer.disconnect();
  assert(!observed.some(v=>v.includes('could not be checked')),'Old dialog result must not overwrite new session');stage('late-response-ignored');
  button('Update on next launch').click();await waitFor(()=>status().includes('Update requested')&&!button('Save and quit when ready').disabled);stage('in-memory-scheduled');
  // Production editor transaction. This is synthetic input, never physical keyboard proof.
  view.dispatch({changes:{from:view.state.doc.length,insert:addition}});assert(view.state.doc.toString()===visibleExpected,'Independent exact mixed-newline oracle');
  button('Save and quit when ready').click();await waitFor(()=>staleRejected&&quitFinished>=2&&!button('Save and quit when ready').disabled);
  assert(closeCalls===1&&view.state.doc.toString()===visibleExpected&&document.querySelector('.standalone-page')?.textContent?.includes('Not kept yet:'),'Failed real native save retains writing and prevents Quit');stage('stale-save-failure-preserved');
  button('Save and quit when ready').click();await waitFor(()=>heldSave);await tick();
  assert(closeCalls===1&&!ackReleased&&view.state.doc.toString()===visibleExpected,'Production Quit waits for genuine save ACK');stage('save-quit-held-for-genuine-ack');await barrier();releaseSave();
}
window.addEventListener('error',event=>failed(event.message));window.addEventListener('unhandledrejection',event=>failed(event.reason));window.addEventListener('securitypolicyviolation',()=>failed('CSP violation'));
void main().catch(failed);
