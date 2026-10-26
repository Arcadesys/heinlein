// @vitest-environment jsdom
import {describe,it,expect,vi} from 'vitest';
import {createRepositoryHome,documentOrigin,sharingStatus} from './repositoryHome';
import type {LocalCore} from './localCore';
const tick=()=>new Promise(r=>setTimeout(r,0));
const session={id:'opaque-session',name:'writer/book',githubWorkspaceId:'opaque-workspace',manifests:[]};
describe('repository-first home',()=>{
 it('opens only through opaque native registry identity, with no folder/auth/send calls',async()=>{
 const calls:string[]=[];const core={available:()=>true,githubRequest:vi.fn(async(r)=>{calls.push(r.action);return r.action==='localProjects'?[{workspaceId:'opaque-workspace',name:'writer/book',branch:'writing',unavailable:null}]:session;})} as unknown as LocalCore;
 const openGitHub=vi.fn(),select=vi.fn(async(run)=>{await run();});const h=createRepositoryHome(core,{openGitHub,select});document.body.replaceChildren(h.element);await h.refresh();
 expect(h.element.textContent).toContain('writer/book');expect(h.element.textContent).not.toContain('opaque-workspace');
 [...h.element.querySelectorAll('button')].find(b=>b.textContent==='Open writer/book')!.click();await tick();expect(calls).toEqual(['localProjects','reopen']);expect(select).toHaveBeenCalledOnce();h.destroy();
 });
 it('retains unavailable identity without offering a folder fallback and ignores late refresh',async()=>{
 let resolve!:(v:unknown)=>void;const core={available:()=>true,githubRequest:()=>new Promise(r=>resolve=r)} as unknown as LocalCore;
 const h=createRepositoryHome(core,{openGitHub:vi.fn(),select:vi.fn()});const refresh=h.refresh();h.destroy();resolve([{workspaceId:'x',name:'late/book',branch:'writing',unavailable:null}]);await refresh;expect(h.element.textContent).not.toContain('late/book');
 });
 it('never labels standalone text as Github-owned or sent; unknown status stays unknown',()=>{
 expect(documentOrigin(session,true)).toBe('Standalone draft');expect(sharingStatus(session,true,false)).toContain('choose a destination later');expect(sharingStatus(session,false,true)).toContain('not yet sent');expect(sharingStatus(session,false,false)).toContain('not checked');expect(sharingStatus({...session,githubWorkspaceId:null},false,false)).toContain('Local folder');
 });
 it('leave refusal cannot call reopen or mount, unavailable copies have recovery text',async()=>{
 const request=vi.fn(async()=>[{workspaceId:'x',name:'writer/book',branch:'writing',unavailable:null},{workspaceId:'y',name:'writer/missing',branch:'writing',unavailable:'Recovery'}]);
 const h=createRepositoryHome({available:()=>true,githubRequest:request} as unknown as LocalCore,{openGitHub:vi.fn(),select:vi.fn(async()=>{})});document.body.replaceChildren(h.element);await h.refresh();[...h.element.querySelectorAll('button')].find(b=>b.textContent==='Open writer/book')!.click();await tick();expect(request).toHaveBeenCalledTimes(1);expect(h.element.textContent).toContain('Unavailable');expect(h.element.textContent).not.toContain('Recovery —');expect([...h.element.querySelectorAll('button')].some(b=>b.textContent==='Open writer/missing')).toBe(false);h.destroy();
 });
});

it('distinguishes saved but uncommitted, committed-unsent and historical-sent without claiming a fresh server check',()=>{
 const evidence={workspaceId:'opaque-workspace',branch:'writing',uncommitted:true,unsentVersion:false,lastSendRecorded:true};
 expect(sharingStatus(session,false,false,evidence)).toContain('Saved changes not yet sent');
 expect(sharingStatus(session,false,false,{...evidence,uncommitted:false,unsentVersion:true,lastSendRecorded:false})).toContain('Saved versions not yet sent');
 expect(sharingStatus(session,false,false,{...evidence,uncommitted:false})).toContain('have not been checked');
 expect(sharingStatus(session,false,true,{...evidence,uncommitted:false})).toContain('Latest edits not yet sent');
 expect(sharingStatus(session,false,false,{...evidence,workspaceId:'other'})).toContain('not checked');
});
