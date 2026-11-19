// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createMcpAccessPanel,type McpAccessView} from './mcpAccess';
import type {LocalCore,RepositorySession} from './localCore';
let panel:ReturnType<typeof createMcpAccessPanel>|undefined;
const tick=async()=>{for(let i=0;i<4;i++)await new Promise(r=>setTimeout(r,0));};
beforeEach(()=>{document.body.replaceChildren();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>panel?.destroy());
function setup(){
  let state:McpAccessView={projectKey:null,scenes:[],projectWide:false,projectName:null,setups:[
    {client:'codex',available:true,configured:false,command:"codex mcp add heinlein -- '/Applications/Synthetic Studio' --heinlein-mcp '/private/synthetic selection'"},
    {client:'claudeCode',available:true,configured:false,command:"claude mcp add --scope user heinlein -- '/Applications/Synthetic Studio' --heinlein-mcp '/private/synthetic selection'"},
    {client:'claudeDesktop',available:false,configured:false,command:'{"mcpServers":{"heinlein":{"command":"/Applications/Synthetic Studio","args":["--heinlein-mcp","/private/synthetic selection"]}}}'},
  ]};
  const current:{session:RepositorySession|null;problem:string|null}={session:{id:'session-a',name:'Project A',projectKey:'project-a',manifests:[]},problem:null};
  const request=vi.fn(async(r:Parameters<NonNullable<LocalCore['mcpRequest']>>[0])=>{
    if(r.action==='useProject')state={...state,projectKey:current.session!.projectKey!,projectName:current.session!.name,projectWide:true,scenes:['scene.md','notes/reference.md']};
    if(r.action==='revoke')state={...state,projectKey:null,projectName:null,projectWide:false,scenes:[]};
    if(r.action==='setup'){const client=r.client;state={...state,setups:state.setups.map(s=>s.client===client?{...s,configured:true}:s)};}
    return structuredClone(state);
  });
  panel=createMcpAccessPanel({available:()=>true,mcpRequest:request} as unknown as LocalCore,{current:()=>current});document.body.append(panel.element);
  return{current,request,get:()=>state,state:(next:Partial<McpAccessView>)=>{state={...state,...next};}};
}
function button(name:string){return [...panel!.element.querySelectorAll('button')].find(b=>b.textContent===name)!;}
it('grants an entire project without opening a source, persists status and explicitly switches/revokes',async()=>{
  const f=setup();await panel!.open();expect(f.request.mock.calls).toEqual([[{action:'status'}]]);expect(panel!.element.textContent).toContain('No project is shared yet.');
  expect(panel!.element.textContent).not.toContain('Allow this source');button('Allow this project').click();await tick();
  expect(f.request).toHaveBeenLastCalledWith({action:'useProject',repositoryId:'session-a'});expect(panel!.element.textContent).toContain('Project access is enabled · 2 saved Markdown files');expect(button('Allow this project')).toBeUndefined();
  button('Back to writing').click();await panel!.open();expect(panel!.element.textContent).toContain('Project access is enabled');
  button('Back to writing').click();f.current.session={id:'session-b',name:'Project B',projectKey:'project-b',manifests:[]};await panel!.open();expect(panel!.element.textContent).toContain('Assistants currently have access to Project A');
  button('Allow this project').click();await tick();expect(f.request).toHaveBeenLastCalledWith({action:'useProject',repositoryId:'session-b'});
  button('Disconnect project access').click();await tick();expect(panel!.element.textContent).toContain('No project is shared yet.');expect(panel!.element.textContent).toContain('Saved proposals remain');
});
it('does not expand a legacy per-file selection until the author chooses project access',async()=>{
  const f=setup();f.state({projectKey:'project-a',projectName:'Project A',scenes:['scene.md'],projectWide:false});await panel!.open();expect(panel!.element.textContent).toContain('Only previously approved files are shared.');
  expect(f.request.mock.calls).toEqual([[{action:'status'}]]);expect(button('Allow this project').disabled).toBe(false);
});
it('keeps Codex setup separate from project permission and never reports an unverified connection as live',async()=>{
  const f=setup();await panel!.open();button('Connect Codex').click();await tick();expect(f.request).toHaveBeenLastCalledWith({action:'setup',client:'codex'});expect(panel!.element.textContent).toContain('Codex configured.');
  expect(panel!.element.textContent).toContain('Start a new Codex chat');expect(f.request.mock.calls.some(([r])=>r.action==='useProject')).toBe(false);
});
it('blocks project changes during structural operations but keeps revocation available after status failure',async()=>{
  const f=setup();f.current.problem='Finish the current project change.';await panel!.open();expect(button('Allow this project').disabled).toBe(true);
  button('Back to writing').click();f.request.mockRejectedValueOnce(Error('Access needs recovery'));await panel!.open();expect(panel!.element.textContent).toContain('Access needs recovery');expect(button('Disconnect project access').disabled).toBe(false);
});
it('allows Codex setup without a project, and shows manual selection when clipboard access fails',async()=>{
  const f=setup();f.current.session=null;await panel!.open();expect(button('Allow this project').disabled).toBe(true);expect(button('Connect Codex').disabled).toBe(false);
  button('Copy Codex setup').click();await tick();expect(panel!.element.querySelector('details')!.open).toBe(true);expect(document.activeElement?.tagName).toBe('TEXTAREA');
  expect(panel!.element.textContent).toContain('Copy the selected command');expect(f.request.mock.calls.some(([r])=>r.action==='useProject')).toBe(false);
});
it('connects Claude Code and Claude Desktop separately, with their own next steps',async()=>{
  const f=setup();await panel!.open();
  expect(panel!.element.querySelector('h2')!.textContent).toBe('AI connections');
  expect([...panel!.element.querySelectorAll('.mcp-client h4')].map(h=>h.textContent)).toEqual(['Codex','Claude Code','Claude Desktop']);
  expect(button('Connect Claude Desktop').disabled).toBe(true);expect(panel!.element.textContent).toContain('Claude Desktop was not found on this Mac.');
  button('Connect Claude Code').click();await tick();expect(f.request).toHaveBeenLastCalledWith({action:'setup',client:'claudeCode'});
  expect(panel!.element.textContent).toContain('Claude Code configured.');expect(panel!.element.textContent).toContain('Start a new Claude Code session');
  expect(panel!.element.textContent).not.toContain('Codex configured.');expect(button('Connect Codex').disabled).toBe(false);
  f.state({setups:f.get().setups.map(s=>s.client==='claudeDesktop'?{...s,available:true}:s)});
  button('Back to writing').click();await panel!.open();button('Connect Claude Desktop').click();await tick();
  expect(f.request).toHaveBeenLastCalledWith({action:'setup',client:'claudeDesktop'});expect(panel!.element.textContent).toContain('Quit and reopen Claude Desktop');
  expect(f.request.mock.calls.some(([r])=>r.action==='useProject')).toBe(false);
});
