import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for(const high of [false,true])test(`simple document toolbar preserves wraps and keyboard actions (${high?'high contrast 200%':'default'})`,async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/tests/browser/document-tabs.html?titled');await page.waitForFunction(()=>document.documentElement.dataset.tabsReady==='true');
 await page.evaluate(async high=>{document.documentElement.dataset.zoom=high?'200':'100';(window as any).documentFixture.theme(high);await document.fonts.ready;},high);
 const tabs=page.locator('.document-tabs'),bar=page.locator('.document-command-bar');
 await expect(tabs.getByRole('button',{name:'Document actions',exact:true})).toBeVisible();
 await expect(tabs.getByRole('button',{name:'Document details',exact:true})).toBeHidden();await expect(tabs.getByRole('button',{name:/^Close current document/})).toHaveCount(0);
 await expect(bar.getByRole('button')).toHaveText(['Source','Reading','Heinlein']);
 await expect(page.getByRole('button',{name:'Close sheet Harvest Moon',exact:true})).toHaveText('Close');
 const signature=()=>page.locator('.active-document-pane .cm-content').evaluate(el=>({width:el.getBoundingClientRect().width,lines:[...el.querySelectorAll('.cm-line')].map(line=>{const range=document.createRange();range.selectNodeContents(line);const top=line.getBoundingClientRect().top;return[...range.getClientRects()].map(r=>[Math.round(r.width*100)/100,Math.round((r.top-top)*100)/100]);})}));
 const after=await signature();
 await page.evaluate(()=>{const style=[...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].find(el=>el.dataset.viteDevId?.endsWith('/src/style.css'))!;(window as any).toolbarStyle=style.textContent;style.textContent=style.textContent!.split('/* Document chrome: quiet defaults')[0];});
 await page.evaluate(()=>new Promise(requestAnimationFrame));const before=await signature();expect(after).toEqual(before);
 await page.evaluate(()=>{const style=[...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].find(el=>el.dataset.viteDevId?.endsWith('/src/style.css'))!;style.textContent=(window as any).toolbarStyle;});await page.evaluate(()=>new Promise(requestAnimationFrame));
 const menu=tabs.getByRole('button',{name:'Document actions',exact:true});await menu.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');await expect(menu).toBeFocused();expect(await menu.evaluate(el=>{const s=getComputedStyle(el);return s.outlineStyle!=='none'&&parseFloat(s.outlineWidth)>=3;})).toBe(true);
 await page.keyboard.press('Enter');const dialog=page.getByRole('dialog',{name:'Document actions',exact:true});await expect(dialog).toBeVisible();await expect(dialog.getByRole('button',{name:'Document details',exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'Read beside…',exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'Editing actions',exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'Return to writing',exact:true}).click();await expect(menu).toBeFocused();
 for(const target of await page.locator('.document-tabs button:visible,.document-command-bar button:visible').all()){expect((await target.boundingBox())!.height).toBeGreaterThanOrEqual(48);expect(await target.evaluate(el=>parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(high?32:16);}
 expect((await new AxeBuilder({page}).include('.document-workspace').analyze()).violations).toEqual([]);
 await page.screenshot({path:info.outputPath(`document-toolbar-${high?'contrast-200':'default'}.png`),fullPage:true});expect(errors).toEqual([]);
});
