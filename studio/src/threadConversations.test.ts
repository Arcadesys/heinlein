// @vitest-environment jsdom
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createQuestionPanel} from './questionPanel';
import {conversationKey,loadConversation,saveConversation} from './questionHistoryStore';
import {readThreads,setThreadStatus,type ThreadScope} from './threadStore';
import type {LocalCore,QuestionRequest,QuestionStatus} from './localCore';
let panel:ReturnType<typeof createQuestionPanel>;
let scope:ThreadScope;
const ready:QuestionStatus={configured:true,model:'model',selectedModel:'model',models:[{slug:'model',displayName:'Model'}],accounts:[{id:'account',label:'Account',signedIn:true,planEnabled:true}],activeAccountId:'account',generation:1,usageLimited:false,signInPending:false,message:'Ready'};
const core={available:()=>true,questionStatus:vi.fn(async()=>ready),cancelQuestion:vi.fn(async()=>true),askQuestion:vi.fn(async(r:QuestionRequest)=>({requestId:r.requestId,model:'model',text:'A saved answer.',incomplete:false}))};
const button=(name:string)=>[...panel.element.querySelectorAll('button')].find(b=>b.textContent===name)!;
async function mount(){panel=createQuestionPanel(core as unknown as LocalCore,{current:()=>({repositoryId:'repo',projectKey:'book',path:scope.path??'chapter',source:'Rain fell.',from:0,to:0,canCapture:true}),threadScope:()=>scope,focusEditor:()=>{}});document.body.append(panel.element);panel.open();await vi.waitFor(()=>expect(panel.element.textContent).toContain('Ready'));}
async function ask(text:string){const input=panel.element.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!;input.value=text;input.dispatchEvent(new Event('input'));button('Send to OpenAI').click();await vi.waitFor(()=>expect(panel.element.textContent).toContain('A saved answer.'));}
beforeEach(()=>{localStorage.clear();document.body.replaceChildren();core.askQuestion.mockClear();scope={kind:'scene',id:'a',label:'First scene',path:'a.md'};});afterEach(()=>panel?.destroy());
it('saves separate scene conversations, restores their exact history and never sends another scene’s turns',async()=>{
 await mount();await ask('First scene question');const first=readThreads('book')[0];panel.close();scope={kind:'scene',id:'b',label:'Second scene',path:'b.md'};panel.open();await vi.waitFor(()=>expect(panel.element.textContent).toContain('Ready'));expect(panel.element.querySelector('.question-transcript')!.textContent).not.toContain('First scene question');await ask('Second scene question');expect(core.askQuestion.mock.calls[1][0].history).toEqual([]);
 panel.close();scope=first.scope;panel.open();await vi.waitFor(()=>expect(panel.element.querySelector('.question-transcript')!.textContent).toContain('First scene question'));expect(readThreads('book')).toHaveLength(2);expect(loadConversation(first.storageKey!).turns[0].question).toBe('First scene question');
});
it('allows multiple discussions per scene and reopens a chosen thread without restoring revision authority',async()=>{
 await mount();await ask('First discussion');const first=readThreads('book')[0];panel.openConversation();await ask('Second discussion');expect(readThreads('book')).toHaveLength(2);panel.openConversation(first);expect(panel.element.querySelector('.question-transcript')!.textContent).toContain('First discussion');expect(panel.element.querySelector('.question-transcript')!.textContent).not.toContain('Second discussion');expect(panel.element.querySelector('.question-revision-actions button')).toBeNull();
});
it('retains the earlier project conversation without silently assigning it to a scene',async()=>{
 const key=conversationKey('book','account','model');saveConversation(key,{turns:[{question:'Old project question',answer:{requestId:'old',model:'model',text:'Old project answer',incomplete:false},contextBytes:0}],draft:'Old draft',forgotten:0});await mount();expect(panel.element.querySelector('.question-transcript')!.textContent).not.toContain('Old project question');const legacy=readThreads('book')[0];expect(legacy.scope.kind).toBe('project');expect(loadConversation(key).draft).toBe('Old draft');panel.openConversation(legacy);expect(panel.element.querySelector('.question-transcript')!.textContent).toContain('Old project question');
});

it('reads another connection’s saved thread locally without sending its history',async()=>{
 await mount();await ask('Saved discussion');const first=readThreads('book')[0];panel.openConversation({...first,accountId:'other-account'});const input=panel.element.querySelector<HTMLTextAreaElement>('[aria-label="Your drafting question"]')!;input.value='A follow-up';input.dispatchEvent(new Event('input'));expect(button('Send to OpenAI').disabled).toBe(true);expect(panel.element.querySelector('.question-transcript')!.textContent).toContain('Saved discussion');expect(core.askQuestion).toHaveBeenCalledTimes(1);
});
it('keeps newly written chat discoverable after clearing its previous thread',async()=>{
 await mount();await ask('Before clearing');button('Clear conversation').click();await ask('After clearing');expect(readThreads('book')).toHaveLength(1);expect(readThreads('book')[0].title).toBe('After clearing');
});

it('reopens a resolved discussion when the writer sends a new question',async()=>{
 await mount();await ask('First question');const first=readThreads('book')[0];setThreadStatus('book',first.id,'resolved');panel.openConversation({...first,status:'resolved'});await ask('A new question');expect(readThreads('book')[0].status).toBe('open');
});
