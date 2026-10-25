import {emit} from '@tauri-apps/api/event';
import {EditorView} from '@codemirror/view';
import {mountStudio} from '../../../src/studio';
import {localCore, type LocalCore} from '../../../src/localCore';
import {createAck,createDiagnostics,validateRequest,validateDurable,seed,addition,expected,expectedHash,type Durable} from './ack';
import type {StandaloneDraft} from '../../../src/standaloneDrafts';
import '../../../src/style.css';

const config=(globalThis as unknown as {__HEINLEIN_NATIVE47__:{phase:'first'|'reopen';id:string;expectedRevision:number|null}}).__HEINLEIN_NATIVE47__;
const assert=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
let closeReady=false,opened=false,acknowledged=false,queued=false,terminal=false,closes=0;
let saved:StandaloneDraft|undefined,restored:Durable|undefined;
function failed(error?:unknown){
  if(terminal)return;terminal=true;ack.fail('Fixture terminal failure');
  // Last-resort diagnostic is one-shot, handled, nonrecursive. Native watchdog remains.
  void emit('native47-diagnostic',{stage:'renderer-failed',detail:String(error??'browser error').slice(0,240)}).catch(()=>{});
}
const diagnostics=createDiagnostics((name,extra)=>emit('native47-diagnostic',{stage:name,...extra}),()=>failed('Diagnostic emission rejected'));
const stage=(name:string,extra:object={})=>diagnostics.emit(name,extra);
const ack=createAck<StandaloneDraft>(name=>{
  stage(name);
  if(name==='close-handler-entered')stage('native-close-received-before-save-ack');
  if(name==='ack-release'&&saved)stage('durable-save-ack-released',{revision:saved.revision});
});
async function barrier(label:string){try{await diagnostics.flush(3000);}catch{failed(`diagnostic-barrier-${label}-failed`);throw Error(`diagnostic-barrier-${label}-failed`);}}
const forbidden=async():Promise<never>=>{failed('Forbidden fixture dependency');throw Error('Forbidden fixture dependency');};
const inert=async()=>{stage('inert-startup-dependency');return [];};
const core:LocalCore={
  available:()=>true,
  pickRepository:forbidden,recentRepositories:inert,openRecentRepository:forbidden,
  listDirectory:forbidden,readDocument:forbidden,loadManuscript:forbidden,listSystemFonts:inert,
  saveDocument:forbidden,readRecovery:forbidden,stageRecovery:forbidden,discardRecovery:forbidden,
  setUnsavedChanges:dirty=>localCore.setUnsavedChanges(dirty),
  finishQuitRequest:()=>localCore.finishQuitRequest!(),
  onQuitRefused:callback=>localCore.onQuitRefused!(callback),
  onCloseRequested:async callback=>{
    const stop=await localCore.onCloseRequested(()=>{
      if(terminal)return;
      if(++closes!==1){failed('Duplicate native close');return;}
      if(config.phase==='first'){
        if(!queued||acknowledged){failed('Native close outside held save');return;}
        // Eager latch + unchanged callback, synchronous; diagnostics never awaited.
        ack.close(callback);
      }else{
        stage('close-handler-entered');callback();stage('callback-dispatched');
      }
    });closeReady=true;return stop;
  },
  requestClose:async discard=>{
    assert(discard===true,'Keep production guarded close boolean');
    assert(!terminal&&acknowledged&&(config.phase!=='first'||ack.released),'No close without genuine validated durable acknowledgment');
    stage('request-close-from-production');
    // Only receipt flushing is bounded here, after production flush/dirty/revision guards.
    await barrier('before-native-close');
    assert(!terminal&&(config.phase!=='first'||ack.released),'Terminal evidence failure');
    return localCore.requestClose(discard);
  },
  standalone:async request=>{
    if(request.kind==='save'){
      try{
        assert(config.phase==='first'&&!queued,'Exactly one save');
        validateRequest(request.text,request.revision,request.hash);queued=true;stage('save-IPC-queued');
        const result=await localCore.standalone!(request) as StandaloneDraft;
        saved=result;
        stage('durable-save-IPC-returned',{textHash:result.textHash});
        ack.durable(result,value=>validateDurable(value,config.id,request.revision));
        const genuine=await ack.wait();
        assert(!terminal&&ack.released,'Terminal ACK cannot release');acknowledged=true;return genuine;
      }catch(error){ack.fail('Save rejected or invalid');failed(error);throw error;}
    }
    const result=await localCore.standalone!(request);
    if(request.kind==='open'){
      const draft=(result as {loaded:{draft:Durable}}).loaded.draft;
      assert(draft.text===(config.phase==='first'?seed:expected),'Restore exact raw bytes');
      assert(draft.id===config.id,'Restore same draft identity');
      if(config.phase==='reopen'){
        assert(draft.textHash===expectedHash&&draft.revision===config.expectedRevision,'Restore same durable hash/revision');
        acknowledged=true;
      }
      restored=draft;opened=true;
    }
    return result;
  },
};
async function waitFor(predicate:()=>boolean){
  const deadline=performance.now()+15000;
  while(!predicate()){if(terminal||performance.now()>deadline)throw Error('Renderer stage timeout');await new Promise(resolve=>setTimeout(resolve,20));}
}
async function main(){
  assert(config&&['first','reopen'].includes(config.phase),'Explicit fixture config');
  if(config.phase==='first'){
    const created=await localCore.standalone!({kind:'create',text:seed}) as {handle:string;loaded:{draft:{id:string}}};
    config.id=created.loaded.draft.id;stage('seed-identity',{id:config.id});
    await barrier('seed-identity');
    await localCore.standalone!({kind:'release',handle:created.handle});
  }
  mountStudio(document.querySelector<HTMLElement>('#app')!,core);
  await waitFor(()=>opened&&closeReady&&Boolean(document.querySelector('.cm-content')));
  const view=EditorView.findFromDOM(document.querySelector('.cm-content')!);
  assert(view,'Real production editor mounted');stage('production-editor-ready');
  if(config.phase==='first'){
    view!.dispatch({changes:{from:view!.state.doc.length,insert:addition}});stage('editor-revision-queued');
  }else stage('reopened-exact-bytes-same-id',{textHash:restored!.textHash,revision:restored!.revision,draftId:restored!.id});
}
window.addEventListener('error',event=>failed(event.message));
window.addEventListener('securitypolicyviolation',()=>failed('CSP blocked forbidden resource'));
window.addEventListener('unhandledrejection',event=>failed(event.reason));
void main().catch(failed);
