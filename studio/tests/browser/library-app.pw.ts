import {test,expect} from '@playwright/test'; import AxeBuilder from '@axe-core/playwright';
test('full app navigates the project tree and editor',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await expect(page.getByRole('tab')).toHaveCount(0);
 await expect(page.locator('.tree-project h2')).toHaveText('Synthetic book');
 await page.getByRole('button',{name:'First sheet',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Markdown editor'})).toBeVisible();
 await expect(page.locator('.preview .path')).toBeHidden();
 if((await page.viewportSize())!.width<=1000){await page.getByRole('button',{name:'Back to sheets'}).click(); await expect(page.getByRole('button',{name:'First sheet',exact:true})).toBeVisible();}
 await expect(page.getByRole('button',{name:'First sheet',exact:true})).toHaveAttribute('aria-current','page');
 expect((await new AxeBuilder({page}).include('.workspace').analyze()).violations).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('row menus have names, generous targets and keyboard focus',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 const more=page.locator('summary[aria-label="Actions for First sheet"]');
 await more.focus(); await expect(more).toBeFocused(); await expect(more).toHaveAttribute('title','Actions for First sheet');
 const box=await more.boundingBox(); expect(box!.width).toBeGreaterThanOrEqual(44); expect(box!.height).toBeGreaterThanOrEqual(44);
 const focus=await more.evaluate(node=>{const style=getComputedStyle(node);return {outline:style.outlineStyle,shadow:style.boxShadow,opacity:style.opacity};});
 expect(focus.outline!=='none'||focus.shadow!=='none').toBe(true); expect(focus.opacity).toBe('1');
 await page.keyboard.press('Enter');
 const menu=page.getByRole('group',{name:'Actions for First sheet'}); await expect(menu).toBeVisible();
 await expect(menu.getByRole('button',{name:'Rename…'})).toBeFocused();
 expect((await new AxeBuilder({page}).include('.row-menu-items').analyze()).violations).toEqual([]);
 await page.keyboard.press('Escape'); await expect(menu).toBeHidden(); await expect(more).toBeFocused();
 await page.keyboard.press('Enter'); await expect(menu.getByRole('button',{name:'Rename…'})).toBeFocused();
 await page.keyboard.press('Enter'); await expect(page.getByRole('dialog',{name:'Rename scene'})).toBeVisible();
});
test('library review picker separates context and target without sending',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await page.getByRole('button',{name:'First sheet',exact:true}).click();
 await page.getByRole('button',{name:'Heinlein',exact:true}).click();
 await page.getByRole('button',{name:'Whole scene',exact:true}).click();
 await page.getByRole('button',{name:'Review library sheets…'}).click();
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
 await page.getByRole('button',{name:/^Appearance/}).click(); await page.getByRole('button',{name:'High contrast',exact:true}).click(); await page.keyboard.press('Escape');
 await expect(page.locator('html')).toHaveAttribute('data-theme','contrast'); await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 const group=page.getByRole('button',{name:'Group',exact:true}); await group.focus();
 await expect(group).toBeFocused(); const focus=await group.evaluate(node=>{const style=getComputedStyle(node);return {outline:style.outlineStyle,shadow:style.boxShadow};});
 expect(focus.outline!=='none'||focus.shadow!=='none').toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('groups collapse and expand in place and keep focus',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 const group=page.getByRole('button',{name:'Group',exact:true}); await expect(group).toHaveAttribute('aria-expanded','true');
 await group.click(); await expect(group).toHaveAttribute('aria-expanded','false'); await expect(group).toBeFocused();
 await expect(page.getByRole('button',{name:'First sheet',exact:true})).toHaveCount(0);
 await page.keyboard.press('Enter'); await expect(group).toHaveAttribute('aria-expanded','true');
 await expect(page.getByRole('button',{name:'First sheet',exact:true})).toBeVisible();
});
test('repository files are browsed from the project menu and palette, not the drawer',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click();
 await expect(page.locator('.file-entry')).toHaveCount(0);
 await page.locator('summary[aria-label="Project actions"]').click();
 await page.getByRole('group',{name:'Project actions'}).getByRole('button',{name:'Browse files'}).click();
 const results=page.getByRole('listbox',{name:'Results'});
 await expect(results.getByRole('option',{name:/README\.md/})).toBeVisible();
 await expect(results.getByRole('option',{name:/writing\//})).toBeVisible();
});
