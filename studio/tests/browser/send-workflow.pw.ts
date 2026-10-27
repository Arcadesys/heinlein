import {test,expect,type Locator} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const contrast of [false,true])test(`focused Send: Not now, native cancel, keyboard200 contrast=${contrast}`,async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));

 async function activate(target:Locator){await expect(target).toBeVisible();await expect(target).toBeEnabled();for(let n=0;n<120;n++){if(await target.evaluate(el=>el===document.activeElement)){await expect(target).toBeFocused();await target.press('Enter');return;}await page.keyboard.press('Tab');}throw Error('Keyboard target unreachable');}
 await page.goto('/tests/browser/github.html?repo-first&writing&send-cancel');await expect(page.locator('.cm-content')).toBeVisible();
 if(contrast){await page.getByRole('button',{name:'Appearance',exact:false}).click();await page.getByRole('button',{name:'High contrast',exact:true}).click();await page.keyboard.press('Escape');}
 for(let n=0;n<8&&await page.locator('html').getAttribute('data-zoom')!=='200';n++)await page.keyboard.press('Control+=');
 await expect(page.locator('html')).toHaveAttribute('data-zoom','200');
 if(await page.getByRole('button',{name:'Navigation',exact:true}).count())await activate(page.getByRole('button',{name:'Navigation',exact:true}));
 await activate(page.getByRole('tab',{name:'Repository',exact:true}));await activate(page.locator('.repository-send'));
 const dialog=page.locator('dialog.github-panel:not(.project-library)');await expect(dialog.getByRole('heading',{name:'Send your changes',exact:true})).toBeVisible();await expect(dialog).not.toHaveAttribute('aria-busy','');
 await expect(dialog).not.toContainText('Sign out of GitHub');
 await activate(dialog.getByRole('button',{name:'Not now',exact:true}));await expect(dialog).not.toBeVisible();
 expect(await page.evaluate(()=> (window as any).githubFixture.calls.filter((c:any)=>c.action==='confirm'))).toHaveLength(0);
 await activate(page.locator('.repository-send'));await expect(dialog).not.toHaveAttribute('aria-busy','');
 const checkbox=dialog.getByRole('checkbox',{name:'edit: story.md',exact:true});await checkbox.focus();await page.keyboard.press('Space');
 await activate(dialog.getByText('Name and email included with new changes',{exact:true}));
 for(const [label,value] of [['Name recorded with these changes','Synthetic Writer'],['Email recorded with these changes','synthetic@users.noreply.github.com']]){const f=dialog.getByLabel(label,{exact:true});await f.focus();await page.keyboard.insertText(value);}
 await expect(dialog).toContainText('earlier-scene.md');
 const send=dialog.getByRole('button',{name:'Send to GitHub…',exact:true});expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 await activate(send);await expect(dialog.getByRole('status')).toContainText('Nothing sent');await expect(checkbox).toBeChecked();await expect(send).toBeFocused();
 // Axe closes an auxiliary page: run it after the keyboard journey, not between focus and activation.
 expect((await new AxeBuilder({page}).include('.github-panel').analyze()).violations).toEqual([]);
 expect(await page.evaluate(()=> (window as any).githubFixture.workspace.headOid)).toBe('local');expect(errors).toEqual([]);
});
test('focused definite failure retains local version and explicit retry needs no duplicate version',async({page})=>{
 await page.goto('/tests/browser/github.html?repo-first&writing&send&send-failure=definite');
 const dialog=page.locator('dialog.github-panel:not(.project-library)');
 await dialog.getByRole('checkbox',{name:'edit: story.md',exact:true}).check();await dialog.getByText('Name and email included with new changes',{exact:true}).click();
 await dialog.getByLabel('Name recorded with these changes',{exact:true}).fill('Synthetic Writer');await dialog.getByLabel('Email recorded with these changes',{exact:true}).fill('synthetic@users.noreply.github.com');
 await dialog.getByRole('button',{name:'Send to GitHub…',exact:true}).click();
 await expect(dialog.getByRole('status')).toContainText('Saved on this Mac. Not sent.');await expect(dialog).not.toContainText('Sign out of GitHub');
 const saved=await page.evaluate(()=>({...((window as any).githubFixture.workspace)}));expect(saved.headOid).toBe('local-version');expect(saved.remoteOid).toBeNull();
 await dialog.getByRole('button',{name:'Try sending again…',exact:true}).click();await expect(dialog.getByRole('checkbox')).toHaveCount(0);await expect(dialog).toContainText('No new local version is needed');await expect(dialog.locator('.send-earlier')).toContainText('story.md');
 await dialog.getByRole('button',{name:'Send to GitHub…',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('Not sent.');
 expect(await page.evaluate(()=> (window as any).githubFixture.workspace.headOid)).toBe(saved.headOid);expect(await page.evaluate(()=> (window as any).githubFixture.workspace.remoteOid)).toBeNull();
});
