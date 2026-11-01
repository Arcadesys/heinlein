export const mode='picker-manual-preview';
export class ManualState {
 phase:'starting'|'cancel'|'cancel-open'|'save'|'save-open'|'ready'|'finishing'|'incomplete'='starting';
 error='';
 observed=false;
 observationReady(){if(this.phase!=='incomplete')this.observed=true;}
 start(){if(this.phase!=='starting')return this.fail('Duplicate startup');this.phase='cancel';}
 open(){if(!this.observed)return this.fail('Independent startup observation and Terminal readiness required');if(this.phase==='cancel')this.phase='cancel-open';else if(this.phase==='save')this.phase='save-open';else this.fail('Unexpected picker request');}
 result(value:unknown,validToken:(value:unknown)=>boolean){if(this.phase==='cancel-open'&&value===null)this.phase='save';else if(this.phase==='save-open'&&validToken(value))this.phase='ready';else this.fail('Unexpected picker result; stop as incomplete');}
 finish(){if(this.phase!=='ready')return this.fail('Verified preview required');this.phase='finishing';}
 fail(reason:string):never{this.error=reason;this.phase='incomplete';throw Error(reason);}
}

export const nativeFailure='Native verification failed. Stop as incomplete. Source and copy state are unverified.';
export class ManualVerification {
 private pending?:{stage:string;valid:(value:Record<string,unknown>)=>boolean;resolve:()=>void;reject:(error:Error)=>void};
 terminal=false;
 constructor(private onFailure:()=>void){}
 get waiting(){return !!this.pending;}
 wait(stage:string,valid:(value:Record<string,unknown>)=>boolean){
  if(this.terminal)return Promise.reject(Error(nativeFailure));
  if(this.pending){this.fail();return Promise.reject(Error(nativeFailure));}
  return new Promise<void>((resolve,reject)=>{this.pending={stage,valid,resolve,reject};});
 }
 success(value:Record<string,unknown>){
  if(this.terminal||!this.pending||value.stage!==this.pending.stage)return;
  if(!this.pending.valid(value)){this.fail();return;}
  const pending=this.pending;this.pending=undefined;pending.resolve();
 }
 fail(){
  if(this.terminal)return;
  this.terminal=true;const pending=this.pending;this.pending=undefined;
  pending?.reject(Error(nativeFailure));this.onFailure();
 }
}
