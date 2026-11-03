import {EditorView} from '@codemirror/view';
import {StateEffect} from '@codemirror/state';
import {createEditor} from '../../src/editor';
import '../../src/fonts.bundle';
import '../../src/style.css';

// Invented source only. This page never reads manuscripts, native stores or accounts.
const baseline='START SENTINEL — e\u0301 🦊\r\n\r\n'+Array.from({length:120},(_,i)=>`Paragraph ${i+1}. Preserve this complete synthetic paragraph, its em dash — and Unicode 🦊.\r\n\r\n`).join('')+'END SENTINEL — all later notes survive.\r\n';
const target='Paragraph 60. Preserve this complete synthetic paragraph, its em dash — and Unicode 🦊.';
const savedKey='heinlein-synthetic-editor-paste-v1';
const root=document.querySelector<HTMLElement>('#app')!;
root.style.cssText='max-width:1000px;margin:24px auto;padding:16px';
const title=document.createElement('h1');title.textContent='Synthetic editor selection test';
const status=document.createElement('p');status.setAttribute('role','status');status.style.fontSize='24px';
const controls=document.createElement('div'),host=document.createElement('div');
const notice=document.createElement('p');notice.setAttribute('role','status');notice.style.cssText='min-height:3em;font-size:24px';
host.style.cssText='height:520px;overflow:auto;border:2px solid currentColor;margin-top:20px';
root.append(title,status,controls,notice,host);
const events:Record<string,unknown>[]=[],changes:Record<string,unknown>[]=[];
let editor:ReturnType<typeof createEditor>;
function snapshot(){
  if(!editor)return;
  const text=editor.text(),selection=editor.view.state.selection.main;
  const data={text,baselineLength:baseline.length,length:text.length,intact:text===baseline,anchor:selection.anchor,head:selection.head,events,changes};
  status.textContent=`${text.length} characters. ${text===baseline?'Full source intact.':'Source changed.'} ${changes.length} changes.`;
  (window as unknown as {webkit?:{messageHandlers:{probe:{postMessage(data:unknown):void}}}}).webkit?.messageHandlers.probe.postMessage(data);
}
const save=()=>{sessionStorage.setItem(savedKey,editor.text());snapshot();};
editor=createEditor(host,sessionStorage.getItem(savedKey)??baseline,()=>snapshot(),save,undefined,message=>{notice.textContent=message;});
editor.view.dispatch({effects:StateEffect.appendConfig.of(EditorView.updateListener.of(update=>{
  if(update.docChanged){const spans:unknown[]=[];update.changes.iterChanges((from,to,_a,_b,insert)=>spans.push({from,to,insertLength:insert.length}));changes.push({spans,origin:update.transactions.map(t=>t.isUserEvent('input')?'input':t.isUserEvent('delete')?'delete':'other')});}
  snapshot();
}))});
editor.view.dispatch({effects:StateEffect.appendConfig.of(EditorView.clipboardInputFilter.of(text=>{events.push({type:'CodeMirror paste input',length:text.length});return text;}))});
for(const name of ['beforeinput','input','paste','keydown','compositionstart','compositionend'])editor.view.contentDOM.addEventListener(name,event=>{
  const e=event as InputEvent;
  const paste=event as ClipboardEvent;
  events.push({type:e.type,inputType:e.inputType,trusted:e.isTrusted,dataLength:e.data?.length,clipboardTypes:paste.clipboardData?[...paste.clipboardData.types]:undefined});
  snapshot();
},true);
function button(label:string,run:()=>void){const b=document.createElement('button');b.textContent=label;b.onclick=run;controls.append(b);}
button('Reset synthetic document',()=>{editor.replaceText(baseline);events.splice(0);changes.splice(0);snapshot();});
button('Show target paragraph',()=>{const at=editor.view.state.doc.toString().indexOf(target);editor.view.dispatch({selection:{anchor:at},scrollIntoView:true});editor.view.focus();snapshot();});
button('Save synthetic source',save);
Object.assign(window,{editorAutomationFixture:{editor,baseline,target,snapshot,events,changes}});
snapshot();
