import type {LocalCore} from './localCore';
import type {GitHubRequest,GitHubResponse} from './githubTypes';

// Native GitHub requests share one nonblocking operation lock, including the
// credential-free local metadata reads. Keep a renderer's calls in arrival order
// rather than letting its own status refresh reject an explicit author action.
// This is scheduling only: no retries, provider calls, caching or new authority.
const queues=new WeakMap<LocalCore,Promise<void>>();
export function requestGitHub<T=GitHubResponse>(core:LocalCore,request:GitHubRequest):Promise<T>{
 const previous=queues.get(core)??Promise.resolve();
 const result=previous.then(()=>{
  if(!core.githubRequest)throw new Error('GitHub projects are available in the native Heinlein app.');
  return core.githubRequest(request) as Promise<T>;
 });
 const settled=result.then(()=>{},()=>{});queues.set(core,settled);
 void settled.then(()=>{if(queues.get(core)===settled)queues.delete(core);});
 return result;
}
