import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('updater keyboard check/schedule/defer keeps running app and credentials separate at 200 percent',async({page})=>{
 await page.goto('/tests/browser/github.html?updates');
 const dialog=page.getByRole('dialog',{name:'Heinlein updates',exact:true});await expect(dialog).toBeVisible();
 for(let i=0;i<5;i++)await page.keyboard.press(process.platform==='darwin'?'Meta+=':'Control+=');
 await expect(page.locator('html')).toHaveAttribute('data-zoom','200');
 const check=dialog.getByRole('button',{name:'Check for updates',exact:true});
 for(let i=0;i<30&&!await check.evaluate(el=>el===document.activeElement);i++)await page.keyboard.press('Tab');
 await expect(check).toBeFocused();await page.keyboard.press('Enter');await expect(dialog).toContainText('newer main-source');
 await page.keyboard.press('Tab');await expect(dialog.getByRole('button',{name:'Update on next launch',exact:true})).toBeFocused();await page.keyboard.press('Enter');
 await expect(dialog).toContainText('running app has not been replaced');await expect(dialog.getByRole('button',{name:'Save and quit when ready',exact:true})).toBeVisible();
 await expect(dialog).toContainText('macOS may ask you to allow access');
 const bounds=await dialog.evaluate(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,width:innerWidth,scroll:el.scrollWidth,client:el.clientWidth}));expect(bounds.left).toBeGreaterThanOrEqual(0);expect(bounds.right).toBeLessThanOrEqual(bounds.width);expect(bounds.scroll).toBeLessThanOrEqual(bounds.client+1);
 expect((await new AxeBuilder({page}).include('.update-panel').analyze()).violations).toEqual([]);
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
 expect(await page.evaluate(()=>((window as any).updateFixture.calls))).toEqual(['status','check','schedule']);
});

test('standalone releases announce updates without focus or manuscript reflow',async({page},testInfo)=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto('/tests/browser/github.html?repo-first&writing&release-updates');
 const editor=page.locator('.cm-content');await expect(editor).toBeVisible();await editor.click();
 const before=await editor.evaluate(el=>({text:el.textContent,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}));
 const notice=page.getByRole('button',{name:'Update available…',exact:true});await expect(notice).toBeVisible({timeout:10000});
 await expect(editor).toBeFocused();expect(await editor.evaluate(el=>({text:el.textContent,width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height}))).toEqual(before);
 expect(await page.getByRole('dialog').count()).toBe(0);
 const bounds=await notice.boundingBox();expect(bounds!.height).toBeGreaterThanOrEqual(48);expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
 expect((await new AxeBuilder({page}).include('.update-notice').analyze()).violations).toEqual([]);
 await page.screenshot({path:testInfo.outputPath('release-update-notice.png')});
 await notice.focus();await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Heinlein updates',exact:true});await expect(dialog).toBeVisible();await expect(dialog).toContainText('Installed 1.7.0');await expect(dialog).toContainText('Latest published 1.8.0');
 await expect(dialog.getByRole('button',{name:'Update on next launch',exact:true})).not.toBeVisible();
 await dialog.getByRole('button',{name:'Open release download page',exact:true}).click();
 expect(await page.evaluate(()=>((window as any).updateFixture.calls))).toContain('openRelease');
 expect((await new AxeBuilder({page}).include('.update-panel').analyze()).violations).toEqual([]);await page.keyboard.press('Escape');await expect(notice).toBeFocused();expect(errors).toEqual([]);
});
