import type {LocalCore,RepositorySession} from './localCore';
export type McpAccessRequest={action:'status'|'revoke'|'setupCodex'}|{action:'useProject';repositoryId:string}|{action:'useSource';repositoryId:string;path:string};
export interface McpAccessView {projectKey:string|null;scenes:string[];projectWide:boolean;projectName:string|null;setup:{available:boolean;configured:boolean;command:string}}
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const n=document.createElement(tag);n.textContent=text;return n;};
export function createMcpAccessPanel(core:LocalCore,hooks:{current():{session:RepositorySession|null;problem:string|null}}){
  const element=el('dialog');element.className='github-panel mcp-access-panel';element.setAttribute('aria-labelledby','mcp-access-title');
  const title=el('h2','Codex connection');title.id='mcp-access-title';title.tabIndex=-1;
  const status=el('p');status.setAttribute('role','status');
  const body=el('section');let generation=0,busy=false,dead=false,opener:HTMLElement|null=null;
  const supported=Boolean(core.mcpRequest&&core.available());
  function close(){if(busy)return;generation++;element.close();opener?.focus();}
  function button(label:string,run:()=>void){const b=el('button',label);b.type='button';b.onclick=run;return b;}
  function controls(){element.querySelectorAll<HTMLButtonElement>('button').forEach(b=>{b.disabled=busy||b.dataset.unavailable==='true';});element.setAttribute('aria-busy',String(busy));}
  async function request(request:McpAccessRequest){if(!core.mcpRequest)throw Error('This host does not support Codex setup.');return core.mcpRequest(request);}
  async function act(run:()=>Promise<void>){if(busy||dead)return;busy=true;controls();const my=generation;try{await run();}catch(error){if(!dead&&my===generation)status.textContent=String(error);}finally{busy=false;if(!dead){controls();if(element.open&&!element.contains(document.activeElement))title.focus();}}}
  function render(view:McpAccessView){
    const current=hooks.current();body.replaceChildren();if(!view.setup.configured)body.append(el('p','Connect Codex once, then allow your project.'));
    const setup=el('section');setup.className='mcp-connection-step';setup.append(el('h3',view.setup.configured?'Codex':'1. Connect Codex'));
    if(view.setup.configured)setup.append(el('p','Codex configured.'));
    const connect=button(view.setup.configured?'Codex configured':'Connect Codex',()=>void act(async()=>{
      const next=await request({action:'setupCodex'});if(dead)return;render(next);status.textContent=next.setup.configured?'Codex setup is ready. Start a new Codex chat to use it.':'Codex setup was not changed.';
    }));
    if(!view.setup.available)connect.dataset.unavailable='true';if(!view.setup.configured)setup.append(connect);
    if(!view.setup.available&&!view.setup.configured)setup.append(el('p','Codex was not found on this Mac. You can use the setup command below after installing its CLI.'));
    const details=el('details');details.append(el('summary','Manual setup command'));
    const command=el('textarea');command.readOnly=true;command.rows=4;command.value=view.setup.command;command.setAttribute('aria-label','Codex setup command');details.append(command);
    details.append(button('Copy setup command',()=>void act(async()=>{try{await navigator.clipboard.writeText(view.setup.command);status.textContent='Setup command copied.';}catch{details.open=true;command.focus();command.select();status.textContent='Copy the selected command, then run it in Terminal.';}})));setup.append(details);body.append(setup);
    const project=el('section');project.className='mcp-connection-step';project.append(el('h3',`${view.setup.configured?'':'2. '}${current.session?.name??'Choose a project'}`));
    const granted=view.projectWide&&view.projectKey===current.session?.projectKey;
    if(granted)project.append(el('p',`Project access is enabled · ${view.scenes.length} saved Markdown ${view.scenes.length===1?'file':'files'}. New saved files are included.`));
    else if(view.projectKey===current.session?.projectKey&&view.projectKey)project.append(el('p','Only previously approved files are shared. Allow this project to include all its saved Markdown.'));
    else if(view.projectKey)project.append(el('p',`Codex currently has access to ${view.projectName??'another project'}. Allowing this project replaces that access.`));
    else project.append(el('p','No project is shared yet.'));
    const shared=el('details');shared.append(el('summary','What is shared'),el('p','Saved Markdown and references, including new files. Codex can suggest revisions; you review and apply them in Heinlein. Unsaved writing, hidden files and ignored files are not shared.'));project.append(shared);
    const allow=button(granted?'Project access enabled':'Allow this project',()=>void act(async()=>{
      const now=hooks.current();if(!now.session||now.problem){status.textContent=now.problem??'Open a project first.';return;}
      const next=await request({action:'useProject',repositoryId:now.session.id});if(dead)return;render(next);status.textContent=next.projectWide&&next.projectKey===now.session.projectKey?'Project access is saved.':'Project access was not changed.';
    }));
    if(granted||!current.session||current.problem)allow.dataset.unavailable='true';if(!granted)project.append(allow);
    if(!current.session)project.append(el('p','Open a project, then return here. You do not need to open a scene.'));
    if(current.problem)project.append(el('p',current.problem));body.append(project);
    revoke.dataset.unavailable=String(!view.projectKey);controls();
  }
  const revoke=button('Disconnect project access',()=>void act(async()=>{const view=await request({action:'revoke'});if(dead)return;render(view);status.textContent='Project access disconnected. Saved proposals remain available for your review.';}));
  const done=button('Back to writing',close);element.append(title,status,body,revoke,done);
  element.addEventListener('cancel',e=>{e.preventDefault();close();});
  return{element,supported,async open(){if(!supported||dead)return;generation++;opener=document.activeElement as HTMLElement;status.textContent='';revoke.dataset.unavailable='false';body.replaceChildren();element.showModal();title.focus();await act(async()=>{const view=await request({action:'status'});if(!dead)render(view);});},destroy(){dead=true;generation++;element.remove();}};
}
