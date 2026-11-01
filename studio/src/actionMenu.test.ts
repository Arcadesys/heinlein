// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {actionMenu} from './actionMenu';
import {attachMenu} from './menu';

afterEach(()=>document.body.replaceChildren());
for(const activation of ['click','ArrowDown'])describe(`nested action menu via ${activation}`,()=>{
 it('keeps its trigger visible and menu within the modal until dismissed',()=>{
  const root=document.createElement('main'),trigger=document.createElement('button');trigger.textContent='Chapters';document.body.append(root);
  const run=vi.fn(),nested=attachMenu(trigger,'Chapters',()=>[{label:'Opening',current:true},{label:'Middle',run}]);
  const actions=actionMenu('More actions',[trigger],root);root.append(actions.button,actions.storage);actions.button.click();
  const dialog=root.querySelector('dialog')!;
  if(activation==='click')trigger.click();else trigger.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
  const menu=document.querySelector('[role=menu]');expect(actions.isOpen()).toBe(true);expect(trigger.closest('[hidden]')).toBeNull();expect(dialog.contains(menu)).toBe(true);expect(menu?.contains(document.activeElement)).toBe(true);
  document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));expect(nested.isOpen()).toBe(false);expect(document.activeElement).toBe(trigger);expect(actions.isOpen()).toBe(true);
  trigger.click();dialog.querySelector<HTMLButtonElement>(':scope > button')!.click();expect(nested.isOpen()).toBe(false);expect(document.querySelector('[role=menu]')).toBeNull();expect(document.activeElement).toBe(actions.button);
  actions.button.click();trigger.click();root.querySelectorAll<HTMLButtonElement>('[role=menuitem]')[1].click();expect(run).toHaveBeenCalledOnce();expect(actions.isOpen()).toBe(false);expect(nested.isOpen()).toBe(false);
  nested.destroy();actions.destroy();
 });
});
