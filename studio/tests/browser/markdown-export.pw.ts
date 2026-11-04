import {test, expect, type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function drawer(page:Page) {
  const toggle=page.getByRole('button',{name:'Navigation',exact:true});
  if(await toggle.isVisible()) await toggle.click();
  await expect(page.locator('#navigation-drawer')).toHaveAttribute('aria-hidden','false');
  await expect(page.locator('#navigation-drawer')).toBeVisible();
}
async function groupExport(page:Page) {
  const menu=page.locator('summary[aria-label="Actions for Group"]');
  await menu.focus(); await expect(menu).toBeFocused(); await page.keyboard.press('Enter');
  const action=page.getByRole('group',{name:'Actions for Group'}).getByRole('button',{name:'Export as Markdown…',exact:true});
  await action.focus(); await page.keyboard.press('Enter');
  return page.getByRole('dialog',{name:'Export as Markdown',exact:true});
}
test('group export is keyboard accessible, preserves editor geometry, and sends a single Markdown snapshot to native save',async({page},info)=>{
  const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message)); page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
  await page.goto('/tests/browser/library-app.html?export');
  await expect(page).toHaveTitle('Library application fixture');
  await drawer(page); await page.getByRole('button',{name:'First sheet',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Markdown editor',exact:true}); await expect(editor).toBeVisible();
  await editor.fill('Current author text — 🐺.\n\nPunch.');
  if(info.project.name==='narrow') await drawer(page);
  const geometry=()=>page.locator('.active-document-pane .cm-content').evaluate(node=>({width:node.getBoundingClientRect().width,text:node.textContent,lines:[...node.querySelectorAll('.cm-line')].map(line=>({height:line.getBoundingClientRect().height,width:line.getBoundingClientRect().width}))}));
  const before=await geometry();
  const dialog=await groupExport(page);
  await expect(dialog.getByRole('status')).toContainText('2 sheets ready');
  await expect(dialog.getByRole('button',{name:'Cancel',exact:true})).toBeFocused();
  expect((await new AxeBuilder({page}).include('dialog[aria-label="Export as Markdown"]').analyze()).violations).toEqual([]);
  const save=dialog.getByRole('button',{name:'Choose export location…'});await save.focus(); await expect(save).toBeFocused();
  const target=await save.boundingBox();expect(target!.height).toBeGreaterThanOrEqual(44);
  const focus=await save.evaluate(node=>getComputedStyle(node).outlineStyle);expect(focus).not.toBe('none');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.screenshot({path:info.outputPath('markdown-export.png')});
  await page.keyboard.press('Enter'); await expect(dialog).not.toBeVisible();
  const calls=await page.evaluate(()=>(window as any).exportFixture.calls);
  expect(calls).toHaveLength(1);expect(calls[0].filename).toBe('Group.md');expect(calls[0].text).toContain('Current author text — 🐺.\n\nPunch.');expect(calls[0].text).toContain('## Second sheet');
  expect(await geometry()).toEqual(before);
  await expect(page.locator('summary[aria-label="Actions for Group"]')).toBeFocused();
  expect(await page.locator('vite-error-overlay').count()).toBe(0);expect(errors).toEqual([]);
});

test('source folder export includes descendants and supports Escape at enlarged text size',async({page},info)=>{
  await page.goto('/tests/browser/library-app.html?export');
  await page.getByRole('button',{name:'More actions'}).click();
  await page.getByRole('button',{name:/^Appearance/}).click();
  await page.getByRole('button',{name:'High contrast',exact:true}).click(); await page.keyboard.press('Escape');
  await expect(page.locator('html')).toHaveAttribute('data-theme','contrast');
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  await drawer(page);
  await page.locator('summary[aria-label="Project actions"]').click();
  await page.getByRole('group',{name:'Project actions'}).getByRole('button',{name:'Source files',exact:true}).click();
  await page.locator('summary[aria-label="Actions for folder writing"]').click();
  await page.getByRole('group',{name:'Actions for folder writing'}).getByRole('button',{name:'Export as Markdown…'}).click();
  const dialog=page.getByRole('dialog',{name:'Export as Markdown',exact:true});
  await expect(dialog.getByRole('status')).toContainText('1 sheet ready');
  expect((await new AxeBuilder({page}).include('dialog[aria-label="Export as Markdown"]').analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
  const save=dialog.getByRole('button',{name:'Choose export location…'});await save.focus();
  expect(await save.evaluate(node=>{const range=document.createRange();range.setStart(node.firstChild!,0);range.setEnd(node.firstChild!,6);return range.getClientRects().length;})).toBe(1);
  await page.screenshot({path:info.outputPath('markdown-export-large-text.png')});
  await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
  await expect(page.locator('summary[aria-label="Actions for folder writing"]')).toBeFocused();
  expect(await page.evaluate(()=>(window as any).exportFixture.calls)).toEqual([]);
});
