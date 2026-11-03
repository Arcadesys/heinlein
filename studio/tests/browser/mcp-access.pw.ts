import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function project(page:Page,name:string){await page.locator('.project-switcher').focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:`Open ${name}`,exact:true}).focus();await page.keyboard.press('Enter');await expect(page.locator('.project-library')).not.toBeVisible();await page.evaluate(()=>(window as any).mcpFixture.app.showDocument('scene.md'));}
async function connection(page:Page){await page.getByRole('button',{name:'More actions',exact:true}).focus();await page.keyboard.press('Enter');const entry=page.getByRole('button',{name:'MCP connection…',exact:true});await entry.focus();await page.keyboard.press('Enter');await expect(page.getByRole('dialog',{name:'MCP connection',exact:true})).toBeVisible();}
for(const high of [false,true])test(`one connection explicitly selects different projects and revokes without manuscript changes (${high?'contrast':'default'})`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`/tests/browser/mcp-access.html${high?'?contrast':''}`);await expect(page.locator('.standalone-editor')).toBeVisible();
  if(high)for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');
  const before=await page.evaluate(()=>JSON.stringify((window as any).mcpFixture.fixture.documents));
  await project(page,'Novel A');await connection(page);const dialog=page.getByRole('dialog',{name:'MCP connection',exact:true});
  await expect(dialog).toContainText('No project files are allowed.');
  expect(await page.evaluate(()=>(window as any).mcpFixture.calls.filter((r:any)=>r.action!=='status'))).toEqual([]);
  await page.getByRole('button',{name:'Allow this source file…',exact:true}).focus();await page.keyboard.press('Enter');await expect(dialog).toContainText('Allowed source files in this project:');
  await expect(dialog.getByRole('heading',{name:'MCP connection',exact:true})).toBeFocused();
  expect((await new AxeBuilder({page}).include('.mcp-access-panel').analyze()).violations).toEqual([]);
  for(const b of await dialog.locator('button').all())expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath('mcp-project-selection.png'),fullPage:true});
  await page.getByRole('button',{name:'Back to writing',exact:true}).focus();await page.keyboard.press('Enter');
  await project(page,'Novel B');await connection(page);await expect(dialog).toContainText('A different project is currently allowed');
  await page.getByRole('button',{name:'Allow this source file…',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).mcpFixture.grant.projectKey)).toBe('source-key-github-a');
  await page.getByRole('button',{name:'Disconnect all project access',exact:true}).click();await expect(dialog).toContainText('No project files are allowed.');
  expect(await page.evaluate(()=>JSON.stringify((window as any).mcpFixture.fixture.documents))).toBe(before);
  expect(await page.evaluate(()=>(window as any).mcpFixture.fixture.externalCalls)).toEqual([]);expect(errors).toEqual([]);
});
