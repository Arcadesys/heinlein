// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {mountStudio} from './studio';
import {initializePreferences,preferenceStorage,flushPreferences,type PreferenceSnapshot} from './preferences';
import type {LocalCore} from './localCore';
let app:ReturnType<typeof mountStudio>|undefined;
afterEach(async()=>{app?.destroy();app=undefined;await initializePreferences({available:()=>false});document.body.replaceChildren();vi.restoreAllMocks();});
function fixture(){
 let close:(()=>void)|undefined;let fail=false;
 let disk:PreferenceSnapshot={schemaVersion:1,revision:1,migrated:true,values:{'heinlein-studio-zoom-v1':'150','heinlein-studio-fonts-v1':'{"text":"Courier New"}','heinlein-studio-writing-v1':'{"version":1,"goal":1250,"days":{}}'},legacy:{}};
 const core={available:()=>true,preferencesRequest:vi.fn(async r=>{if(fail&&r.kind==='set')throw Error('Synthetic disk full');if(r.kind==='set')disk={...disk,revision:disk.revision+1,values:{...disk.values,[r.key]:r.value}};return structuredClone(disk);}),pickRepository:vi.fn(async()=>null),recentRepositories:vi.fn(async()=>[]),openRecentRepository:vi.fn(),listDirectory:vi.fn(async()=>[]),loadManuscript:vi.fn(),readDocument:vi.fn(),listSystemFonts:vi.fn(async()=>[]),saveDocument:vi.fn(),readRecovery:vi.fn(),stageRecovery:vi.fn(),discardRecovery:vi.fn(),setUnsavedChanges:vi.fn(async()=>{}),requestClose:vi.fn(async()=>{}),finishQuitRequest:vi.fn(async()=>{}),onCloseRequested:vi.fn(async fn=>{close=fn;return()=>{};})} satisfies LocalCore;
 return{core,read:()=>disk,close:()=>close?.(),fail:()=>{fail=true;}};
}
async function start(core:LocalCore){
 localStorage.clear();Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>new DOMRect();
 HTMLDialogElement.prototype.showModal??=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close??=function(){this.removeAttribute('open');};
 await initializePreferences(core);document.body.append(document.createElement('div'));app=mountStudio(document.body.firstElementChild as HTMLElement,core);await vi.waitFor(()=>expect(core.onCloseRequested).toHaveBeenCalled());
}
it('loads persisted choices before mounting and stores later settings outside WebKit',async()=>{
 const x=fixture();await start(x.core);
 expect(document.documentElement.dataset.zoom).toBe('150');expect(document.documentElement.style.getPropertyValue('--font-text')).toContain('Courier New');expect(document.querySelector('.pill-goal')?.getAttribute('aria-label')).toContain('1,250');
 preferenceStorage().setItem('heinlein-studio-zoom-v1','175');await flushPreferences();expect(x.read().values['heinlein-studio-zoom-v1']).toBe('175');expect(localStorage.length).toBe(0);
});
it('keeps a failed setting visible and offers a deliberate close without losing writing through a forced quit',async()=>{
 const x=fixture();await start(x.core);x.fail();preferenceStorage().setItem('heinlein-studio-zoom-v1','175');await expect(flushPreferences()).rejects.toThrow('disk full');
 expect(document.querySelector('.preference-warning')?.textContent).toContain('not saved');x.close();await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved settings"]')).not.toBeNull());
 const button=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===label)!;
 button('Keep app open').click();await vi.waitFor(()=>expect(x.core.finishQuitRequest).toHaveBeenCalled());expect(x.core.requestClose).not.toHaveBeenCalled();
 x.close();await vi.waitFor(()=>expect(document.querySelector('[aria-label="Unsaved settings"]')).not.toBeNull());button('Close with last saved settings').click();await vi.waitFor(()=>expect(x.core.requestClose).toHaveBeenCalledWith(true));
 expect(x.core.saveDocument).not.toHaveBeenCalled();expect(x.read().values['heinlein-studio-zoom-v1']).toBe('150');
});
