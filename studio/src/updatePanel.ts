import type {LocalCore} from './localCore';
export interface UpdateStatus {state:string;commit?:string|null;tree?:string|null;availableCommit?:string|null;availableTree?:string|null;generation?:number|null;step?:string|null}
const messages:Record<string,string>={
  unavailable:'Updates are available in the managed macOS app. Local writing remains available.',
  'not-checked':'No update check yet. Checks contact only the Heinlein main-source repository.',
  current:'This app is current on the main-source channel.',
  available:'A newer main-source build is available.',
  scheduled:'Update requested for the next launch. Your running app has not been replaced.',
  running:'Heinlein is already running. Finish writing before opening it again to update.',
  'startup-uncertain':'The app may still be starting. Nothing will be replaced or stopped while it may be running.',
  'rolled-back':'The previous valid app was restored. Your writing and saved accounts were not rolled back.',
  'fetch-failed':'The update source could not be checked. You can keep writing offline and explicitly check again later.',
  'build-failed':'The new app could not be built. The previous app remains available.',
  'sign-failed':'The new app could not be signed. The previous app remains available.',
  'signature-failed':'App integrity verification failed. Keep the previous app and resolve the installation before updating.',
  busy:'Another launch or update check is in progress. Wait, then check again.',
};
export function createUpdatePanel(core:LocalCore,options:{quit:()=>Promise<void>}){
  const element=document.createElement('dialog');element.className='update-panel';element.setAttribute('aria-labelledby','update-panel-title');
  const heading=document.createElement('h2');heading.id='update-panel-title';heading.textContent='Heinlein updates';heading.tabIndex=-1;
  const status=document.createElement('p');status.setAttribute('role','status');
  const details=document.createElement('p');let openedFrom:HTMLElement|null=null,busy=false,generation=0,pending:Promise<void>=Promise.resolve(),unavailable=false;
  function close(){generation++;element.close();openedFrom?.focus();}
  const button=(label:string,run:()=>Promise<void>)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{void act(run)};return b;};
  const exit=button('Close updates',async()=>close());
  const check=button('Check for updates',async()=>load('check'));
  const schedule=button('Update on next launch',async()=>load('schedule'));
  const quit=button('Save and quit when ready',async()=>{try{await options.quit()}catch{status.textContent='Heinlein could not quit safely. Keep the app open and finish any save or GitHub operation. If a renewed connection was not saved, close Updates, open GitHub projects and choose Retry saved GitHub connection before quitting again.'}});
  function render(value:UpdateStatus){
    status.textContent=messages[value.state]??'The update could not finish safely. Keep writing with the previous app, then explicitly check again.';
    details.textContent=`Main-source channel${value.commit?` · Installed ${value.commit.slice(0,12)}`:''}${value.availableCommit?` · Available ${value.availableCommit.slice(0,12)}`:''}${value.generation!=null?` · Install ${value.generation}`:''}. Saved GitHub credentials stay in the same OS store. macOS may ask you to allow access after an ad-hoc signed update; this is not a sign-out.`;
    unavailable=value.state==='unavailable';schedule.hidden=value.state!=='available';quit.hidden=value.state!=='scheduled';check.disabled=unavailable;
  }
  async function load(action:'status'|'check'|'schedule'){
    const current=generation;
    if(!core.updateRequest){render({state:'unavailable'});return;}
    status.textContent=action==='check'?'Checking the main-source channel…':'Reading update status…';
    const value=await core.updateRequest(action);
    if(element.open&&current===generation)render(value);
  }
  function act(run:()=>Promise<void>){
    if(busy)return pending;
    const view=generation;busy=true;[check,schedule,quit].forEach(b=>b.disabled=true);element.setAttribute('aria-busy','true');
    pending=run().catch(()=>{if(element.open&&view===generation)status.textContent='The update check is unavailable. Your running app, writing and saved accounts are unchanged. Try again later.'}).finally(()=>{busy=false;[check,schedule,quit].forEach(b=>b.disabled=false);check.disabled=unavailable;element.removeAttribute('aria-busy')});return pending;
  }
  exit.onclick=close;
  const explanation=document.createElement('p');explanation.textContent='Updates build the trusted Heinlein main source locally. Nothing replaces the app while it is running. You can defer an update and keep writing; quitting uses the normal save and recovery checks. Python, Node/npm, Rust and Apple build tools are required.';
  element.append(heading,exit,status,details,explanation,check,schedule,quit);schedule.hidden=true;quit.hidden=true;
  element.addEventListener('cancel',event=>{event.preventDefault();close()});
  return{element,async open(){openedFrom=document.activeElement as HTMLElement;const view=++generation;element.showModal();heading.focus();await pending;if(element.open&&view===generation)await act(()=>load('status'))},destroy(){generation++;element.remove()}};
}
