import {invoke} from '@tauri-apps/api/core';
import {emit} from '@tauri-apps/api/event';
import {createReviewPanel} from '../../../src/reviewPanel';
import type {LocalCore, ReviewResult} from '../../../src/localCore';
import '../../../src/style.css';

declare global { interface Window { __HEINLEIN_NATIVE44__: {phase:'first'|'reopen'|'stale';actualDialog:boolean;repositoryId:string;reviewId:string;snapshots:{path:string;source:string;sourceHash:string}[]}; } }
const config=window.__HEINLEIN_NATIVE44__;
document.querySelector('#confirmation-mode')!.textContent=config.actualDialog ? 'Actual production OS confirmation with programmatic own-button actions; physical keyboard and VoiceOver usability remain untested.' : 'Synthetic native author-choice mode; no OS-dialog usability proof.';
const forbidden=async()=>{throw Error('Provider and unrelated services prohibited in native44 fixture');};
let actualCancels=0, actualRefusals=0;
const core={
  reviewDefinitions:()=>invoke('review_definitions'),
  previewReview:forbidden,
  listReviews:(repositoryId:string)=>invoke('list_reviews',{repositoryId}),
  getReview:(repositoryId:string,reviewId:string)=>invoke('get_review',{repositoryId,reviewId}),
  chooseReviewEdit:(repositoryId:string,reviewId:string,editId:string)=>invoke('choose_review_edit',{repositoryId,reviewId,editId}),
  rejectReviewEdit:(repositoryId:string,reviewId:string,editId:string)=>invoke('reject_review_edit',{repositoryId,reviewId,editId}),
  approveReviewEdit:async(repositoryId:string,reviewId:string,editId:string)=>{try{const result=await invoke('approve_review_edit',{repositoryId,reviewId,editId});if(result===null)actualCancels++;return result;}catch(error){actualRefusals++;throw error;}},
  // Explicit inert provider configuration. No native question_status/Auth service.
  questionStatus:async()=>({configured:false,model:null,message:'Synthetic captured review; no provider connection',accounts:[],activeAccountId:null,models:[],selectedModel:null,signInPending:false,generation:1,usageLimited:false}),
} as unknown as LocalCore;
const panel=createReviewPanel(core,{
  capture:()=>({repositoryId:config.repositoryId,scope:'chapter',snapshots:config.snapshots,label:'Disposable synthetic review'}),
  unavailable:()=>null,reviewProposal:forbidden,openConnection:()=>{},focusEditor:()=>{},
});
document.querySelector('#app')!.append(panel.element);
const stage=(name:string)=>emit('native44-progress',name);
const pause=()=>new Promise(resolve=>setTimeout(resolve,25));
async function wait(test:()=>boolean){const until=performance.now()+20000;while(!test()){if(performance.now()>until)throw Error('Native44 renderer timeout');await pause();}}
function click(label:string,root:ParentNode=document){const b=[...root.querySelectorAll('button')].find(b=>b.textContent===label&&!b.disabled);if(!b)throw Error(`Missing enabled production control: ${label}`);b.click();}
async function view(){return await core.getReview!(config.repositoryId,config.reviewId);}
async function reopen(){panel.open();await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent===`Reopen saved review ${config.reviewId}`));click(`Reopen saved review ${config.reviewId}`);await wait(()=>Boolean(document.querySelector('[data-finding-id]')));}
async function item(replacement:string){const r=await view();const e=r.edits.find(e=>e.replacement===replacement);if(!e)throw Error('Missing native finding');return e;}
async function action(replacement:string,label:string){const e=await item(replacement);await wait(()=>[...document.querySelectorAll<HTMLButtonElement>(`[data-finding-id="${e.id}"] button`)].some(b=>b.textContent===label&&!b.disabled));const card=document.querySelector(`[data-finding-id="${e.id}"]`);if(!card)throw Error('Missing production finding card');click(label,card);return e.id;}
async function terminal(id:string,status:string){await wait(()=>!document.querySelector(`[data-finding-id="${id}"] button:not(:disabled)`));for(let i=0;i<200;i++){const r=await view();if(r.edits.find(e=>e.id===id)?.status===status)return;await pause();}throw Error('Native decision not durable');}
async function main(){
  await reopen();await stage('production-review-panel-reopened');
  if(config.phase==='stale'){
    await action('Good 🦊','Approve…');await wait(()=>actualRefusals===1);await stage('actual-stale-refusal');await emit('native44-finish');return;
  }
  if(config.phase==='first'){
    const rejected=await action('Never','Reject edit');await terminal(rejected,'rejected');await stage('rejected-durably');
    if(config.actualDialog){await action('Good 🦊','Approve…');await wait(()=>actualCancels===1);await stage('actual-Cancel-observed');}
    const a=await action('Good 🦊','Approve…');await terminal(a,'accepted');await stage('unicode-edit-approved');
    const b=await action('Clear','Approve…');await terminal(b,'accepted');await stage('unrelated-shifted-edit-approved');
    // Conflicts are selected through the production UI, never granted by renderer data.
    const overlap=await item('Hold');
    let refused=false;try{await core.approveReviewEdit!(config.repositoryId,config.reviewId,overlap.id);}catch{refused=true;}
    if(!refused)throw Error('Unchosen overlap approved');await stage('unchosen-conflict-refused');
    const radio=document.querySelector<HTMLInputElement>(`[data-finding-id="${overlap.id}"] input[type=radio]`);if(!radio)throw Error('Missing production conflict choice');radio.click();
    await wait(()=>Boolean(document.querySelector<HTMLInputElement>(`[data-finding-id="${overlap.id}"] input:checked`)));
    await action('Hold','Approve…');await terminal(overlap.id,'accepted');await stage('chosen-conflict-approved');
    click('Close review');await reopen();
    if((await item('Never')).status!=='rejected')throw Error('Rejection resurrected on reopen');
  }else{
    const r:ReviewResult=await view();
    if(r.edits.filter(e=>e.status==='accepted').length!==3||(await item('Never')).status!=='rejected')throw Error('Persisted decisions lost on process restart');
    const d=await action('Other','Approve…');await terminal(d,'accepted');await stage('restart-unrelated-file-approved');
  }
  // Native verifier owns final bytes/record/receipt assertions; this is not an approval grant.
  await emit('native44-finish');
}
main().catch(async()=>{document.body.dataset.failed='true';await emit('native44-abort');});
