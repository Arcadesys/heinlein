import type {LocalCore,RepositorySession} from './localCore';
export interface ProjectResume {path:string;sourceHash:string;sceneId:string|null;anchor:number;head:number;scrollTop:number}
export interface Project {id:string;name:string;revision:number;kind:'local'|'managed';workspaceId:string|null;resume:ProjectResume|null;unavailable:string|null;github:{owner:string;repository:string;accountId:number;branch:string}|null;writingLocation?:string}
export type ProjectRequest={action:'list'}|{action:'settings'|'previewOpen';id:string}|{action:'activate'|'cancel';previewId:string}|{action:'rename';id:string;revision:number;name:string}|{action:'saveResume';repositoryId:string;projectId:string;revision:number;resume:ProjectResume};
export type ProjectResponse=Project[]|Project|RepositorySession|{id:string}|null;
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='')=>{const n=document.createElement(tag);n.textContent=text;return n;};
export function createProjectLibrary(core:LocalCore,hooks:{current():RepositorySession|null;switchProject(id:string):Promise<boolean>;openLocal():Promise<boolean>;openGitHub():void;newDraft():Promise<void>;drafts():Promise<void>;metadata(project:Project):void;focusWriting():void}){
 const element=el('dialog');element.className='project-library github-panel';element.setAttribute('aria-labelledby','project-library-title');
 let generation=0,busy=false,opener:HTMLElement|null=null;
 const title=el('h2','Projects');title.id='project-library-title';title.tabIndex=-1;
 const status=el('p');status.setAttribute('role','status');const body=el('section');
 function controls(){element.querySelectorAll<HTMLButtonElement|HTMLInputElement>('button,input').forEach(b=>b.disabled=busy);element.setAttribute('aria-busy',String(busy));status.setAttribute('aria-busy',String(busy&&!!status.textContent));}
 async function act(run:()=>Promise<void>){if(busy)return;busy=true;controls();try{await run();}catch(e){status.textContent=String(e);}finally{busy=false;controls();}}
 function button(text:string,run:()=>Promise<void>){const b=el('button',text);b.type='button';b.onclick=()=>void act(run);return b;}
 function close(writing=false){generation++;element.close();if(writing)hooks.focusWriting();else opener?.focus();}
 async function request<T>(r:ProjectRequest){if(!core.projectRequest)throw Error('The project library is unavailable in this host.');return await core.projectRequest(r) as T;}
 const div=(cls:string,...kids:Node[])=>{const n=el('div');n.className=cls;n.append(...kids);return n;};
 const para=(text:string,cls='')=>{const n=el('p',text);if(cls)n.className=cls;return n;};
 const origin=(p:Project)=>p.kind==='local'?'Local folder':'Heinlein-managed GitHub copy';
 async function library(){const view=generation;title.textContent='Projects';status.textContent='';const projects=await request<Project[]>({action:'list'});if(!element.open||view!==generation)return;
  const active=projects.find(p=>p.id===hooks.current()?.projectId);if(active)hooks.metadata(active);
  body.replaceChildren(para('Choose the writing you want to return to. Project changes stay on this Mac until you explicitly send them.','project-intro'));
  const addTitle=el('h3','Add a project');addTitle.className='project-section-title';
  const actions=div('project-actions',button('Start or open a folder…',async()=>{if(await hooks.openLocal())close(true);}),button('Bring in from GitHub…',async()=>{close();hooks.openGitHub();}));actions.setAttribute('role','group');actions.setAttribute('aria-label','Add a project');actions.firstElementChild?.classList.add('project-primary');body.append(addTitle,actions);
  const listTitle=el('h3','Your projects');listTitle.id='project-list-title';listTitle.className='project-section-title';body.append(listTitle);
  if(!projects.length)body.append(para('No projects yet. You can keep writing in standalone drafts without setting one up.','project-empty'));
  else{const list=el('ul');list.className='project-list';list.setAttribute('aria-labelledby','project-list-title');
   for(const p of projects){const current=p.id===hooks.current()?.projectId;const row=el('li');row.className='project-row';if(current)row.setAttribute('aria-current','true');if(p.unavailable)row.dataset.unavailable='true';
    const name=el('h4',p.name);name.className='project-name';const heading=div('project-row-heading',name);if(current)heading.append(para('Current project','project-current-label'));
    const where=para('','project-origin');where.append(el('span',origin(p)));if(p.github){const repo=el('span',`${p.github.owner}/${p.github.repository}`);repo.className='project-repository';where.append(repo);}const meta=div('project-row-meta',where);
    if(p.resume)meta.append(para(`Last document: ${p.resume.path}`,'project-resume'));
    if(p.unavailable)meta.append(para(`Unavailable: ${p.unavailable}. Your other projects and drafts are unchanged.`,'project-unavailable'));
    const open=button(`Open ${p.name}`,async()=>{if(await hooks.switchProject(p.id))close(true);else status.textContent='Project not changed. Your current writing is still here; resolve the save or recovery message before switching.';});open.classList.add('project-open');
    const config=button(`Manage ${p.name}`,()=>settings(p.id));config.classList.add('project-settings-link');
    row.append(div('project-row-info',heading,meta),div('project-row-actions',open,config));list.append(row);
   }body.append(list);}
  const draftsTitle=el('h3','Standalone drafts');draftsTitle.className='project-section-title';
  const drafts=el('section');drafts.className='project-drafts';drafts.setAttribute('aria-label','Standalone drafts');drafts.append(draftsTitle,para('Start immediately without a project. Choose a destination later.'),div('project-actions',button('New standalone draft',async()=>{await hooks.newDraft();close(true);}),button('Find standalone drafts',async()=>{close();await hooks.drafts();})));
  const refresh=button('Refresh projects',library);refresh.classList.add('project-quiet');body.append(drafts,div('project-footer',refresh));title.focus();
 }
 function group(heading:string,...kids:Node[]){const s=el('section');s.className='project-settings-group';if(heading)s.append(el('h3',heading));s.append(...kids);return s;}
 async function settings(id:string){const view=generation;const p=await request<Project>({action:'settings',id});if(!element.open||view!==generation)return;hooks.metadata(p);title.textContent=`Manage — ${p.name}`;body.replaceChildren();
  const back=button('← All projects',library);back.classList.add('project-quiet');body.append(div('project-settings-nav',back));
  if(p.unavailable)body.append(para(`Unavailable: ${p.unavailable}. Open another folder from Projects to create a separate entry. Original recovery data is retained; no location is silently replaced.`,'project-unavailable'));
  const label=el('label','Project name'),input=el('input');input.type='text';input.value=p.name;input.maxLength=240;label.append(input);
  const save=button('Save project name',async()=>{const next=await request<Project>({action:'rename',id:p.id,revision:p.revision,name:input.value});hooks.metadata(next);status.textContent='Project name saved. Writing location unchanged.';await settings(p.id);});
  body.append(group('',label,para('Renaming changes this label only. It does not move files or rename a GitHub repository.','project-help'),save));
  const location=el('details');location.className='project-location';location.append(el('summary','Show writing location'),para(p.writingLocation??'Location unavailable','project-path'));
  body.append(group('Writing location',para(origin(p),'project-origin'),location));
  body.append(p.github?group('GitHub',para(`${p.github.owner}/${p.github.repository}`,'project-repository'),para(`Bound GitHub account ID: ${p.github.accountId}. Working branch: ${p.github.branch}.`),para('This binding belongs to this project. Opening it for local writing does not sign in, switch accounts or send changes. Use GitHub actions for explicit account or branch changes.','project-help'))
   :group('GitHub',para('Not connected. An ordinary .git folder does not enable managed GitHub actions. Open a separate managed GitHub project to use Send; files are never copied there automatically.')));
  body.append(group('When I return',para(p.resume?`Return to ${p.resume.path} when its saved source still matches. Changed or missing documents open the overview instead.`:'The last saved source document and position will be remembered when you leave.')));
  body.append(para('Writing goals use the existing writing controls. Appearance and account connections remain global. Publishing and draft placement are separate explicit copies.','project-help project-settings-note'));title.focus();
 }
 function shell(){const back=button('Back to writing',async()=>close(true));back.classList.add('project-back');element.replaceChildren(div('project-library-header',title,back),status,body);status.className='project-status';status.textContent='';}
 element.addEventListener('cancel',e=>{e.preventDefault();if(!busy)close();});
 return{element,supported:!!core.projectRequest,async open(){opener=document.activeElement as HTMLElement;generation++;shell();element.showModal();await act(library);},async settings(id:string){opener=document.activeElement as HTMLElement;generation++;shell();element.showModal();await act(()=>settings(id));},destroy(){generation++;element.remove();}};
}
