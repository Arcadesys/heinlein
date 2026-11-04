import {test,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

for(const payload of ['', 'Replacement paragraph — 🦊.\nSecond line.'])test(`paste ${payload?'replaces only the selected passage':'with no readable text preserves the whole document'}`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.goto('/tests/browser/editor-automation.html');
  await expect(page).toHaveTitle('Heinlein synthetic editor automation');
  const original=await page.evaluate(()=>(window as any).editorAutomationFixture.baseline as string);
  await page.getByRole('button',{name:'Show target paragraph',exact:true}).click();
  const selected=await page.evaluate(()=>{
    const f=(window as any).editorAutomationFixture,view=f.editor.view;
    const from=view.state.doc.toString().indexOf(f.target),to=from+f.target.length;
    view.dispatch({selection:{anchor:from,head:to},scrollIntoView:true});view.focus();
    return f.target as string;
  });
  await page.locator('.cm-content').evaluate((el,text)=>{
    const data=new DataTransfer();data.setData('text/plain',text);
    el.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));
  },payload);
  const expected=payload?original.replace(selected,payload.replace(/\n/g,'\r\n')):original;
  await expect.poll(()=>page.evaluate(()=>(window as any).editorAutomationFixture.editor.text())).toBe(expected);
  if(!payload)await expect(page.getByRole('status').filter({hasText:'Paste contained no readable text'})).toBeVisible();
  await page.keyboard.press('ControlOrMeta+s');
  await page.reload();
  await expect.poll(()=>page.evaluate(()=>(window as any).editorAutomationFixture.editor.text())).toBe(expected);
  await page.locator('.cm-content').focus();await page.keyboard.press('ControlOrMeta+End');await page.keyboard.insertText(' More writing.');
  await expect.poll(()=>page.evaluate(()=>(window as any).editorAutomationFixture.editor.text())).toBe(expected+' More writing.');
  // A fast reload can leave inherited fixture text in its startup color
  // transition. Audit the settled foreground, without changing the AA check.
  await expect.poll(()=>page.locator('#app').evaluate(node=>getComputedStyle(node).color===getComputedStyle(node.querySelector('.cm-editor')!).color)).toBe(true);
  expect((await new AxeBuilder({page}).include('#app').analyze()).violations).toEqual([]);
  expect(await page.locator('vite-error-overlay').count()).toBe(0);expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath(`paste-${payload?'replacement':'protected'}.png`),fullPage:true});
});
