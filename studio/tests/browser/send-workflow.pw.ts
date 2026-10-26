import {test,expect,type Locator} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const contrast of [false,true])test(`one confirmed Send keeps autosave separate, cancel and keyboard 200% contrast=${contrast}`,async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 async function activate(target:Locator){await expect(target).toBeVisible();for(let n=0;n<120;n++){if(await target.evaluate(el=>el===document.activeElement)){await page.keyboard.press('Enter');return;}await page.keyboard.press('Tab');}throw Error('Keyboard target unreachable');}
 await page.goto('/tests/browser/github.html?repo-first&writing');await expect(page.locator('.cm-content')).toBeVisible();
 if(contrast){await page.getByRole('button',{name:'Appearance',exact:false}).click();await page.getByRole('button',{name:'High contrast',exact:true}).click();await page.keyboard.press('Escape');}
 for(let n=0;n<8&&await page.locator('html').getAttribute('data-zoom')!=='200';n++)await page.keyboard.press('Control+=');
 await expect(page.locator('html')).toHaveAttribute('data-zoom','200');
 if(await page.getByRole('button',{name:'Navigation',exact:true}).count())await activate(page.getByRole('button',{name:'Navigation',exact:true}));
 await activate(page.getByRole('tab',{name:'Repository',exact:true}));
 await activate(page.locator('.repository-send'));
 const dialog=page.getByRole('dialog',{name:'GitHub projects',exact:true});
 await expect(dialog.getByRole('heading',{name:'Send to GitHub',exact:true})).toBeVisible();
 const checkbox=dialog.getByRole('checkbox',{name:'edit: story.md',exact:true});await checkbox.focus();await page.keyboard.press('Space');
 for(const [label,value] of [['Name recorded with these changes','Synthetic Writer'],['Email recorded with these changes','synthetic@users.noreply.github.com']]){const field=dialog.getByLabel(label,{exact:true});await field.focus();await page.keyboard.insertText(value);}
 await activate(dialog.getByRole('button',{name:'Review what will be sent',exact:true}));
 const preview=dialog.getByRole('region',{name:'GitHub action preview'});await expect(preview).toContainText('earlier-scene.md');await expect(preview).toContainText('Working branch: heinlein/story-synthetic');
 expect(await page.evaluate(()=> (window as any).githubFixture.calls.filter((c:any)=>c.action==='confirm'))).toHaveLength(0);
 await activate(dialog.getByRole('button',{name:'Cancel this preview',exact:true}));await expect(preview).toHaveCount(0);
 await activate(dialog.getByRole('button',{name:'Review what will be sent',exact:true}));
 const send=dialog.getByRole('button',{name:'Send to GitHub…',exact:true});expect((await send.boundingBox())!.height).toBeGreaterThanOrEqual(44);
 expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
 expect((await new AxeBuilder({page}).include('.github-panel').analyze()).violations).toEqual([]);
 await activate(send);await expect(dialog.getByRole('status')).toContainText('upload simulated, not live');
 expect(await page.evaluate(()=> (window as any).githubFixture.calls.filter((c:any)=>c.action==='confirm'))).toHaveLength(1);expect(errors).toEqual([]);
});
