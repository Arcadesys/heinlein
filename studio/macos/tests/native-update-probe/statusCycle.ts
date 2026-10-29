export interface BackendEvent {stage:string;action:string;index:number;held?:boolean;state?:string}
export const statusReturns=(events:BackendEvent[])=>events.filter(e=>e.action==='status'&&e.stage==='returned').length;
// A stale rendered value cannot prove completion of this new dialog's status IPC.
export function freshStatusCycle(before:number,events:BackendEvent[],open:boolean,busy:boolean,enabled:boolean){
  return open&&!busy&&enabled&&statusReturns(events)>before;
}
