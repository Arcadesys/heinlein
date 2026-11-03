import type {LocalCore,RepositorySession} from './localCore';
export type McpAccessRequest={action:'status'|'revoke'}|{action:'useSource';repositoryId:string;path:string};
export interface McpAccessView {projectKey:string|null;scenes:string[]}
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const n=document.createElement(tag);n.textContent=text;return n;};
export function createMcpAccessPanel(core:LocalCore,hooks:{current():{session:RepositorySession|null;path:string|null;problem:string|null}}){
  const element=el('dialog');element.className='github-panel mcp-access-panel';element.setAttribute('aria-labelledby','mcp-access-title');
  const title=el('h2','MCP connection');title.id='mcp-access-title';title.tabIndex=-1;
  const status=el('p');status.setAttribute('role','status');
  const body=el('section');let generation=0,busy=false,dead=false,opener:HTMLElement|null=null;
  const supported=Boolean(core.mcpRequest&&core.available());
  function close(){if(busy)return;generation++;element.close();opener?.focus();}
  function button(label:string,run:()=>void){const b=el('button',label);b.type='button';b.onclick=run;return b;}
  function controls(){element.querySelectorAll<HTMLButtonElement>('button').forEach(b=>{b.disabled=busy||b.dataset.unavailable==='true';});element.setAttribute('aria-busy',String(busy));}
  async function request(request:McpAccessRequest){if(!core.mcpRequest)throw Error('This host does not support MCP connection setup.');return core.mcpRequest(request);}
  async function act(run:()=>Promise<void>){if(busy||dead)return;busy=true;controls();const my=generation;try{await run();}catch(error){if(!dead&&my===generation)status.textContent=String(error);}finally{busy=false;if(!dead){controls();if(element.open&&!element.contains(document.activeElement))title.focus();}}}
  function render(view:McpAccessView){
    const current=hooks.current();body.replaceChildren(el('p','Your connected AI client can read only the saved source files you allow here and propose revisions. Its model provider and privacy settings apply to text it reads. Apply a proposal only after reviewing it in MCP proposals. Unsaved text is not exposed.'));
    body.append(el('h3',current.session?.name??'Choose a project'));
    if(view.projectKey){
      body.append(el('p',view.projectKey===current.session?.projectKey?'Allowed source files in this project:':'A different project is currently allowed. Allowing this source replaces that selection.'));
      const list=el('ul');for(const path of view.scenes){const row=el('li',path);row.className='project-path';list.append(row);}body.append(list);
    }else body.append(el('p','No project files are allowed.'));
    const source=el('p',current.path??'Open a source Markdown file first.');source.className='project-path';body.append(el('h3','Current source file'),source);
    const allow=button('Allow this source file…',()=>void act(async()=>{
      const now=hooks.current();if(!now.session||!now.path||now.problem){status.textContent=now.problem??'Open a saved source Markdown file first.';return;}
      const next=await request({action:'useSource',repositoryId:now.session.id,path:now.path});if(dead)return;render(next);status.textContent='MCP selection checked. Only the listed saved files are available.';
    }));
    if(!current.session||!current.path||current.problem){allow.dataset.unavailable='true';allow.disabled=true;}
    body.append(allow);
    if(current.problem)body.append(el('p',current.problem));
    body.append(el('p','To use another project, open it and a source file, then allow that file here. Add more source files one at a time. The existing Codex connection follows your selection; old read snapshots expire when it changes.'));
    const setup=el('details');setup.append(el('summary','One-time Codex setup'),el('p','Configure the local Heinlein MCP server with its Studio selection directory once. This does not expose a project until you allow a source file here. See the local MCP setup instructions supplied with Heinlein.'));body.append(setup);
    controls();
  }
  const revoke=button('Disconnect all project access',()=>void act(async()=>{const view=await request({action:'revoke'});if(dead)return;render(view);status.textContent='Project access disconnected. Saved proposals remain available for author review.';}));
  const done=button('Back to writing',close);element.append(title,status,body,revoke,done);
  element.addEventListener('cancel',e=>{e.preventDefault();close();});
  return{element,supported,async open(){if(!supported||dead)return;generation++;opener=document.activeElement as HTMLElement;status.textContent='';body.replaceChildren();element.showModal();title.focus();await act(async()=>{const view=await request({action:'status'});if(!dead)render(view);});},destroy(){dead=true;generation++;element.remove();}};
}
