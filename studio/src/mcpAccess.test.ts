// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createMcpAccessPanel,type McpAccessView} from './mcpAccess';
import type {LocalCore,RepositorySession} from './localCore';
let panel:ReturnType<typeof createMcpAccessPanel>|undefined;
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setTimeout(r,0));};
beforeEach(()=>{document.body.replaceChildren();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>panel?.destroy());
function setup(){
  let state:McpAccessView={projectKey:null,scenes:[]};
  const current:{session:RepositorySession|null;path:string|null;problem:string|null}={session:{id:'session-a',name:'Project A',projectKey:'project-a',manifests:[]},path:'scene.md',problem:null};
  const request=vi.fn(async(r:Parameters<NonNullable<LocalCore['mcpRequest']>>[0])=>{
    if(r.action==='useSource')state={projectKey:current.session!.projectKey!,scenes:[r.path]};
    if(r.action==='revoke')state={projectKey:null,scenes:[]};
    return structuredClone(state);
  });
  panel=createMcpAccessPanel({available:()=>true,mcpRequest:request} as unknown as LocalCore,{current:()=>current});document.body.append(panel.element);
  return{current,request};
}
function button(name:string){return [...panel!.element.querySelectorAll('button')].find(b=>b.textContent===name)!;}
it('opens without granting access, then uses exact current project/source and supports switching/revocation',async()=>{
  const f=setup();await panel!.open();expect(f.request.mock.calls).toEqual([[{action:'status'}]]);expect(panel!.element.textContent).toContain('No project files are allowed.');
  button('Allow this source file…').click();await tick();expect(f.request).toHaveBeenLastCalledWith({action:'useSource',repositoryId:'session-a',path:'scene.md'});expect(panel!.element.textContent).toContain('Allowed source files in this project:');
  button('Back to writing').click();f.current.session={id:'session-b',name:'Project B',projectKey:'project-b',manifests:[]};f.current.path='other.md';await panel!.open();expect(panel!.element.textContent).toContain('A different project is currently allowed');
  button('Allow this source file…').click();await tick();expect(f.request).toHaveBeenLastCalledWith({action:'useSource',repositoryId:'session-b',path:'other.md'});
  button('Disconnect all project access').click();await tick();expect(panel!.element.textContent).toContain('No project files are allowed.');expect(panel!.element.textContent).toContain('Saved proposals remain');
});
it('blocks new access while writing is unsaved and keeps revocation available after a status failure',async()=>{
  const f=setup();f.current.problem='Save your writing first.';await panel!.open();expect(button('Allow this source file…').disabled).toBe(true);expect(panel!.element.textContent).toContain('Save your writing first.');
  button('Back to writing').click();f.request.mockRejectedValueOnce(Error('Selection needs recovery'));await panel!.open();expect(panel!.element.textContent).toContain('Selection needs recovery');expect(button('Disconnect all project access').disabled).toBe(false);expect(f.request.mock.calls.some(([r])=>r.action==='useSource')).toBe(false);
});
