import {mountStudio} from '../../src/studio';
import {syntheticProjects,type ProjectSeed} from '../projectBridge';
import '../../src/fonts.bundle';import '../../src/style.css';
const moving=new URLSearchParams(location.search).has('movement-demo');const key=moving?'heinlein-synthetic-manuscript-moves-v1':'heinlein-synthetic-project-demo-v1';
let seed:ProjectSeed|undefined;try{seed=JSON.parse(sessionStorage.getItem(key)??'null')??undefined;}catch{}
const fixture=syntheticProjects(seed,state=>sessionStorage.setItem(key,JSON.stringify(state)));
if(moving&&!fixture.manuscripts['local-a'])fixture.seedMovement();
if((new URLSearchParams(location.search).has('manuscript')||new URLSearchParams(location.search).has('manuscript-demo'))&&!fixture.manuscripts['local-a'])fixture.seedManuscript('local-a');
if(new URLSearchParams(location.search).has('save-failure'))fixture.setFailSave(true);
if(new URLSearchParams(location.search).has('missing'))fixture.projects[1].unavailable='Synthetic original folder is missing; not recreated';
const notice=document.createElement('p');notice.className='synthetic-project-notice';notice.setAttribute('role','note');notice.textContent='Synthetic project preview — no real files, accounts or uploads. Project and draft demo data stay in this tab.';document.body.prepend(notice);
const app=mountStudio(document.querySelector<HTMLElement>('#app')!,fixture.core);Object.assign(window,{projectFixture:fixture,projectApp:app});

if(new URLSearchParams(location.search).has('library'))queueMicrotask(()=>document.querySelector<HTMLButtonElement>('.project-switcher')?.click());

// Demo navigation uses ordinary production controls, never a native-authority shortcut.
if(new URLSearchParams(location.search).has('manuscript-demo')||moving)void(async()=>{
 const settle=async()=>{for(let i=0;i<6;i++)await new Promise(r=>setTimeout(r,0));};
 const click=async(find:()=>HTMLButtonElement|undefined)=>{for(let i=0;i<50;i++){const b=find();if(b&&!b.disabled){b.click();await settle();return;}await settle();}throw Error('Synthetic demo navigation unavailable');};
 await settle();await click(()=>document.querySelector<HTMLButtonElement>('.project-switcher')??undefined);
 await click(()=>[...document.querySelectorAll<HTMLButtonElement>('.project-library button')].find(b=>b.textContent==='Open Novel A'));
 const toggle=document.querySelector<HTMLButtonElement>('.navigation-toggle');if(toggle?.getAttribute('aria-expanded')!=='true'){toggle?.click();await settle();}
 await click(()=>document.querySelector<HTMLButtonElement>('#navigation-tab-manuscript')??undefined);
})();
