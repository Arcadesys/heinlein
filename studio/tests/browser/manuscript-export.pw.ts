import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function open(page:Page){
 await page.goto('/tests/browser/library-app.html?export&unified');
 const nav=page.getByRole('button',{name:'Navigation',exact:true});if(await nav.isVisible())await nav.click();
 await page.getByRole('button',{name:'Export manuscript…',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'Export manuscript',exact:true});await expect(dialog.getByRole('status')).toContainText('2 sheets ready');return dialog;
}
for(const [format,extension] of [['markdown','md'],['pdf','pdf'],['epub','epub'],['html','html'],['docx','docx']]){
 test(`${format} exports the complete ordered manuscript with references off`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));const dialog=await open(page);
  await expect(dialog).toContainText('Entire manuscript — Synthetic book');await expect(dialog.getByRole('checkbox',{name:'Include reference sheets'})).not.toBeChecked();
  await dialog.getByRole('combobox',{name:'Export format'}).selectOption(format);
  await dialog.getByRole('textbox',{name:'Export author'}).fill('Synthetic Author');
  expect((await new AxeBuilder({page}).include('dialog').withTags(['wcag2a','wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({path:info.outputPath(`export-${format}.png`)});
  await dialog.getByRole('button',{name:'Choose export location…'}).click();await expect(dialog).toHaveCount(0);
  const calls=await page.evaluate(()=>(window as any).exportFixture.calls);expect(calls).toHaveLength(1);expect(calls[0].filename).toBe(`Synthetic book.${extension}`);expect(calls[0].format).toBe(format);expect(calls[0].author).toBe('Synthetic Author');
  expect(calls[0].text.indexOf('ALPHA-BEGIN')).toBeLessThan(calls[0].text.indexOf('OMEGA-END'));expect(calls[0].text).not.toContain('REFERENCE-ONLY');expect(errors).toEqual([]);
 });
}
test('references are explicit and dependency failure/cancel leave a retryable dialog',async({page})=>{
 const dialog=await open(page);await dialog.getByRole('checkbox',{name:'Include reference sheets'}).check();await expect(dialog.getByRole('status')).toContainText('3 sheets ready');
 await dialog.getByRole('combobox').selectOption('pdf');await page.evaluate(()=>(window as any).exportFixture.setOutcome('failed'));await dialog.getByRole('button',{name:'Choose export location…'}).click();
 await expect(dialog.getByRole('status')).toContainText('Pandoc is missing');await expect(dialog.getByRole('combobox')).toBeEnabled();
 await page.evaluate(()=>(window as any).exportFixture.setOutcome('canceled'));await dialog.getByRole('button',{name:'Choose export location…'}).click();await expect(dialog.getByRole('status')).toContainText('canceled');
 await dialog.getByRole('combobox').selectOption('markdown');await dialog.getByRole('button',{name:'Choose export location…'}).click();await expect(dialog).toHaveCount(0);
 const calls=await page.evaluate(()=>(window as any).exportFixture.calls);expect(calls.at(-1).text).toContain('REFERENCE-ONLY');
});
test('project actions puts Export before the recent-project block',async({page})=>{
 await page.goto('/tests/browser/library-app.html?export&unified');const nav=page.getByRole('button',{name:'Navigation',exact:true});if(await nav.isVisible())await nav.click();
 await page.locator('summary[aria-label="Project actions"]').click();const actions=page.getByRole('group',{name:'Project actions',exact:true});
 await expect(actions.getByRole('button').first()).toHaveText('Export manuscript…');await expect(actions.getByRole('button').first()).toBeInViewport();
 await actions.getByRole('button').first().click();await expect(page.getByRole('dialog',{name:'Export manuscript',exact:true})).toBeVisible();
});
