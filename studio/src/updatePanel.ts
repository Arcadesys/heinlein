import type {LocalCore} from './localCore';
export interface UpdateStatus {state:string;commit?:string|null;tree?:string|null;availableCommit?:string|null;availableTree?:string|null;generation?:number|null;step?:string|null;channel?:string|null;currentVersion?:string|null;availableVersion?:string|null}
const messages:Record<string,string>={
  'release-not-checked':'No release check yet. Checks contact the public Heinlein release page without using your GitHub account.',
  'release-current':'No newer published Heinlein Studio release is available. Local builds can be newer than published downloads.',
  'release-available':'A newer Heinlein Studio release is available. Open the download page, then save and quit before replacing the app.',
  'release-check-failed':'The release check failed. Keep writing offline and try Check for updates again later.',
  unavailable:'Updates are available in the managed macOS app. Local writing remains available.',
  'not-checked':'No update check yet. Checks contact only the Heinlein main-source repository.',
  current:'This app is current on the main-source channel.',
  available:'A newer main-source build is available.',
  scheduled:'Update requested for the next launch. Your running app has not been replaced.',
  running:'Heinlein is already running. Finish writing before opening it again to update.',
  'startup-uncertain':'The app may still be starting. Nothing will be replaced or stopped while it may be running.',
  'rolled-back':'The previous valid app was restored. Your writing and saved accounts were not rolled back.',
  'fetch-failed':'The update source could not be checked. You can keep writing offline and explicitly check again later.',
  'build-recovery-required':'Interrupted or in-use builds have reached the safety limit. Keep writing. Wait for an active build to finish, or arrange supervised updater-cache maintenance; retained app rollback bundles are unchanged.',
  'build-failed':'The new app could not be built. The previous app remains available.',
  'sign-failed':'The new app could not be signed. The previous app remains available.',
  'signature-failed':'App integrity verification failed. Keep the previous app and resolve the installation before updating.',
  busy:'Another launch or update check is in progress. Wait, then check again.',
};
export function createUpdatePanel(core:LocalCore,options:{quit:()=>Promise<void>}){
  const element=document.createElement('dialog');element.className='update-panel';element.setAttribute('aria-labelledby','update-panel-title');
  const heading=document.createElement('h2');heading.id='update-panel-title';heading.textContent='Heinlein updates';heading.tabIndex=-1;
  const status=document.createElement('p');status.setAttribute('role','status');
  const notice=document.createElement('div');notice.className='update-notice';notice.hidden=true;notice.setAttribute('role','status');notice.setAttribute('aria-atomic','true');
  const announcement=document.createElement('span');
  const noticeButton=document.createElement('button');noticeButton.type='button';noticeButton.append(announcement);notice.append(noticeButton);
  let latest:UpdateStatus|null=null,destroyed=false,timer:ReturnType<typeof setTimeout>|undefined,interval:ReturnType<typeof setInterval>|undefined;
  function announce(value:UpdateStatus){
    if(destroyed)return;latest=value;
    const label=value.state==='available'||value.state==='release-available'?'Update available…':value.state==='scheduled'?'Update scheduled…':/failed|rolled-back|recovery-required/.test(value.state)?'Update needs attention…':'';
    notice.hidden=!label;announcement.textContent=label;
  }
  noticeButton.onclick=()=>{void open()};
  const details=document.createElement('p');let openedFrom:HTMLElement|null=null,busy=false,generation=0,pending:Promise<void>=Promise.resolve(),unavailable=false;
  function close(){generation++;element.close();openedFrom?.focus();}
  const button=(label:string,run:()=>Promise<void>)=>{const b=document.createElement('button');b.type='button';b.textContent=label;b.onclick=()=>{void act(run)};return b;};
  const exit=button('Close updates',async()=>close());
  const check=button('Check for updates',async()=>load('check'));
  const schedule=button('Update on next launch',async()=>load('schedule'));
  const download=button('Open release download page',async()=>load('openRelease'));
  const quit=button('Save and quit when ready',async()=>{try{await options.quit()}catch{status.textContent='Heinlein could not quit safely. Keep the app open and finish any save or GitHub operation. If a renewed connection was not saved, close Updates, open GitHub projects and choose Retry saved GitHub connection before quitting again.'}});
  function render(value:UpdateStatus){
    status.textContent=messages[value.state]??'The update could not finish safely. Keep writing with the previous app, then explicitly check again.';
    details.textContent=value.channel==='release'?`Release channel · Installed ${value.currentVersion??'unknown'}${value.availableVersion?` · Latest published ${value.availableVersion}`:''}. Checks contact only the public Heinlein release service. Your writing and GitHub account are not sent. Downloads are installed manually after saving and quitting.`:`Main-source channel${value.commit?` · Installed ${value.commit.slice(0,12)}`:''}${value.availableCommit?` · Available ${value.availableCommit.slice(0,12)}`:''}${value.generation!=null?` · Install ${value.generation}`:''}. Saved GitHub credentials stay in the same OS store. macOS may ask you to allow access after an ad-hoc signed update; this is not a sign-out.`;
    download.hidden=value.channel!=='release';explanation.hidden=value.channel==='release';
    unavailable=value.state==='unavailable';schedule.hidden=value.state!=='available';quit.hidden=value.state!=='scheduled';check.disabled=unavailable;
  }
  async function load(action:'status'|'check'|'schedule'|'openRelease'){
    const current=generation;
    if(!core.updateRequest){render({state:'unavailable'});return;}
    status.textContent=action==='check'?'Checking for Heinlein updates…':'Reading update status…';
    const value=await core.updateRequest(action);
    announce(value);if(element.open&&current===generation)render(value);
  }
  function act(run:()=>Promise<void>){
    if(busy)return pending;
    const view=generation;busy=true;[check,schedule,quit,download].forEach(b=>b.disabled=true);element.setAttribute('aria-busy','true');
    pending=run().catch(()=>{announce({state:'release-check-failed'});if(element.open&&view===generation)status.textContent='The update check is unavailable. Your running app, writing and saved accounts are unchanged. Try again later.'}).finally(()=>{busy=false;[check,schedule,quit,download].forEach(b=>b.disabled=false);check.disabled=unavailable;element.removeAttribute('aria-busy')});return pending;
  }
  exit.onclick=close;
  const explanation=document.createElement('p');explanation.textContent='Updates build the trusted Heinlein main source locally. Nothing replaces the app while it is running. You can defer an update and keep writing; quitting uses the normal save and recovery checks. Python, Node/npm, Rust and Apple build tools are required.';
  element.append(heading,exit,status,details,explanation,check,schedule,download,quit);schedule.hidden=true;quit.hidden=true;download.hidden=true;
  element.addEventListener('cancel',event=>{event.preventDefault();close()});
  async function open(action:'status'|'check'='status'){if(element.open){if(action==='check')await act(()=>load('check'));return;}openedFrom=document.activeElement as HTMLElement;const view=++generation;element.showModal();heading.focus();await pending;if(element.open&&view===generation)await act(()=>load(action))}
  async function poll(){
    if(destroyed||busy||!core.updateRequest||latest?.state==='scheduled')return;
    await act(async()=>{
      const value=await core.updateRequest!('status');announce(value);
      if(value.state!=='scheduled'&&value.state!=='unavailable'){
        const checked=await core.updateRequest!('check');announce(checked);if(element.open)render(checked);
      }
    });
  }
  function startChecking(){if(timer||interval||destroyed)return;timer=setTimeout(()=>{void poll()},5000);interval=setInterval(()=>{if(document.visibilityState==='visible')void poll()},60*60*1000);}
  return{element,notice,startChecking,poll,open:()=>open(),checkNow:()=>open('check'),destroy(){destroyed=true;generation++;clearTimeout(timer);clearInterval(interval);element.remove();notice.remove()}};
}
