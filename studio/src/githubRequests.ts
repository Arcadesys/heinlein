import type {LocalCore} from './localCore';
import type {GitHubRequest,GitHubResponse} from './githubTypes';

// Native GitHub requests share one nonblocking operation lock, including the
// credential-free local metadata reads. Keep a renderer's calls in arrival order
// rather than letting its own status refresh reject an explicit author action.
// This is scheduling only: no retries, provider calls, credential caching or new authority.
const queues=new WeakMap<LocalCore,Promise<void>>();
// Share only an overlapping status request, and only until another request is
// queued. Never retain credentials or a settled status across author actions.
const pendingStatus=new WeakMap<LocalCore,Promise<unknown>>();
export function requestGitHub<T=GitHubResponse>(core:LocalCore,request:GitHubRequest):Promise<T>{
 if(request.action==='status'){
  const pending=pendingStatus.get(core);
  if(pending)return pending.then(value=>structuredClone(value)) as Promise<T>;
 }else pendingStatus.delete(core);
 const previous=queues.get(core)??Promise.resolve();
 const result=previous.then(()=>{
  if(!core.githubRequest)throw new Error('GitHub projects are available in the native Heinlein app.');
  return core.githubRequest(request) as Promise<T>;
 });
 const settled=result.then(()=>{},()=>{});queues.set(core,settled);
 if(request.action==='status'){
  pendingStatus.set(core,result);
  void settled.then(()=>{if(pendingStatus.get(core)===result)pendingStatus.delete(core);});
 }
 void settled.then(()=>{if(queues.get(core)===settled)queues.delete(core);});
 return request.action==='status' ? result.then(value=>structuredClone(value)) : result;
}
