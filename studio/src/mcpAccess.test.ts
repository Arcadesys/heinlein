// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createMcpAccessPanel,type McpAccessView} from './mcpAccess';
import type {LocalCore,RepositorySession} from './localCore';
let panel:ReturnType<typeof createMcpAccessPanel>|undefined;
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setTimeout(r,0));};
beforeEach(()=>{document.body.replaceChildren();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>panel?.destroy());
function setup(){
  let state:McpAccessView={projectKey:null,scenes:[],projectWide:false,projectName:null,setup:{available:true,configured:false,command:"codex mcp add heinlein -- '/Applications/Synthetic Studio' --heinlein-mcp '/private/synthetic selection'"}};
  const current:{session:RepositorySession|null;problem:string|null}={session:{id:'session-a',name:'Project A',projectKey:'project-a',manifests:[]},problem:null};
  const request=vi.fn(async(r:Parameters<NonNullable<LocalCore['mcpRequest']>>[0])=>{
    if(r.action==='useProject')state={...state,projectKey:current.session!.projectKey!,projectName:current.session!.name,projectWide:true,scenes:['scene.md','notes/reference.md']};
    if(r.action==='revoke')state={...state,projectKey:null,projectName:null,projectWide:false,scenes:[]};
    if(r.action==='setupCodex')state={...state,setup:{...state.setup,configured:true}};
    return structuredClone(state);
  });
  panel=createMcpAccessPanel({available:()=>true,mcpRequest:request} as unknown as LocalCore,{current:()=>current});document.body.append(panel.element);
  return{current,request,state:(next:Partial<McpAccessView>)=>{state={...state,...next};}};
}
function button(name:string){return [...panel!.element.querySelectorAll('button')].find(b=>b.textContent===name)!;}
it('grants an entire project without opening a source, persists status and explicitly switches/revokes',async()=>{
  const f=setup();await panel!.open();expect(f.request.mock.calls).toEqual([[{action:'status'}]]);expect(panel!.element.textContent).toContain('No project is shared yet.');
  expect(panel!.element.textContent).not.toContain('Allow this source');button('Allow this project').click();await tick();
  expect(f.request).toHaveBeenLastCalledWith({action:'useProject',repositoryId:'session-a'});expect(panel!.element.textContent).toContain('Project access is enabled · 2 saved Markdown files');expect(button('Allow this project')).toBeUndefined();
  button('Back to writing').click();await panel!.open();expect(panel!.element.textContent).toContain('Project access is enabled');
  button('Back to writing').click();f.current.session={id:'session-b',name:'Project B',projectKey:'project-b',manifests:[]};await panel!.open();expect(panel!.element.textContent).toContain('Codex currently has access to Project A');
  button('Allow this project').click();await tick();expect(f.request).toHaveBeenLastCalledWith({action:'useProject',repositoryId:'session-b'});
  button('Disconnect project access').click();await tick();expect(panel!.element.textContent).toContain('No project is shared yet.');expect(panel!.element.textContent).toContain('Saved proposals remain');
});
it('does not expand a legacy per-file selection until the author chooses project access',async()=>{
  const f=setup();f.state({projectKey:'project-a',projectName:'Project A',scenes:['scene.md'],projectWide:false});await panel!.open();expect(panel!.element.textContent).toContain('Only previously approved files are shared.');
  expect(f.request.mock.calls).toEqual([[{action:'status'}]]);expect(button('Allow this project').disabled).toBe(false);
});
it('keeps Codex setup separate from project permission and never reports an unverified connection as live',async()=>{
  const f=setup();await panel!.open();button('Connect Codex').click();await tick();expect(f.request).toHaveBeenLastCalledWith({action:'setupCodex'});expect(panel!.element.textContent).toContain('Codex configured.');
  expect(panel!.element.textContent).toContain('Start a new Codex chat');expect(f.request.mock.calls.some(([r])=>r.action==='useProject')).toBe(false);
});
it('blocks project changes during structural operations but keeps revocation available after status failure',async()=>{
  const f=setup();f.current.problem='Finish the current project change.';await panel!.open();expect(button('Allow this project').disabled).toBe(true);
  button('Back to writing').click();f.request.mockRejectedValueOnce(Error('Access needs recovery'));await panel!.open();expect(panel!.element.textContent).toContain('Access needs recovery');expect(button('Disconnect project access').disabled).toBe(false);
});
it('allows Codex setup without a project, and shows manual selection when clipboard access fails',async()=>{
  const f=setup();f.current.session=null;await panel!.open();expect(button('Allow this project').disabled).toBe(true);expect(button('Connect Codex').disabled).toBe(false);
  button('Copy setup command').click();await tick();expect(panel!.element.querySelector('details')!.open).toBe(true);expect(document.activeElement?.tagName).toBe('TEXTAREA');
  expect(panel!.element.textContent).toContain('Copy the selected command');expect(f.request.mock.calls.some(([r])=>r.action==='useProject')).toBe(false);
});
