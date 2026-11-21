// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {createWritingChrome} from './writingChrome';
let control:ReturnType<typeof createWritingChrome>|undefined;
afterEach(()=>{control?.destroy();control=undefined;document.body.replaceChildren();});
const tick=()=>new Promise(r=>setTimeout(r,0));
function setup(){const root=document.createElement('main');root.innerHTML='<header class="status-pill"></header><div class="notice-slot"><p class="status"></p></div><div class="document-command-bar"></div><div class="reference-pane"></div><div contenteditable="true" class="writer">Exact — writing</div>';document.body.append(root);const hooks={focusWriting:vi.fn(()=>root.querySelector<HTMLElement>('.writer')!.focus()),changed:vi.fn(),canHide:()=>true};control=createWritingChrome(root,hooks);root.querySelector('.status-pill')!.append(control.hideButton);root.append(control.element);return{root,hooks,bar:root.querySelector<HTMLElement>('.document-command-bar')!};}
it('hides presentation controls without editing text and restores their original accessibility state',()=>{
 const f=setup();f.bar.inert=true;f.bar.setAttribute('aria-hidden','true');const before=f.root.querySelector('.writer')!.textContent;control!.hide();expect(control!.hidden).toBe(true);expect(f.root.querySelector<HTMLElement>('.status-pill')!.inert).toBe(true);expect(f.root.querySelector('.writer')!.textContent).toBe(before);expect(f.hooks.focusWriting).toHaveBeenCalledOnce();control!.show();expect(f.bar.inert).toBe(true);expect(f.bar.getAttribute('aria-hidden')).toBe('true');expect(f.root.querySelector('.status-pill')!.hasAttribute('aria-hidden')).toBe(false);
});
it('provides a keyboard way out and makes the word goal optional',()=>{
 setup();control!.setGoal('12 / 1,000 words','Daily word goal');control!.hide();expect(control!.element.querySelector<HTMLElement>('.focus-word-goal')!.hidden).toBe(true);control!.setGoalVisible(true);expect(control!.element.querySelector<HTMLElement>('.focus-word-goal')!.hidden).toBe(false);document.dispatchEvent(new KeyboardEvent('keydown',{key:'H',ctrlKey:true,shiftKey:true,bubbles:true}));expect(control!.hidden).toBe(false);expect(document.activeElement).toBe(control!.hideButton);
});
it('keeps recovery dialogs and save errors visible, including asynchronous errors after hiding',async()=>{
 const f=setup();const dialog=document.createElement('dialog');dialog.setAttribute('open','');f.root.append(dialog);control!.hide();expect(control!.hidden).toBe(false);dialog.remove();control!.hide();expect(control!.hidden).toBe(true);const status=f.root.querySelector('.status')!;status.classList.add('error');status.textContent='Save failed';await tick();expect(control!.hidden).toBe(false);control!.hide();expect(control!.hidden).toBe(false);
});
it('protects replacement toolbars while hidden and reveals for a newly opened dialog',async()=>{
 const f=setup();control!.hide();const toolbar=document.createElement('div');toolbar.className='standalone-toolbar';f.root.append(toolbar);await tick();expect(toolbar.inert).toBe(true);const dialog=document.createElement('dialog');dialog.setAttribute('open','');f.root.append(dialog);await tick();expect(control!.hidden).toBe(false);expect(toolbar.inert).not.toBe(true);
});
