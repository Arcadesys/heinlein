// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createQuestionPanel, type QuestionScene} from './questionPanel';
import type {LocalCore, QuestionAnswer, QuestionRequest, QuestionStatus} from './localCore';
const cryptoModule='node:crypto';
const {webcrypto}=await import(cryptoModule) as {webcrypto: Crypto};
const processModule='node:process';
const {env}=await import(processModule) as {env: Record<string,string|undefined>};
const ready: QuestionStatus={configured:true, model:'synthetic-model',message:'Synthetic',accounts:[{id:'synthetic-account',label:'Synthetic',signedIn:true,planEnabled:true}],activeAccountId:'synthetic-account',models:[{slug:'synthetic-model',displayName:'Synthetic'}],selectedModel:'synthetic-model',signInPending:false,generation:1,usageLimited:false};
const button=(label:string)=>{const result=[...document.querySelectorAll('button')].find(x=>x.textContent===label);if(!result)throw Error(`Missing ${label}`);return result;};
const input=()=>document.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!;
const write=(value:string)=>{input().value=value;input().dispatchEvent(new Event('input',{bubbles:true}));};
async function settle(){for(let n=0;n<12;n++)await Promise.resolve();}
function deferred<T>(){let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}

it('connection_fuzz_renderer: bounded async sequences preserve authority, focus and safe text',async()=>{
  const start=Number(env.HEINLEIN_FUZZ_START??1),seeds=Number(env.HEINLEIN_FUZZ_SEEDS??16);
  expect(Number.isSafeInteger(start)&&start>=0&&Number.isSafeInteger(start+seeds)&&Number.isSafeInteger(seeds)&&seeds>0&&seeds<=1024).toBe(true);
  const counts=Array<number>(8).fill(0);
  vi.stubGlobal('crypto',webcrypto);
  const network=vi.fn();vi.stubGlobal('fetch',network);
  const storage=vi.spyOn(Storage.prototype,'setItem');
  try{
    for(let seed=start;seed<start+seeds;seed++){
      let rng=seed>>>0;const next=()=>{rng=(Math.imul(rng,1664525)+1013904223)>>>0;return rng;};
      document.body.replaceChildren();
      const source='Synthetic source 🦊 — unchanged.';
      const scene: QuestionScene={repositoryId:'synthetic-repository',path:'synthetic.md',source,from:0,to:9,canCapture:true};
      const focus=vi.fn();const core={available:()=>true,questionStatus:vi.fn(async()=>ready),askQuestion:vi.fn<(request:QuestionRequest)=>Promise<QuestionAnswer>>(),cancelQuestion:vi.fn(async()=>true)};
      const panel=createQuestionPanel(core as unknown as LocalCore,{current:()=>scene,focusEditor:focus});
      document.body.append(panel.element);panel.open();await settle();
      try{
        for(let step=0;step<64;step++){
          // Higher bits avoid the short cycle of an LCG's low bits.
          const kind=(next()>>>16)%8;counts[kind]++;
          button('Clear conversation').click();await settle();
          const pending=deferred<QuestionAnswer>();core.askQuestion.mockReturnValueOnce(pending.promise);
          const marker=`Synthetic-${seed}-${step}`;write(marker);button('Send to OpenAI').click();
          const request=core.askQuestion.mock.calls.at(-1)![0];const before=core.askQuestion.mock.calls.length;
          expect(request).toMatchObject({question:marker,context:'',history:[]});
          expect(button('Send to OpenAI').disabled).toBe(true);
          const external=document.createElement('button');document.body.append(external);external.focus();
          const answer:QuestionAnswer={requestId:request.requestId,text:`${marker} <img src=x onerror=alert(1)> 🦊`,model:'synthetic-model',incomplete:false};
          if(kind===0)pending.resolve(answer);
          if(kind===1)pending.reject({message:'Synthetic provider failure',diagnostic:'contentType',httpStatus:200,providerRequestId:'req_synthetic'});
          if(kind===2){button('Cancel request').click();pending.resolve(answer);}
          if(kind===3){button('Close questions').click();panel.open();pending.resolve(answer);}
          if(kind===4)pending.resolve({...answer,requestId:'wrong-request'});
          if(kind===5)pending.resolve({...answer,text:'\ud800'});
          if(kind===6)pending.resolve({...answer,incomplete:true});
          if(kind===7)pending.reject({message:'Synthetic safe failure',diagnostic:'<script>secret-marker</script>',httpStatus:999,providerRequestId:'secret-marker'});
          await settle();
          expect(core.askQuestion.mock.calls.length).toBe(before);
          expect(document.querySelector('img, script')).toBeNull();
          expect(scene.source).toBe(source);expect(network).not.toHaveBeenCalled();expect(storage).not.toHaveBeenCalled();
          if(kind===0||kind===6){expect(document.querySelector('.question-transcript')!.textContent).toContain(marker);expect(document.activeElement).toBe(external);}
          else expect(document.querySelector('.question-transcript')!.textContent).not.toContain(marker);
          if(kind===1)expect(document.querySelector('.question-status')!.textContent).toContain('HTTP content type · HTTP 200 · req_synthetic');
          if(kind===7)expect(panel.element.textContent).not.toContain('secret-marker');
          write('Next synthetic question');expect(button('Send to OpenAI').disabled).toBe(false);
          external.remove();
        }
      }finally{panel.destroy();}
      // Let Vitest's RPC and timers run between seeds; microtask-only loops
      // otherwise starve the worker heartbeat during the full campaign.
      await new Promise<void>(resolve=>setTimeout(resolve,0));
    }
    console.info(`renderer operation counts: ${JSON.stringify(counts)}`);
  }finally{storage.mockRestore();vi.unstubAllGlobals();document.body.replaceChildren();}
},300000);
