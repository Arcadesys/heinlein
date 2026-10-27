import {it,expect,vi} from 'vitest';
import type {LocalCore} from './localCore';
import type {GitHubRequest} from './githubTypes';
import {requestGitHub} from './githubRequests';
it('holds both local metadata reads and foreground requests behind the same native operation',async()=>{
 const releases:(()=>void)[]=[],calls:string[]=[];let active=false;const core={githubRequest:vi.fn(async(r:GitHubRequest)=>{if(active)throw Error('Another GitHub operation is running');active=true;calls.push(r.action);try{await new Promise<void>(r=>releases.push(r));return null;}finally{active=false;}})} as unknown as LocalCore;
 const a=requestGitHub(core,{action:'localProjects'}),b=requestGitHub(core,{action:'localProject',repositoryId:'session'}),c=requestGitHub(core,{action:'workspace',repositoryId:'session'});
 await Promise.resolve();expect(calls).toEqual(['localProjects']);releases.shift()!();await a;await Promise.resolve();expect(calls).toEqual(['localProjects','localProject']);releases.shift()!();await b;await Promise.resolve();expect(calls).toEqual(['localProjects','localProject','workspace']);releases.shift()!();await c;expect(active).toBe(false);
});
it('a refused operation does not poison or automatically retry the queue',async()=>{const raw=vi.fn().mockRejectedValueOnce(Error('Other window is busy')).mockResolvedValueOnce(null),core={githubRequest:raw} as unknown as LocalCore;const a=requestGitHub(core,{action:'localProjects'}),b=requestGitHub(core,{action:'localProjects'});await expect(a).rejects.toThrow('Other window is busy');await expect(b).resolves.toBeNull();expect(raw).toHaveBeenCalledTimes(2);});
it('queues are scoped to the same native bridge, not unrelated windows',async()=>{let release!:()=>void;const a={githubRequest:()=>new Promise<void>(r=>release=r)} as unknown as LocalCore,b={githubRequest:vi.fn(async()=>null)} as unknown as LocalCore;const pending=requestGitHub(a,{action:'localProjects'});await requestGitHub(b,{action:'localProjects'});expect(b.githubRequest).toHaveBeenCalledOnce();release();await pending;});
