// @vitest-environment jsdom
// Real disposable file I/O belongs outside the browser-only TypeScript source tree.
import {mkdtempSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs';import {join} from 'node:path';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';import {mountStudio} from '../src/studio';import type {LocalCore} from '../src/localCore';
const session={id:'file-fixture',projectKey:'synthetic-file-fixture',name:'Synthetic files',manifests:[]};
const raw='---\r\ntitle: 星\r\n---\r\nInvented — 🐺 text.\nMixed newline.\r\n';
const doc=(path:string,text=raw)=>({path,text,contentHash:`hash:${text}`,sizeBytes:new TextEncoder().encode(text).length,frontmatter:null,generatedCompatibility:false});
let app:ReturnType<typeof mountStudio>;
function bridge(){return {core:{available:()=>true,pickRepository:async()=>session,recentRepositories:async()=>[],openRecentRepository:async()=>session,listDirectory:async()=>[],loadManuscript:async()=>{throw Error('No manuscript');},readDocument:vi.fn(async(_id:string,path:string)=>doc(path)),saveDocument:vi.fn(),readRecovery:async()=>null,stageRecovery:vi.fn(),discardRecovery:vi.fn(),setUnsavedChanges:async()=>{},requestClose:async()=>{},onCloseRequested:async()=>()=>{},listSystemFonts:async()=>[]} satisfies LocalCore};}
async function start(core:LocalCore){app=mountStudio(document.body,core);await app.selectRepository(async()=>session);await app.showDocument('a.md');}
function button(label:string){return document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)??[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;}
beforeEach(()=>{localStorage.clear();document.body.replaceChildren();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();});afterEach(()=>app?.destroy());
 it('leaves disposable source-file bytes and modes unchanged across navigation/reference reads',async()=>{
  const folder=mkdtempSync('/private/tmp/heinlein-tab-source-');
  try{
   for(const path of ['a.md','b.md'])writeFileSync(join(folder,path),path==='a.md'?raw:'Invented B — 星.\r\n',{mode:0o600});
   const before=['a.md','b.md'].map(path=>({path,bytes:readFileSync(join(folder,path)),mode:statSync(join(folder,path)).mode}));
   const {core}=bridge();core.readDocument.mockImplementation(async(_id,path)=>doc(path,readFileSync(join(folder,path),'utf8')));
   await start(core);await app.showDocument('b.md');await app.showDocument('a.md');button('Read beside active document: b.md').click();
   await vi.waitFor(()=>expect(document.querySelector('.reference-source')?.textContent).toBe('Invented B — 星.\r\n'));button('Refresh saved source').click();await vi.waitFor(()=>expect(core.readDocument).toHaveBeenCalledTimes(5));
   for(const file of before){expect(readFileSync(join(folder,file.path)).equals(file.bytes)).toBe(true);expect(statSync(join(folder,file.path)).mode).toBe(file.mode);}
   expect(core.stageRecovery).not.toHaveBeenCalled();expect(core.saveDocument).not.toHaveBeenCalled();
  }finally{rmSync(folder,{recursive:true});}
 });

