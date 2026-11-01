// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {createProjectLibrary,type Project} from './projects';
import type {LocalCore} from './localCore';
const local:Project={id:'local-stable',name:'River notebook',revision:4,kind:'local',workspaceId:null,resume:null,unavailable:null,github:null};
const managed:Project={id:'managed-stable',name:'Lantern chapters',revision:7,kind:'managed',workspaceId:'workspace-stable',resume:{path:'notes.md',sourceHash:'source-hash',sceneId:null,anchor:3,head:3,scrollTop:0},unavailable:null,github:{owner:'synthetic',repository:'lantern',accountId:9,branch:'writing'}};
let library:ReturnType<typeof createProjectLibrary>|undefined;
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
beforeEach(()=>{document.body.replaceChildren();HTMLDialogElement.prototype.showModal=function(){this.setAttribute('open','');};HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');};});
afterEach(()=>{library?.destroy();library=undefined;});
function setup(projects:Project[]){
 const request=vi.fn(async()=>structuredClone(projects));
 const hooks={current:()=>null,switchProject:vi.fn(async(_id:string)=>true),openLocal:vi.fn(async()=>false),openGitHub:vi.fn(),newDraft:vi.fn(async()=>{}),drafts:vi.fn(async()=>{}),metadata:vi.fn(),focusWriting:vi.fn()};
 library=createProjectLibrary({projectRequest:request} as unknown as LocalCore,hooks);document.body.append(library.element);return{request,hooks};
}
const names=()=>[...library!.element.querySelectorAll('.project-name')].map(n=>n.textContent);
const button=(name:string)=>[...library!.element.querySelectorAll('button')].find(n=>n.textContent===name)!;
it('clearly lists recent opens in native newest-first order, with stable origins and no extra actions',async()=>{
 const f=setup([managed,local]);await library!.open();
 expect(library!.element.querySelector('#project-list-title')?.textContent).toBe('Recently opened');
 expect(names()).toEqual(['Lantern chapters','River notebook']);
 expect(library!.element.textContent).toContain('Projects opened here, newest first.');
 expect(library!.element.textContent).toContain('Heinlein-managed GitHub copy');expect(library!.element.textContent).toContain('Local folder');
 expect(f.request.mock.calls).toEqual([[{action:'list'}]]);expect(f.hooks.switchProject).not.toHaveBeenCalled();expect(f.hooks.openGitHub).not.toHaveBeenCalled();
});
it('reloads native order when returning to Projects and keeps every existing identity/action',async()=>{
 const f=setup([local,managed]);await library!.open();
 button('Open Lantern chapters').click();await tick();expect(f.hooks.switchProject).toHaveBeenCalledWith('managed-stable');
 f.request.mockResolvedValueOnce([managed,local]);await library!.open();expect(names()).toEqual(['Lantern chapters','River notebook']);
 expect(library!.element.querySelectorAll('.project-row')).toHaveLength(2);expect(button('Manage River notebook')).toBeTruthy();expect(button('Start or open a folder…')).toBeTruthy();
 expect(f.request).toHaveBeenCalledTimes(2);
});
it('refreshes the native history without optimistic sorting after a refused open',async()=>{
 const f=setup([local,managed]);f.hooks.switchProject.mockResolvedValue(false);await library!.open();button('Open Lantern chapters').click();await tick();
 expect(names()).toEqual(['River notebook','Lantern chapters']);expect(library!.element.open).toBe(true);
 expect(library!.element.textContent).toContain('Project not changed');button('Refresh projects').click();await tick();
 expect(f.request).toHaveBeenCalledTimes(2);expect(names()).toEqual(['River notebook','Lantern chapters']);
});
it('explains an empty private history and preserves unavailable entries without mixing standalone drafts',async()=>{
 const f=setup([]);await library!.open();expect(library!.element.textContent).toContain('No recently opened projects here yet');
 f.request.mockResolvedValueOnce([{...managed,unavailable:'Writing folder unavailable'},local]);await library!.open();
 expect(names()).toEqual(['Lantern chapters','River notebook']);expect(library!.element.textContent).toContain('Unavailable: Writing folder unavailable');
 expect(library!.element.querySelector('.project-drafts .project-name')).toBeNull();expect(button('New standalone draft')).toBeTruthy();
});
it('distinguishes independent local and managed projects with the same name before opening either',async()=>{
 const f=setup([{...managed,name:'The Zoo'},{...local,name:'The Zoo'}]);await library!.open();
 expect(names()).toEqual(['The Zoo','The Zoo']);
 expect(library!.element.querySelectorAll('.project-copy-warning')).toHaveLength(2);
 expect(library!.element.textContent).toContain('Edits in this project do not automatically appear');
 button('Open The Zoo · GitHub copy').click();await tick();expect(f.hooks.switchProject).toHaveBeenLastCalledWith('managed-stable');
 await library!.open();button('Open The Zoo · Local folder').click();await tick();expect(f.hooks.switchProject).toHaveBeenLastCalledWith('local-stable');
 expect(f.request.mock.calls).toEqual([[{action:'list'}],[{action:'list'}]]);
});
