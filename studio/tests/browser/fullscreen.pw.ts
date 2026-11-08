import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function hideControls(page:Page){const hide=page.getByRole('button',{name:'Hide controls',exact:true});if(!await hide.isVisible())await page.getByRole('button',{name:'More actions'}).click();await hide.click();}

test('full screen focus is a direct keyboard action with a clear exit and stable manuscript layout',async({page},info)=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/tests/browser/projects.html?library');
 await page.getByRole('button',{name:'Open Novel A',exact:true}).click();await page.getByRole('button',{name:'Open file scene.md',exact:true}).click();
 const editor=page.locator('.cm-content'),toggle=page.locator('.status-pill > .fullscreen-toggle');
 await expect(editor).toBeVisible();await expect(toggle).toHaveAttribute('aria-label',/^Full screen(?: focus)?$/);
 if(page.viewportSize()!.width===320){for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');}
 const text=await editor.innerText(),width=(await editor.boundingBox())!.width;
 const before=await page.evaluate(()=>JSON.stringify((window as any).projectFixture.documents));
 const navigationOpen=await page.locator('.navigation-toggle').getAttribute('aria-expanded');
 await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-label',/^Exit full screen(?: focus)?$/);await expect(toggle).toHaveAttribute('aria-pressed','true');await expect(editor).toBeFocused();
 expect(await page.evaluate(()=>(window as any).projectFixture.core.fullscreen.isFullscreen())).toBe(true);
 await expect(page.locator('.conversation-rail-root')).toBeHidden();await expect(page.locator('.navigation-toggle')).toBeHidden();
 expect((await editor.boundingBox())!.width).toBeCloseTo(width,0);expect(await editor.innerText()).toBe(text);
 await expect(page.locator('.status-pill')).toBeHidden();await expect(page.locator('.document-tabs')).toBeHidden();await expect(page.locator('.document-command-bar')).toBeHidden();await expect(page.locator('.notice-slot')).toBeHidden();await expect(page.locator('.focus-word-goal')).toBeHidden();
 expect((await new AxeBuilder({page}).include('.studio').analyze()).violations).toEqual([]);
 await page.screenshot({path:info.outputPath('full-screen-focus-control.png'),fullPage:true});await page.locator('html').evaluate(el=>el.setAttribute('data-theme','contrast'));expect((await new AxeBuilder({page}).include('.studio').analyze()).violations).toEqual([]);
 await page.keyboard.press('ControlOrMeta+Shift+h');await expect(page.locator('.status-pill')).toBeVisible();await toggle.focus();await page.keyboard.press('Enter');await expect(toggle).toHaveAttribute('aria-label',/^Full screen(?: focus)?$/);await expect(page.locator('.navigation-toggle')).toHaveAttribute('aria-expanded',navigationOpen!);
 expect(await page.evaluate(()=>JSON.stringify((window as any).projectFixture.documents))).toBe(before);
 await page.keyboard.press('F11');await expect(toggle).toHaveAttribute('aria-label',/^Exit full screen(?: focus)?$/);await page.keyboard.press('Escape');await expect(toggle).toHaveAttribute('aria-label',/^Full screen(?: focus)?$/);await page.keyboard.press('F11');await expect(toggle).toHaveAttribute('aria-label',/^Exit full screen(?: focus)?$/);await page.evaluate(()=>(window as any).projectFixture.core.fullscreen.setFullscreen(false));await expect(toggle).toHaveAttribute('aria-label',/^Full screen(?: focus)?$/);expect(errors).toEqual([]);
});

test('controls can slide away without full screen and the word goal preference survives reload',async({page})=>{
 await page.goto('/tests/browser/projects.html');const editor=page.locator('.cm-content');await expect(editor).toBeVisible();const text=await editor.innerText(),width=(await editor.boundingBox())!.width;
 await hideControls(page);await expect(page.locator('.status-pill')).toBeHidden();await expect(page.locator('.standalone-toolbar')).toBeHidden();await expect(editor).toBeFocused();expect((await editor.boundingBox())!.width).toBeCloseTo(width,0);expect(await editor.innerText()).toBe(text);
 await page.keyboard.press('Tab');const show=page.getByRole('button',{name:'Show controls',exact:true});await expect(show).toBeFocused();await expect(show).toBeInViewport();await page.keyboard.press('Enter');await expect(await page.getByRole('button',{name:'Hide controls',exact:true}).isVisible()?page.getByRole('button',{name:'Hide controls',exact:true}):page.getByRole('button',{name:'More actions'})).toBeFocused();
 const appearance=async()=>{await page.getByRole('button',{name:'More actions'}).click();await page.getByRole('button',{name:'Appearance',exact:false}).click();await page.getByRole('button',{name:'Editor',exact:true}).click();};
 await appearance();const goal=page.getByRole('switch',{name:'Show word goal while controls are hidden',exact:true});await expect(goal).toHaveAttribute('aria-checked','false');await goal.click();await page.keyboard.press('Escape');await hideControls(page);await expect(page.locator('.focus-word-goal')).toBeVisible();await expect(page.locator('.focus-word-goal')).toContainText('words');
 await page.keyboard.press('ControlOrMeta+,');await expect(page.getByRole('dialog',{name:'Appearance'})).toBeVisible();await expect(page.locator('.status-pill')).toBeVisible();await page.keyboard.press('Escape');await page.reload();await appearance();await expect(goal).toHaveAttribute('aria-checked','true');
});

test('a failed save reveals controls and keeps the unsaved source while writing without chrome',async({page})=>{
 await page.goto('/tests/browser/projects.html?library');await page.getByRole('button',{name:'Open Novel A',exact:true}).click();await page.getByRole('button',{name:'Open file scene.md',exact:true}).click();
 const before=await page.evaluate(()=>(window as any).projectFixture.documents['local-a']['scene.md']);await hideControls(page);await expect(page.locator('.status-pill')).toBeHidden();await page.evaluate(()=>(window as any).projectFixture.setFailSave(true));await page.locator('.cm-content').focus();await page.keyboard.insertText('Unsaved — ');await page.keyboard.press('ControlOrMeta+s');await expect(page.locator('.status-pill')).toBeVisible();await expect(page.locator('.cm-content')).toContainText('Unsaved — ');expect(await page.evaluate(()=>(window as any).projectFixture.documents['local-a']['scene.md'])).toBe(before);
});
