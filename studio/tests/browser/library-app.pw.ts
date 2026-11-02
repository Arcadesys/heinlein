import {test,expect} from '@playwright/test'; import AxeBuilder from '@axe-core/playwright';
test('full app navigates library, sheets and editor',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await page.getByRole('tab',{name:'Library'}).click();
 await page.getByRole('button',{name:'Group',exact:true}).click();
 await expect(page.getByRole('button',{name:'1. First sheet'})).toBeVisible();
 await page.getByRole('button',{name:'1. First sheet'}).click();
 await expect(page.getByRole('textbox',{name:'Markdown editor'})).toBeVisible();
 await expect(page.locator('.preview .path')).toBeHidden();
 if((await page.viewportSize())!.width<=1000){await page.getByRole('button',{name:'Back to sheets'}).click(); await expect(page.getByRole('button',{name:'1. First sheet'})).toBeVisible(); await page.getByRole('button',{name:'Back to library'}).click(); await expect(page.getByRole('button',{name:'Group',exact:true})).toBeVisible();}
 expect((await new AxeBuilder({page}).include('.workspace').analyze()).violations).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('compact sheet controls have names, tooltips, generous targets and keyboard focus',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await page.getByRole('tab',{name:'Library'}).click(); await page.getByRole('button',{name:'Group',exact:true}).click();
 const card=page.locator('.drafting-scene').first();
 for(const name of ['Move First sheet earlier','Move First sheet later','Rename sheet']) {
  const control=card.getByRole('button',{name,exact:true}); await expect(control).toHaveAttribute('title',name);
  const box=await control.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
 }
 const rename=card.getByRole('button',{name:'Rename sheet'}); await rename.focus(); await expect(rename).toBeFocused();
 const focus=await rename.evaluate(node=>{const style=getComputedStyle(node);return {outline:style.outlineStyle,shadow:style.boxShadow};});
 expect(focus.outline!=='none'||focus.shadow!=='none').toBe(true);
 await page.keyboard.press('Enter'); await expect(page.getByRole('dialog',{name:'Rename sheet'})).toBeVisible();
});
test('library review picker separates context and target without sending',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await page.getByRole('tab',{name:'Library'}).click(); await page.getByRole('button',{name:'Group',exact:true}).click();
 await page.getByRole('button',{name:'1. First sheet'}).click();
 await page.getByRole('button',{name:'Editing actions'}).click(); await page.getByRole('button',{name:'Review library sheets…'}).click();
 const dialog=page.getByRole('dialog',{name:'Choose revision context and targets'});
 await dialog.getByRole('group',{name:'Additional context sheets'}).getByRole('checkbox',{name:'Second sheet'}).check();
 expect((await new AxeBuilder({page}).include('dialog[aria-label="Choose revision context and targets"]').analyze()).violations).toEqual([]);
 await dialog.getByRole('button',{name:'Prepare review'}).click();
 const review=page.getByRole('region',{name:'Heinlein Review'}); await expect(review).toBeVisible();
 await expect(review.getByText(/2 source snapshot/)).toBeVisible();
 await expect(review.getByRole('checkbox',{name:/Allow prepared edits in ms\/first.md/})).toBeChecked();
 await expect(review.getByRole('checkbox',{name:/Allow prepared edits in ms\/second.md/})).not.toBeChecked();
 expect((await new AxeBuilder({page}).include('.heinlein-review-panel').analyze()).violations).toEqual([]);
});
test('library reflows with enlarged text and retains a visible focus indicator',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const closeNavigation=page.getByRole('button',{name:'Return to writing',exact:true}); if(await closeNavigation.isVisible()) await closeNavigation.click();
 await page.getByRole('button',{name:'More actions'}).click(); await page.getByRole('button',{name:/^Appearance/}).click(); await page.getByRole('button',{name:'High contrast',exact:true}).click(); await page.keyboard.press('Escape');
 await expect(page.locator('html')).toHaveAttribute('data-theme','contrast'); await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await page.getByRole('tab',{name:'Library'}).click(); const group=page.getByRole('button',{name:'Group',exact:true}); await group.focus();
 await expect(group).toBeFocused(); const focus=await group.evaluate(node=>{const style=getComputedStyle(node);return {outline:style.outlineStyle,shadow:style.boxShadow};});
 expect(focus.outline!=='none'||focus.shadow!=='none').toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('wide library panes collapse independently and keep the selected group',async({page},testInfo)=>{
 test.skip(testInfo.project.name==='narrow');
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await page.getByRole('tab',{name:'Library'}).click(); await page.getByRole('button',{name:'Group',exact:true}).click();
 await page.getByRole('button',{name:'Collapse library'}).click(); await expect(page.getByRole('button',{name:'Show library'})).toBeFocused();
 await expect(page.getByRole('button',{name:'1. First sheet'})).toBeVisible();
 await page.getByRole('button',{name:'Show library'}).click(); await expect(page.getByRole('button',{name:'Group',exact:true})).toHaveAttribute('aria-pressed','true');
 await page.getByRole('button',{name:'Collapse sheets'}).click(); await expect(page.getByRole('button',{name:'Show sheets'})).toBeFocused();
 await page.getByRole('button',{name:'Show sheets'}).click(); await expect(page.getByRole('button',{name:'1. First sheet'})).toBeVisible();
});
test('repository writing view hides support, generated output and empty folders',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await page.getByRole('tab',{name:'Source files'}).click();
 await expect(page.getByRole('button',{name:'Open folder writing'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Open folder empty'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Open file README.md'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Open file output'})).toHaveCount(0);
 await page.getByLabel('Show support files and paths').check();
 await expect(page.getByRole('button',{name:'Open file README.md'})).toBeVisible();
});
