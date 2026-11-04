import {openHeinleinReview} from './heinlein';
import {test,expect,type Page} from '@playwright/test'; import AxeBuilder from '@axe-core/playwright';
async function openDrawer(page:Page){const toggle=page.getByRole('button',{name:'Navigation',exact:true}); if(await toggle.isVisible()) await toggle.click(); await expect(page.locator('.tree-project')).toBeVisible(); await expect(page.locator('#navigation-drawer')).toHaveAttribute('aria-hidden','false');}
async function projectAction(page:Page,name:string){await page.locator('summary[aria-label="Project actions"]').click(); await page.getByRole('group',{name:'Project actions'}).getByRole('button',{name,exact:true}).click();}
test('project tree and writing area stay within their workspace at enlarged text sizes',async({page},info)=>{
 test.skip(info.project.name==='narrow');
 await page.goto('/tests/browser/library-app.html');
 await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
 await openDrawer(page);
 await page.getByRole('button',{name:'First sheet',exact:true}).click();
 const geometry=await page.evaluate(()=>{
  const rect=(selector:string)=>document.querySelector(selector)!.getBoundingClientRect();
  const workspace=rect('.workspace'),nav=rect('.navigator'),preview=rect('.preview'),tree=rect('.library-tree');
  return {workspace:workspace.toJSON(),nav:nav.toJSON(),preview:preview.toJSON(),tree:tree.toJSON()};
 });
 expect(geometry.nav.right).toBeLessThanOrEqual(geometry.preview.left+1);
 expect(geometry.preview.right).toBeLessThanOrEqual(geometry.workspace.right+1);
 expect(geometry.preview.width).toBeGreaterThan(geometry.workspace.width/2);
 expect(geometry.tree.right).toBeLessThanOrEqual(geometry.nav.right+1);
 await page.screenshot({path:info.outputPath('library-workspace-200.png')});
});
test('full app navigates the project tree and editor',{tag:'@smoke'},async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 await openDrawer(page);
 await expect(page.locator('.navigator [role="tab"]')).toHaveCount(0);
 await expect(page.locator('.tree-project h2')).toHaveText('Synthetic book');
 await page.getByRole('button',{name:'First sheet',exact:true}).click();
 await expect(page.getByRole('textbox',{name:'Markdown editor'})).toBeVisible();
 await expect(page.locator('.preview .path')).toBeHidden();
 if((await page.viewportSize())!.width<=1000){await page.getByRole('button',{name:'Back to sheets'}).click(); await expect(page.getByRole('button',{name:'First sheet',exact:true})).toBeVisible();}
 await expect(page.getByRole('button',{name:'First sheet',exact:true})).toHaveAttribute('aria-current','true');
 expect((await new AxeBuilder({page}).include('.workspace').analyze()).violations).toEqual([]);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
for(const zoom of [75,100,200])test(`row menus have names, generous targets and keyboard focus at ${zoom}%`,async({page},info)=>{
 await page.goto('/tests/browser/library-app.html');
 await page.evaluate(async zoom=>{document.documentElement.dataset.zoom=String(zoom);await document.fonts.ready;},zoom);
 await openDrawer(page);
 const more=page.locator('summary[aria-label="Actions for First sheet"]');
 await more.focus(); await expect(more).toBeFocused(); await expect(more).toHaveAttribute('title','Actions for First sheet');
 const samples=[];
 // CDP quads use fractional coordinates. Retain the actual accessibility
 // minimum under fractional translations rather than relaxing the assertion.
 for(const offset of [0,.125,.333,.625,.875]){
  await more.evaluate((node,offset)=>{(node as HTMLElement).style.transform=`translateX(${offset}px)`;},offset);
  const box=(await more.boundingBox())!;
  const dom=await more.evaluate(node=>{const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {x:r.x,y:r.y,width:r.width,height:r.height,minWidth:style.minWidth,minHeight:style.minHeight,transform:style.transform,parentTransform:getComputedStyle(node.closest('.navigation-drawer')!).transform,devicePixelRatio};});
  samples.push({offset,box,dom});
 }
 await info.attach('row-menu-geometry',{body:JSON.stringify(samples,null,2),contentType:'application/json'});
 for(const sample of samples){expect(sample.box.width,JSON.stringify(sample)).toBeGreaterThanOrEqual(44);expect(sample.box.height,JSON.stringify(sample)).toBeGreaterThanOrEqual(44);}
 await more.evaluate(node=>{(node as HTMLElement).style.transform='';});
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
 await openDrawer(page);
 await page.getByRole('button',{name:'First sheet',exact:true}).click();
 await openHeinleinReview(page);await page.getByRole('region',{name:'Heinlein Review'}).getByRole('button',{name:/^Several sheets…/}).click();
 const dialog=page.getByRole('dialog',{name:'Choose revision context and targets'});
 await dialog.getByRole('group',{name:'Additional context sheets'}).getByRole('checkbox',{name:'Second sheet'}).check();
 expect((await new AxeBuilder({page}).include('dialog[aria-label="Choose revision context and targets"]').analyze()).violations).toEqual([]);
 await dialog.getByRole('button',{name:'Prepare review'}).click();
 const review=page.getByRole('region',{name:'Heinlein Review'}); await expect(review).toBeVisible();
 await expect(review.locator('.review-send-summary')).toHaveText(/^Sends 1 sheet \+ 1 context · /);
 await expect(review.getByRole('checkbox',{name:/Suggest edits in ms\/first.md/})).toBeChecked();
 await expect(review.getByRole('checkbox',{name:/Suggest edits in ms\/second.md/})).not.toBeChecked();
 expect((await new AxeBuilder({page}).include('.heinlein-review-panel').analyze()).violations).toEqual([]);
});
test('library reflows with enlarged text and retains a visible focus indicator',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 await page.getByRole('button',{name:'More actions'}).click(); await page.getByRole('button',{name:/^Appearance/}).click(); await page.getByRole('button',{name:'High contrast',exact:true}).click(); await page.keyboard.press('Escape');
 await expect(page.locator('html')).toHaveAttribute('data-theme','contrast'); await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
 await openDrawer(page);
 const group=page.getByRole('button',{name:'Group',exact:true}); await group.focus();
 await expect(group).toBeFocused(); const focus=await group.evaluate(node=>{const style=getComputedStyle(node);return {outline:style.outlineStyle,shadow:style.boxShadow};});
 expect(focus.outline!=='none'||focus.shadow!=='none').toBe(true);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
});
test('groups collapse and expand in place and keep focus',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 await openDrawer(page);
 const group=page.locator('[data-expand-group="g"]'); await expect(group).toHaveAttribute('aria-expanded','true');
 await group.click(); await expect(group).toHaveAttribute('aria-expanded','false'); await expect(group).toBeFocused();
 await expect(page.getByRole('button',{name:'First sheet',exact:true})).toHaveCount(0);
 await page.keyboard.press('Enter'); await expect(group).toHaveAttribute('aria-expanded','true');
 await expect(page.getByRole('button',{name:'First sheet',exact:true})).toBeVisible();
});
test('source files open from the project menu and hide support, generated output and empty folders',async({page})=>{
 await page.goto('/tests/browser/library-app.html');
 await openDrawer(page);
 await projectAction(page,'Source files');
 await expect(page.getByRole('button',{name:'← Project'})).toBeFocused();
 await expect(page.getByRole('button',{name:'Open folder writing'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Open folder empty'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Open file README.md'})).toHaveCount(0);
 await expect(page.getByRole('button',{name:'Open file output'})).toHaveCount(0);
 await page.getByLabel('Show support files and paths').check();
 await expect(page.getByRole('button',{name:'Open file README.md'})).toBeVisible();
 await page.getByRole('button',{name:'← Project'}).click();
 await expect(page.getByRole('button',{name:'Group',exact:true})).toBeVisible();
});
