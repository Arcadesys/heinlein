// Synthetic failed review only: no native profiles, manuscripts or provider calls.
import {mountStudio} from '../../src/studio';
import {syntheticProjects} from '../projectBridge';
import type {ReviewResult,ReviewRequest,LocalCore} from '../../src/localCore';
import '../../src/fonts.bundle';import '../../src/style.css';
const initial=syntheticProjects(),seed=initial.state();seed.lastOpenedProjectId='local-a';
const source=seed.documents['local-a']['scene.md'];
seed.projects[0].resume={path:'scene.md',sourceHash:initial.hash(source),sceneId:null,anchor:4,head:4,scrollTop:0};
const f=syntheticProjects(seed),definition={id:'mechanical',version:1,displayName:'Mechanical',instructions:'Advice only.'};
let saved:ReviewResult={schemaVersion:2,reviewId:'saved-authentication',requestId:'old',revision:1,model:'synthetic-model',scope:'scene',projectKey:'source-key-local-a',edits:[{id:'patch',path:'scene.md',fromUtf8:0,toUtf8:5,original:source.slice(0,5),replacement:'Fresh',reason:'Synthetic',role:'editor',status:'pending',proposalId:null,patch:'{}'}],workflow:{accountId:'synthetic-account',accountGeneration:1,definitions:[{instanceId:'reviewer-1',definition,hash:'a'.repeat(64)}],decisions:[],contextNotice:'Synthetic saved review.',sources:[{id:'source',path:'scene.md',sourceHash:initial.hash(source),readOnly:false,order:0}],coverage:['completed','failed','queued'].map((status,i)=>({id:i===2?'consolidation':`call-${i}`,sourceIndex:0,fromUtf8:0,toUtf8:8,windowFrom:0,windowTo:8,reviewer:0,status,requestId:`old-${i}`,error:i===1?'authentication':null,diagnostics:i===1?{httpStatus:401,providerRequestId:'req_synthetic_auth'}:undefined}))},readingFeedback:[{coverageId:'call-0',path:'scene.md',reviewer:'Mechanical',feedback:{overview:'The completed assessment is preserved.',strengths:[],improvements:[]}}]};
let attempts=0,reconnects=0;
const counters=document.createElement('output');counters.setAttribute('aria-label','Synthetic checks');counters.style.cssText='position:fixed;bottom:0;right:0;padding:6px;background:#000;color:#fff;z-index:10000';document.body.append(counters);
const showCounts=()=>{counters.textContent=`Synthetic reconnects: ${reconnects}; review retries: ${attempts}`;};showCounts();const previews:ReviewRequest[]=[],requests:ReviewRequest[]=[];
Object.assign(f.core,{
 questionStatus:async()=>({configured:true,model:'synthetic-model',selectedModel:'synthetic-model',models:[{slug:'synthetic-model',displayName:'Synthetic model'}],accounts:[{id:'synthetic-account',label:'Writer',signedIn:true,planEnabled:true}],activeAccountId:'synthetic-account',generation:4,usageLimited:false,signInPending:false,message:'Ready'}),
 reviewDefinitions:async()=>[definition],previewReview:async(request:ReviewRequest)=>{previews.push(structuredClone(request));return saved.workflow!.coverage.map(c=>({...c,status:'queued',error:null}));},
 listReviews:async()=>[structuredClone(saved)],getReview:async()=>structuredClone(saved),
 requestReview:async(request:ReviewRequest)=>{requests.push(structuredClone(request));return {...structuredClone(saved),requestId:request.requestId,reviewId:'fresh-review'};},
 reauthenticateReview:(async()=>{reconnects++;showCounts();return {status:{configured:true,model:'synthetic-model',selectedModel:'synthetic-model',models:[{slug:'synthetic-model',displayName:'Synthetic model'}],accounts:[{id:'synthetic-account',label:'Writer',signedIn:true,planEnabled:true}],activeAccountId:'synthetic-account',generation:5,usageLimited:false,signInPending:false,message:'Reconnected'},review:structuredClone(saved)};}) as NonNullable<LocalCore['reauthenticateReview']>,
 continueReview:(async(_repo,_review,requestId)=>{if(reconnects<=attempts)throw new Error('Reconnect required');attempts++;showCounts();saved={...saved,requestId};return structuredClone(saved);}) as NonNullable<LocalCore['continueReview']>,
});
const app=mountStudio(document.querySelector('#app')!,f.core);
Object.assign(window,{retryFixture:{state:()=>({attempts,previews,requests,saved,documents:f.documents}),acceptElsewhere:()=>{saved.edits[0].status='accepted';saved.revision=2;f.documents['local-a']['scene.md']='Fresh current source after author approval.';},app}});
