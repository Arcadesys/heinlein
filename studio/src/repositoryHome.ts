import {requestGitHub} from './githubRequests';
import type {LocalCore, RepositorySession} from './localCore';
import type {GitHubLocalProject,GitHubLocalEvidence} from './githubTypes';
const node = <K extends keyof HTMLElementTagNameMap>(tag:K,text='') => {const n=document.createElement(tag);n.textContent=text;return n;};
/** Registry identities only. This view never chooses a root or reads credentials. */
export function createRepositoryHome(core:LocalCore, hooks:{openGitHub():void;select(run:()=>Promise<RepositorySession|null>):Promise<void>}) {
  const element=node('section');element.className='repository-home';element.setAttribute('aria-label','GitHub repositories');
  const open=node('button','Open from GitHub…');open.type='button';open.className='primary';open.addEventListener('click',hooks.openGitHub);
  const list=node('section');list.setAttribute('aria-label','Recent GitHub repositories');
  const message=node('p');message.setAttribute('role','status');
  let generation=0,disposed=false;
  element.append(open,node('p','Heinlein keeps your writing on this Mac. Sending changes to GitHub is a separate action.'),list,message);
  async function refresh(){
    const view=++generation;
    if(!core.githubRequest||!core.available()){list.replaceChildren(node('p','Open the Heinlein app to use GitHub repositories.'));return;}
    try {
      const projects=await requestGitHub(core,{action:'localProjects'}) as GitHubLocalProject[];
      if(disposed||view!==generation)return;
      list.replaceChildren(node('h3','Recent GitHub repositories'));message.textContent='';
      if(!projects.length)list.append(node('p','No GitHub repositories opened yet.'));
      for(const p of projects){
        const row=node('div');row.append(node('p',`${p.name} · Working branch: ${p.branch}`));
        if(p.unavailable){row.append(node('p','Unavailable — open GitHub actions for recovery.'));}
        else {const b=node('button',`Open ${p.name}`);b.type='button';b.addEventListener('click',()=>{b.disabled=true;void hooks.select(()=>requestGitHub(core,{action:'reopen',workspaceId:p.workspaceId}) as Promise<RepositorySession>).catch(e=>{message.textContent=String(e);}).finally(()=>{if(!disposed&&view===generation)b.disabled=false;});});row.append(b);}
        list.append(row);
      }
    }catch{if(!disposed&&view===generation){list.replaceChildren();message.textContent='Recent GitHub repositories are unavailable. Open GitHub actions to check recovery; local folders and Drafts are still available.';}}
  }
  return{element,refresh,destroy(){disposed=true;generation++;}};
}
export function documentOrigin(session:RepositorySession|null,standalone:boolean){return standalone?'Standalone draft':session?.name??'Heinlein Studio';}
export function sharingStatus(session:RepositorySession|null,standalone:boolean,dirty:boolean,evidence:GitHubLocalEvidence|null=null){
  if(standalone)return 'Standalone draft · kept on this Mac · choose a destination later.';
  if(!session?.githubWorkspaceId)return session?'Local folder · saved here; no GitHub connection.':'';
  if(!dirty&&evidence?.workspaceId===session.githubWorkspaceId){
    if(evidence.uncommitted)return 'Saved changes not yet sent to GitHub. Choose Send to GitHub when you are ready. It creates a version of your selected changes before upload.';
    if(evidence.unsentVersion)return 'Saved versions not yet sent to GitHub. Choose Send when you are ready.';
    if(evidence.lastSendRecorded)return 'A successful Send is recorded for this branch. Newer GitHub changes and other local files have not been checked.';
    return 'No Send is recorded here. GitHub status has not been checked. Use GitHub actions to review saved versions.';
  }
  return dirty?'Latest edits not yet sent to GitHub.':'GitHub send status not checked. Use GitHub actions to review saved versions and the last send.';
}
