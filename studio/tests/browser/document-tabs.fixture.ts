import {mountStudio} from '../../src/studio';
import {syntheticProjects} from '../projectBridge';
import {EditorView} from '@codemirror/view';
import {applyAppearance,loadAppearance} from '../../src/appearance';
import '../../src/fonts.bundle';import '../../src/style.css';
const fixture=syntheticProjects();const generic=new URLSearchParams(location.search).has('generic');
if(!generic)fixture.seedMovement();
const titled=new URLSearchParams(location.search).has('titled');
const paths=titled?['ms/sheet-e639a476-5de0-4c85-90f8-9b9638baf869.md','ms/sheet-92aad4f6-0522-4288-95e9-e5cb090df46b.md']:generic?['first-reading.md','second-reading.md']:['ms/arrival.md','ms/meeting.md'];
if(titled){const scenes=fixture.manuscripts['local-a'].scenes;for(const [i,id] of ['scene-arrival','scene-meeting'].entries()){const scene=scenes.find(scene=>scene.id===id)!;scene.path=paths[i];scene.title=i?'The morning after':'Harvest Moon';}}
const raw=(name:string)=>`---\r\ntitle: Synthetic ${name}\r\n---\r\n`+Array.from({length:48},(_,i)=>`Paragraph ${i+1}: Invented foxes read a map — 星 🦊. This synthetic passage keeps deliberate fragments, long wrapped lines and mixed newlines. No real writing is used.\r\n`).join('\n');
paths.forEach((p,i)=>fixture.documents['local-a'][p]=raw(i?'Meeting':'Arrival'));
const notice=document.createElement('p');notice.className='synthetic-project-notice';notice.textContent='Synthetic sample';notice.hidden=true; document.title='Synthetic document workspace';notice.style.padding='.25rem';notice.style.border='1px solid currentColor';
const app=mountStudio(document.querySelector<HTMLElement>('#app')!,fixture.core);
Object.assign(window,{documentFixture:{fixture,app,paths,theme:(high:boolean)=>applyAppearance({...loadAppearance(),theme:high?'contrast':loadAppearance().theme}),view:()=>EditorView.findFromDOM(document.querySelector('.active-document-pane .cm-editor') as HTMLElement)}});
void(async()=>{
 const tick=()=>new Promise(r=>setTimeout(r,0));
 for(let i=0;i<10;i++)await tick();
 document.querySelector<HTMLButtonElement>('.project-switcher')!.click();
 for(let i=0;i<10;i++)await tick();
 [...document.querySelectorAll<HTMLButtonElement>('.project-library button')].find(b=>b.textContent==='Open Novel A')!.click();
 for(let i=0;i<10;i++)await tick();
 await app.showDocument(paths[1]);await app.showDocument(paths[0]);
 document.querySelector<HTMLButtonElement>('[aria-label="Read beside…"]')!.click();
 document.querySelector<HTMLButtonElement>(`[aria-label="Read beside active document: ${titled?'The morning after':generic?paths[1]:'Meeting'}"]`)!.click();
 for(let i=0;i<10;i++)await tick();
 document.querySelector('.document-workspace')!.prepend(notice);
 document.documentElement.dataset.tabsReady='true';
})();
