// Fixture-only: observers cannot delay the independent close/durable latches.
export const seed='Synthetic café — 🦊\r\nSecond line\n第三行\rFinal original';
export const addition='\nLatest revision: naïve 🌈\n';
export const expected=seed+'\r\nLatest revision: naïve 🌈\r\n';
export const expectedHash='115d534fa5575cf7820a1c44c84824eb41871d514293561082f487cfcbe5a276';
export interface Durable {id:string;text:string;textHash:string;revision:number}
export const seedHash='a45109cb112299a095c0d2c1e0c603580db2ea96ad92c596556c9dea4157244b';
export function validateRequest(text:string,revision:number,hash=seedHash){
  if(text!==expected||revision!==1||hash!==seedHash)throw Error('Save request text/revision mismatch');
  if(!text.startsWith(seed))throw Error('Untouched mixed seed changed');
}
export function validateDurable(value:Durable,id:string,revision:number){
  validateRequest(value.text,revision);
  if(value.id!==id||value.textHash!==expectedHash||value.revision!==revision+1)throw Error('Native Save result identity/hash/revision mismatch');
}
export function createAck<T>(observe:(name:string)=>void){
  let close=false,durable=false,terminal=false,released=false,consumer=false;
  let value:T;
  let resolve!:(value:T)=>void,reject!:(error:Error)=>void;
  const result=new Promise<T>((ok,no)=>{resolve=ok;reject=no;});
  // The eager rejection may precede the Save wrapper subscribing.
  void result.catch(()=>{});
  function fail(reason:string){
    if(terminal)return;terminal=true;reject(Error(reason));observe('validation-failed');
  }
  function ready(){
    if(terminal||released||!close||!durable)return;
    observe('both-gates-ready');
    if(terminal)return;
    released=true;observe('ack-release');
    if(!terminal)resolve(value!);
  }
  return {
    close(callback:()=>void){
      if(close||terminal||released){fail('Duplicate/late close');return;}
      close=true;observe('close-handler-entered');
      try{callback();observe('callback-dispatched');}catch{fail('Close callback failed');return;}
      ready();
    },
    durable(saved:T,validate:(value:T)=>void){
      if(durable||terminal||released){fail('Duplicate/late durable response');return;}
      try{validate(saved);}catch{fail('Native Save validation failed');return;}
      durable=true;value=saved;observe('native-save-promise-resolved');ready();
    },
    fail,
    wait(){if(consumer){fail('Duplicate ACK consumer');return Promise.reject(Error('Duplicate ACK consumer'));}consumer=true;return result;},
    get released(){return released&&!terminal;},get terminal(){return terminal;},
  };
}
// Diagnostics are explicitly asynchronous observers. Their promises never enter ACK gates.
export function createDiagnostics(send:(name:string,extra:object)=>Promise<void>,onFailure:()=>void){
  const pending:Promise<void>[]=[];
  let failed=false;
  return {
    emit(name:string,extra:object={}){
      let promise:Promise<void>;
      try{promise=send(name,extra);}catch{promise=Promise.reject(Error('Diagnostic send threw'));}
      pending.push(promise.catch(()=>{if(!failed){failed=true;onFailure();}}));
    },
    async flush(timeoutMs:number){
      let timer:ReturnType<typeof setTimeout>|undefined;
      try{
        await Promise.race([Promise.all([...pending]),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('diagnostic-barrier-timeout')),timeoutMs);})]);
        if(failed)throw Error('diagnostic-barrier-rejected');
      }finally{clearTimeout(timer);}
    },
  };
}
