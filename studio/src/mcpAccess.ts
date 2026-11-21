import type {LocalCore,RepositorySession} from './localCore';
export type McpClient='codex'|'claudeCode'|'claudeDesktop';
export type McpAccessRequest={action:'status'|'revoke'}|{action:'setup';client:McpClient}|{action:'useProject';repositoryId:string}|{action:'useSource';repositoryId:string;path:string};
export interface McpClientSetup {client:McpClient;available:boolean;configured:boolean;command:string}
export interface McpAccessView {projectKey:string|null;scenes:string[];projectWide:boolean;projectName:string|null;setups:McpClientSetup[]}
const CLIENTS:Record<McpClient,{name:string;ready:string;missing:string;manual:string;copied:string}>={
  codex:{name:'Codex',ready:'Start a new Codex chat to use it.',missing:'Codex was not found on this Mac. You can use the setup command below after installing its CLI.',manual:'Run this command in Terminal.',copied:'Setup command copied.'},
  claudeCode:{name:'Claude Code',ready:'Start a new Claude Code session to use it.',missing:'Claude Code was not found on this Mac. You can use the setup command below after installing it.',manual:'Run this command in Terminal.',copied:'Setup command copied.'},
  claudeDesktop:{name:'Claude Desktop',ready:'Quit and reopen Claude Desktop to use it.',missing:'Claude Desktop was not found on this Mac. Install and open it once, then return here.',manual:'In Claude Desktop, choose Settings → Developer → Edit Config, add this entry, then quit and reopen Claude Desktop.',copied:'Setup text copied.'},
};
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const n=document.createElement(tag);n.textContent=text;return n;};
export function createMcpAccessPanel(core:LocalCore,hooks:{current():{session:RepositorySession|null;problem:string|null}}){
  const element=el('dialog');element.className='github-panel mcp-access-panel';element.setAttribute('aria-labelledby','mcp-access-title');
  const title=el('h2','AI connections');title.id='mcp-access-title';title.tabIndex=-1;
  const status=el('p');status.setAttribute('role','status');
  const body=el('section');let generation=0,busy=false,dead=false,opener:HTMLElement|null=null;
  const supported=Boolean(core.mcpRequest&&core.available());
  function close(){if(busy)return;generation++;element.close();opener?.focus();}
  function button(label:string,run:()=>void){const b=el('button',label);b.type='button';b.onclick=run;return b;}
  function controls(){element.querySelectorAll<HTMLButtonElement>('button').forEach(b=>{b.disabled=busy||b.dataset.unavailable==='true';});element.setAttribute('aria-busy',String(busy));}
  async function request(request:McpAccessRequest){if(!core.mcpRequest)throw Error('This host does not support assistant setup.');return core.mcpRequest(request);}
  async function act(run:()=>Promise<void>){if(busy||dead)return;busy=true;controls();const my=generation;try{await run();}catch(error){if(!dead&&my===generation)status.textContent=String(error);}finally{busy=false;if(!dead){controls();if(element.open&&!element.contains(document.activeElement))title.focus();}}}
  function render(view:McpAccessView){
    const current=hooks.current();body.replaceChildren();const anyConfigured=view.setups.some(s=>s.configured);
    if(!anyConfigured)body.append(el('p','Connect an assistant once, then allow your project.'));
    const setup=el('section');setup.className='mcp-connection-step';setup.append(el('h3',anyConfigured?'Assistants':'1. Connect an assistant'));
    for(const client of view.setups){
      const info=CLIENTS[client.client];if(!info)continue;
      const row=el('div');row.className='mcp-client';row.append(el('h4',info.name));
      row.append(el('p',client.configured?`${info.name} configured.`:client.available?'Not connected yet.':info.missing));
      if(!client.configured){
        const connect=button(`Connect ${info.name}`,()=>void act(async()=>{
          const next=await request({action:'setup',client:client.client});if(dead)return;render(next);
          status.textContent=next.setups.find(s=>s.client===client.client)?.configured?`${info.name} setup is ready. ${info.ready}`:`${info.name} setup was not changed.`;
        }));
        if(!client.available)connect.dataset.unavailable='true';row.append(connect);
      }
      const details=el('details');details.append(el('summary','Manual setup'),el('p',info.manual));
      const command=el('textarea');command.readOnly=true;command.rows=client.client==='claudeDesktop'?8:4;command.value=client.command;command.setAttribute('aria-label',`${info.name} setup ${client.client==='claudeDesktop'?'text':'command'}`);details.append(command);
      details.append(button(`Copy ${info.name} setup`,()=>void act(async()=>{try{await navigator.clipboard.writeText(client.command);status.textContent=info.copied;}catch{details.open=true;command.focus();command.select();status.textContent=client.client==='claudeDesktop'?'Copy the selected text, then paste it into Claude Desktop\'s settings file.':'Copy the selected command, then run it in Terminal.';}})));
      row.append(details);setup.append(row);
    }
    body.append(setup);
    const project=el('section');project.className='mcp-connection-step';project.append(el('h3',`${anyConfigured?'':'2. '}${current.session?.name??'Choose a project'}`));
    const granted=view.projectWide&&view.projectKey===current.session?.projectKey;
    if(granted)project.append(el('p',`Project access is enabled · ${view.scenes.length} saved Markdown ${view.scenes.length===1?'file':'files'}. New saved files are included.`));
    else if(view.projectKey===current.session?.projectKey&&view.projectKey)project.append(el('p','Only previously approved files are shared. Allow this project to include all its saved Markdown.'));
    else if(view.projectKey)project.append(el('p',`Assistants currently have access to ${view.projectName??'another project'}. Allowing this project replaces that access.`));
    else project.append(el('p','No project is shared yet.'));
    const shared=el('details');shared.append(el('summary','What is shared'),el('p','Saved Markdown and references, including new files. Connected assistants can suggest revisions; you review and apply them in Heinlein. Unsaved writing, hidden files and ignored files are not shared.'));project.append(shared);
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
