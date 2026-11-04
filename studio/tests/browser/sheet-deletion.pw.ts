import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function navigation(page:Page){const toggle=page.getByRole('button',{name:'Navigation',exact:true});if(await toggle.isVisible())await toggle.click();}
async function remove(page:Page,title:string){await navigation(page);await page.locator(`summary[aria-label="Actions for ${title}"]`).click();await page.locator(`.row-menu-items[aria-label="Actions for ${title}"]`).getByRole('button',{name:'Delete sheet…',exact:true}).click();}
test('sheet deletion confirms, cancels safely, preserves another editor and supports Undo',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto('/tests/browser/sheet-deletion.html');await expect(page).toHaveTitle('Sheet deletion — synthetic fixture');await expect(page).toHaveURL(/sheet-deletion\.html$/);await page.waitForFunction(()=>document.documentElement.dataset.sheetDeletionReady==='true');
 await remove(page,'Second sheet');const dialog=page.getByRole('dialog',{name:'Delete sheet?',exact:true});
 await expect(dialog).toBeVisible();await expect(dialog).toContainText('Second sheet');await expect(dialog).toContainText('ms/second.md');await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
 await page.keyboard.press('Escape');await expect(dialog).toHaveCount(0);expect(await page.evaluate(()=>(window as any).sheetDeletionFixture.calls.apply)).toBe(0);
 await expect(page.getByRole('button',{name:'Second sheet',exact:true})).toBeFocused();
 await remove(page,'Second sheet');
 await page.evaluate(()=>{(window as any).sheetDeletionFixture.theme();if(innerWidth===320)document.documentElement.style.fontSize='200%';});
 for(const label of ['Cancel','Delete sheet']){const target=dialog.getByRole('button',{name:label,exact:true});await target.focus();await target.scrollIntoViewIfNeeded();const proof=await target.evaluate(node=>{const rect=node.getBoundingClientRect();const text=node.firstChild!;const wordRects=[...(node.textContent??'').matchAll(/\S+/g)].map(word=>{const range=document.createRange();range.setStart(text,word.index!);range.setEnd(text,word.index!+word[0].length);return range.getClientRects().length;});return {left:rect.left,right:rect.right,viewport:innerWidth,wordRects,height:rect.height,width:rect.width,outline:getComputedStyle(node).outlineStyle,hit:node.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))};});expect(proof.left).toBeGreaterThanOrEqual(0);expect(proof.right).toBeLessThanOrEqual(proof.viewport);expect(proof.wordRects.every(count=>count===1)).toBe(true);expect(proof.height).toBeGreaterThanOrEqual(48);expect(proof.width).toBeGreaterThanOrEqual(44);expect(proof.outline).not.toBe('none');expect(proof.hit).toBe(true);}
 const axe=await new AxeBuilder({page}).include('dialog').analyze();expect(axe.violations.filter(v=>['serious','critical'].includes(v.impact??''))).toEqual([]);
 await page.screenshot({path:info.outputPath('delete-sheet-confirmation.png'),fullPage:true});
 const content=page.locator('.cm-content');const before=await content.evaluate(node=>({text:node.textContent,width:node.getBoundingClientRect().width,font:getComputedStyle(node).fontSize}));
 await dialog.getByRole('button',{name:'Delete sheet',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(page.getByRole('button',{name:'Second sheet',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'First sheet',exact:true})).toBeFocused();
 expect(await content.evaluate(node=>({text:node.textContent,width:node.getBoundingClientRect().width,font:getComputedStyle(node).fontSize}))).toEqual(before);
 expect(await page.evaluate(()=>(window as any).sheetDeletionFixture.files.has('ms/second.md'))).toBe(false);
 await page.locator('details.project-menu summary').click();await page.locator('.row-menu-items[aria-label="Project actions"]').getByRole('button',{name:'Undo last change',exact:true}).click();
 const undo=page.getByRole('dialog',{name:'Review manuscript change',exact:true});await expect(undo).toBeVisible();await undo.getByRole('button',{name:'Apply change',exact:true}).click();
 await expect.poll(()=>page.evaluate(()=>(window as any).sheetDeletionFixture.calls.undo)).toBe(1);await navigation(page);
 await expect(page.getByRole('button',{name:'Second sheet',exact:true})).toBeVisible();expect(await page.evaluate(()=>(window as any).sheetDeletionFixture.files.get('ms/second.md'))).toBe('Second sheet—keep exact.');expect(errors).toEqual([]);
});
