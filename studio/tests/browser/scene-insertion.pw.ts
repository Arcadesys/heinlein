import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function showTree(page:Page){
 const toggle=page.locator('.navigation-toggle');if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
 const back=page.locator('.files.nav-view:not([hidden]) .nav-back');if(await back.isVisible())await back.click();
 await expect(page.locator('.library-tree')).toBeVisible();
}
async function openAction(page:Page,label:string){
 await showTree(page);const summary=page.locator('summary[aria-label="Actions for Arrival"]');await summary.focus();await page.keyboard.press('Enter');
 const action=page.getByRole('group',{name:'Actions for Arrival',exact:true}).getByRole('button',{name:label,exact:true});await expect(action).toBeVisible();
 for(let i=0;i<12&&!await action.evaluate(el=>el===document.activeElement);i++)await page.keyboard.press('ArrowDown');
 await expect(action).toBeFocused();await page.keyboard.press('Enter');
 const dialog=page.getByRole('dialog',{name:'New scene',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByRole('textbox',{name:'Scene title'})).toBeFocused();return dialog;
}
for(const enlarged of [false,true])test(`scene menu inserts above/below and cancels with exact source retained, enlarged=${enlarged}`,async({page},info)=>{
 await page.goto('/tests/browser/projects.html?movement-demo');await expect(page.locator('html')).toHaveAttribute('data-demo-ready','true');
 if(enlarged){for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');await expect(page.locator('html')).toHaveAttribute('data-zoom','200');}
 const original=await page.evaluate(()=>structuredClone((window as any).projectFixture.documents['local-a']));
 let dialog=await openAction(page,'Add scene above');await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
 await expect(page.locator('[data-scene-id="scene-arrival"] .scene-open')).toBeFocused();
 expect(await page.evaluate(()=>(window as any).projectFixture.draftingCalls)).toEqual([]);
 for(const [label,title,after] of [['Add scene above','Before arrival',false],['Add scene below','After arrival',true]] as const){
  dialog=await openAction(page,label);await dialog.getByRole('textbox',{name:'Scene title'}).fill(title);
  expect((await new AxeBuilder({page}).include('dialog[aria-label="New scene"]').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:info.outputPath(`scene-title-${after?'below':'above'}.png`)});
  await dialog.getByRole('button',{name:'Create scene',exact:true}).focus();await page.keyboard.press('Enter');await expect(dialog).not.toBeVisible();
  await expect.poll(()=>page.evaluate(title=>(window as any).projectFixture.manuscripts['local-a'].scenes.some((s:any)=>s.title===title),title)).toBe(true);
  await showTree(page);const titles=await page.locator('.scene-open').allTextContents();expect(titles.indexOf(title)).toBe(titles.indexOf('Arrival')+(after?1:-1));
 }
 expect(await page.evaluate(original=>Object.fromEntries(Object.keys(original).map(path=>[path,(window as any).projectFixture.documents['local-a'][path]])),original)).toEqual(original);
 expect(await page.evaluate(()=>(window as any).projectFixture.externalCalls)).toEqual([]);
});
