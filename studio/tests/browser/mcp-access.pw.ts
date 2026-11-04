import {test,expect,type Page} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function project(page:Page,name:string){const navigation=page.getByRole('dialog',{name:'Navigation',exact:true});if(await navigation.isVisible())await navigation.getByRole('button',{name:'Return to writing',exact:true}).click();await page.locator('.project-switcher').focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:`Open ${name}`,exact:true}).focus();await page.keyboard.press('Enter');await expect(page.locator('.project-library')).not.toBeVisible();await expect(page.locator('.files .project-connection-entry')).toBeVisible();}
async function connection(page:Page){
  const direct=page.locator('.files .project-connection-entry');
  if(await direct.isVisible()){await direct.focus();await page.keyboard.press('Enter');}
  else{await page.getByRole('button',{name:'More actions',exact:true}).focus();await page.keyboard.press('Enter');const entry=page.getByRole('button',{name:'Codex connection…',exact:true});await entry.focus();await page.keyboard.press('Enter');}
  await expect(page.getByRole('dialog',{name:'Codex connection',exact:true})).toBeVisible();
}
for(const high of [false,true])test(`one connection grants projects with easy setup and revokes without changing writing (${high?'contrast':'default'})`,async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`/tests/browser/mcp-access.html${high?'?contrast':''}`);await expect(page.locator('.standalone-editor')).toBeVisible();
  if(high)for(let i=0;i<8&&await page.locator('html').getAttribute('data-zoom')!=='200';i++)await page.keyboard.press('Control+=');
  const before=await page.evaluate(()=>JSON.stringify((window as any).mcpFixture.fixture.documents));
  await project(page,'Novel A');await connection(page);const dialog=page.getByRole('dialog',{name:'Codex connection',exact:true});
  await expect(dialog).toContainText('No project is shared yet.');expect(await page.evaluate(()=>(window as any).mcpFixture.calls.filter((r:any)=>r.action!=='status'))).toEqual([]);
  await dialog.getByRole('button',{name:'Connect Codex',exact:true}).click();await expect(dialog).toContainText('Codex configured.');
  await dialog.getByRole('button',{name:'Allow this project',exact:true}).focus();await page.keyboard.press('Enter');await expect(dialog).toContainText('Project access is enabled');
  await expect(dialog.getByRole('heading',{name:'Codex connection',exact:true})).toBeFocused();
  expect((await new AxeBuilder({page}).include('.mcp-access-panel').analyze()).violations).toEqual([]);
  await page.screenshot({path:info.outputPath('mcp-project-connection.png'),fullPage:true});
  await dialog.getByText('Manual setup command',{exact:true}).click();
  for(const b of await dialog.locator('button:visible').all())expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);
  await dialog.getByRole('button',{name:'Back to writing',exact:true}).click();
  await project(page,'Novel B');await connection(page);await expect(dialog).toContainText('Codex currently has access to Novel A');
  await dialog.getByRole('button',{name:'Allow this project',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).mcpFixture.grant.projectKey)).toBe('source-key-github-a');
  await dialog.getByRole('button',{name:'Disconnect project access',exact:true}).click();await expect(dialog).toContainText('No project is shared yet.');
  expect(await page.evaluate(()=>JSON.stringify((window as any).mcpFixture.fixture.documents))).toBe(before);expect(await page.evaluate(()=>(window as any).mcpFixture.fixture.externalCalls)).toEqual([]);
  expect(await page.evaluate(()=>(window as any).mcpFixture.calls.some((r:any)=>r.action==='useSource'))).toBe(false);expect(errors).toEqual([]);
});
test('project access does not require saving or sending an unsaved editor buffer',async({page})=>{
  await page.goto('/tests/browser/mcp-access.html');await expect(page.locator('.standalone-editor')).toBeVisible();await project(page,'Novel A');
  await page.evaluate(async()=>{const f=(window as any).mcpFixture;f.fixture.core.saveDocument=async()=>{throw Error('Synthetic save refusal');};await f.app.showDocument('scene.md');});
  const before=await page.evaluate(()=>JSON.stringify((window as any).mcpFixture.fixture.documents));await page.locator('.cm-content').click();await page.keyboard.press('Control+End');await page.keyboard.type('Unsaved synthetic writing');
  const geometry=()=>page.locator('.cm-content').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,width:r.width};});const layout=await geometry();
  await connection(page);expect(await geometry()).toEqual(layout);const dialog=page.getByRole('dialog',{name:'Codex connection',exact:true});await expect(dialog.getByRole('button',{name:'Allow this project',exact:true})).toBeEnabled();await dialog.getByRole('button',{name:'Allow this project',exact:true}).click();await expect(dialog).toContainText('Project access is enabled');
  const sent=await page.evaluate(()=>{const f=(window as any).mcpFixture;return {call:f.calls.findLast((r:any)=>r.action==='useProject'),active:f.fixture.active};});expect(sent.call).toEqual({action:'useProject',repositoryId:sent.active});
  await dialog.getByRole('button',{name:'Back to writing',exact:true}).click();await expect(page.locator('.cm-content')).toContainText('Unsaved synthetic writing');expect(await page.evaluate(()=>JSON.stringify((window as any).mcpFixture.fixture.documents))).toBe(before);
});
