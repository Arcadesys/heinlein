import {test,expect,type Locator} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const high of [false,true])test(`Manuscript pointer and keyboard moves, contrast=${high}`,async({page},info)=>{
 test.setTimeout(90000);
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('/tests/browser/projects.html?movement-demo');await expect(page.locator('html')).toHaveAttribute('data-demo-ready','true');
 const pane=page.getByRole('tabpanel',{name:'Binder',exact:true});await expect(pane.getByRole('button',{name:'Add scene',exact:true})).toBeVisible();
 if(high){await page.getByRole('button',{name:'Appearance',exact:false}).click();await page.getByRole('button',{name:'High contrast',exact:true}).click();await page.keyboard.press('Escape');}
 for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');
 const snapshot=()=>page.evaluate(()=>{const f=(window as any).projectFixture,s=f.state();return{m:s.manuscripts['local-a'],docs:s.documents['local-a'],calls:f.draftingCalls,external:f.externalCalls};});
 const initial=await snapshot();
 const grip=(kind:string,id:string)=>pane.locator(`[data-move-kind="${kind}"][data-move-id="${id}"]`);
 async function capture(name:string,target:Locator){await target.scrollIntoViewIfNeeded();await page.screenshot({path:info.outputPath(name),fullPage:false});}
 // Genuine browser DragEvents/DataTransfer exercise the production pointer handlers.
 // Scrolling the pane between source and target is explicit; no DOM/state reordering.
 async function drag(source:Locator,target:Locator){await source.scrollIntoViewIfNeeded();const dataTransfer=await page.evaluateHandle(()=>new DataTransfer());await source.dispatchEvent('dragstart',{dataTransfer});await target.scrollIntoViewIfNeeded();const box=(await target.boundingBox())!,clientX=box.x+box.width/2,clientY=box.y+box.height*.7;await target.dispatchEvent('dragover',{dataTransfer,clientX,clientY});await expect(target).toHaveClass(/move-drop-active/);await target.dispatchEvent('drop',{dataTransfer,clientX,clientY});await source.dispatchEvent('dragend',{dataTransfer});await dataTransfer.dispose();}
 const end=pane.locator('.manuscript-boundary-target').first();
 await drag(grip('group','group-opening'),end);
 let review=page.getByRole('dialog',{name:'Review manuscript change'});await expect(review).toBeVisible();
 expect((await snapshot()).m).toEqual(initial.m);await capture('01-chapter-preview.png',review);
 await review.getByRole('button',{name:'Apply change',exact:true}).click();
 await expect(grip('group','group-opening')).toBeFocused();
 let s=await snapshot();expect(s.m.groups.map((g:any)=>g.id)).toEqual(['group-middle','group-empty','group-ending','group-opening']);expect(s.m.scenes.map((x:any)=>x.id)).toEqual(['scene-lead','scene-bridge','scene-finale','scene-tail','scene-arrival','scene-meeting']);expect(s.docs).toEqual(initial.docs);
 await capture('02-chapter-moved.png',pane.locator('[data-group-id="group-opening"]'));
 await drag(grip('scene','scene-bridge'),pane.locator('[data-group-id="group-ending"]'));
 await expect(review).toBeVisible();await review.getByRole('button',{name:'Apply change',exact:true}).click();
 s=await snapshot();expect(s.m.scenes.find((x:any)=>x.id==='scene-bridge').groupId).toBe('group-ending');expect(s.m.scenes.map((x:any)=>x.id)).toEqual(['scene-lead','scene-finale','scene-bridge','scene-tail','scene-arrival','scene-meeting']);expect(s.docs).toEqual(initial.docs);
 await capture('03-scene-moved.png',pane.locator('[data-group-id="group-ending"]'));
 const beforeCancel=await snapshot();await drag(grip('group','group-opening'),pane.locator('[data-group-id="group-middle"]'));
 await expect(review).toBeVisible();await review.getByRole('button',{name:'Cancel',exact:true}).click();
 expect((await snapshot()).m).toEqual(beforeCancel.m);expect((await snapshot()).docs).toEqual(initial.docs);
 // Enter opens the same intent planner; choosing a position never applies by itself.
 await grip('group','group-opening').focus();await page.keyboard.press('Enter');
 let form=page.getByRole('dialog',{name:'Move Opening',exact:true});await expect(form.getByRole('combobox',{name:'New position'})).toBeFocused();
 const choose=form.getByRole('combobox',{name:'New position'});await choose.press('b');await page.keyboard.press('Tab');await expect(choose).toHaveValue(JSON.stringify({kind:'group',id:'group-middle',side:'before'}));await form.getByRole('button',{name:'Preview move'}).focus();await page.keyboard.press('Enter');await expect(review).toBeVisible();await review.getByRole('button',{name:'Apply change',exact:true}).focus();await page.keyboard.press('Enter');
 expect((await snapshot()).m.groups[0].id).toBe('group-opening');await expect(grip('group','group-opening')).toBeFocused();
 await grip('scene','scene-bridge').focus();await page.keyboard.press('Enter');form=page.getByRole('dialog',{name:'Move Bridge',exact:true});const positions=form.getByRole('combobox',{name:'New position'});for(let i=0;i<8;i++)await positions.press('a');await page.keyboard.press('Tab');await expect(positions).toHaveValue(JSON.stringify({kind:'groupEnd',id:'group-empty'}));await form.getByRole('button',{name:'Preview move'}).focus();await page.keyboard.press('Enter');await review.getByRole('button',{name:'Apply change',exact:true}).focus();await page.keyboard.press('Enter');
 s=await snapshot();expect(s.m.scenes.find((x:any)=>x.id==='scene-bridge').groupId).toBe('group-empty');expect(s.docs).toEqual(initial.docs);await expect(grip('scene','scene-bridge')).toBeFocused();
 const beforeEscape=await snapshot();await page.keyboard.press('Enter');await page.keyboard.press('Escape');expect((await snapshot()).m).toEqual(beforeEscape.m);await expect(grip('scene','scene-bridge')).toBeFocused();
 await capture('04-keyboard-empty-and-cancel.png',pane.locator('[data-group-id="group-empty"]'));
 for(const el of await pane.locator('.manuscript-move-grip').all()){await el.scrollIntoViewIfNeeded();const box=(await el.boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(await el.evaluate(n=>{const b=n.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return hit===n||n.contains(hit);})).toBe(true);}
 expect(await pane.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);expect((await new AxeBuilder({page}).include('.manuscript').analyze()).violations).toEqual([]);expect((await snapshot()).external).toEqual([]);expect(errors).toEqual([]);
});

test('Visible manuscript grips support normal browser mouse moves and cancel',async({page},info)=>{
 await page.setViewportSize({width:1440,height:4000});await page.goto('/tests/browser/projects.html?movement-demo');await expect(page.locator('html')).toHaveAttribute('data-demo-ready','true');
 const pane=page.getByRole('tabpanel',{name:'Binder',exact:true}),review=page.getByRole('dialog',{name:'Review manuscript change'});
 const grip=(kind:string,id:string)=>pane.locator(`[data-move-kind="${kind}"][data-move-id="${id}"]`);
 const state=()=>page.evaluate(()=>{const f=(window as any).projectFixture,s=f.state();return{m:s.manuscripts['local-a'],docs:s.documents['local-a'],external:f.externalCalls,calls:f.draftingCalls};});
 async function mouseDrag(source:Locator,target:Locator){await source.scrollIntoViewIfNeeded();await target.scrollIntoViewIfNeeded();await expect(source).toBeInViewport();await expect(target).toBeInViewport();await source.dragTo(target);}
 const initial=await state();await pane.getByRole('button',{name:'Add chapter',exact:true}).scrollIntoViewIfNeeded();await pane.locator('.drafting-chapters').screenshot({path:info.outputPath('overview-before.png')});
 await mouseDrag(grip('group','group-opening'),pane.locator('.manuscript-boundary-target').first());await expect(review).toBeVisible();expect((await state()).m).toEqual(initial.m);await page.screenshot({path:info.outputPath('overview-chapter-preview.png')});await review.getByRole('button',{name:'Apply change',exact:true}).click();
 expect((await state()).m.scenes.map((s:any)=>s.id)).toEqual(['scene-lead','scene-bridge','scene-finale','scene-tail','scene-arrival','scene-meeting']);await pane.locator('[data-group-id="group-opening"]').scrollIntoViewIfNeeded();await pane.locator('.drafting-chapters').screenshot({path:info.outputPath('overview-chapter-moved.png')});
 await mouseDrag(grip('scene','scene-bridge'),pane.locator('[data-group-id="group-ending"]'));await expect(review).toBeVisible();await review.getByRole('button',{name:'Apply change',exact:true}).click();expect((await state()).m.scenes.find((s:any)=>s.id==='scene-bridge').groupId).toBe('group-ending');await pane.locator('[data-group-id="group-ending"]').scrollIntoViewIfNeeded();await pane.locator('.drafting-chapters').screenshot({path:info.outputPath('overview-scene-moved.png')});
 const before=await state();await mouseDrag(grip('group','group-opening'),pane.locator('[data-group-id="group-middle"]'));await expect(review).toBeVisible();await review.getByRole('button',{name:'Cancel',exact:true}).click();expect((await state()).m).toEqual(before.m);expect((await state()).docs).toEqual(initial.docs);expect((await state()).external).toEqual([]);await pane.locator('[data-group-id="group-ending"]').scrollIntoViewIfNeeded();await pane.locator('.drafting-chapters').screenshot({path:info.outputPath('overview-cancel-unchanged.png')});
});
