import {test,expect} from '@playwright/test';
for(const width of [650,1200])for(const zoom of [100,150,200,300]){
 test(`daily counter stays visible and preserves writer geometry at ${width}px ${zoom}%`,async({page},info)=>{
  await page.setViewportSize({width,height:950});
  await page.addInitScript(zoom=>{
    localStorage.setItem('heinlein-studio-zoom-v1',String(zoom));
    const d=new Date();const date=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    localStorage.setItem('heinlein-studio-writing-v1',JSON.stringify({version:1,goal:1000,days:{[date]:{seed:{peak:999,words:999}}}}));
  },zoom);
  await page.goto('/tests/browser/writing-layout.html');
  await page.waitForFunction(()=>document.documentElement.dataset.layoutReady==='true');
  const goal=page.locator('.status-pill > .pill-goal');await expect(goal).toBeVisible();
  expect(await goal.evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})).toBe(true);
  const before=await page.evaluate(()=>{const v=(window as any).layoutFixture.view();(window as any).counterWriter=v;return{doc:v.state.doc.toString(),width:document.querySelector('.cm-content')!.getBoundingClientRect().width,pane:document.querySelector('.active-document-pane')!.getBoundingClientRect().toJSON(),selection:v.state.selection.toJSON()};});
  await goal.click();await expect(page.getByRole('dialog',{name:'Daily goal',exact:true})).toBeVisible();
  await page.getByRole('spinbutton',{name:'Daily word goal'}).fill('1250');await page.getByRole('spinbutton',{name:'Daily word goal'}).press('Tab');
  await expect(goal).toHaveAccessibleName(/1,250/);
  await page.getByRole('button',{name:'Close daily goal'}).click();
  const after=await page.evaluate(()=>{const v=(window as any).layoutFixture.view();return{same:v===(window as any).counterWriter,doc:v.state.doc.toString(),width:document.querySelector('.cm-content')!.getBoundingClientRect().width,pane:document.querySelector('.active-document-pane')!.getBoundingClientRect().toJSON(),selection:v.state.selection.toJSON()};});
  expect(after.same).toBe(true);expect(after.doc).toBe(before.doc);expect(after.width).toBe(before.width);expect(after.pane).toEqual(before.pane);expect(after.selection).toEqual(before.selection);
  const beforeGrowth=await page.locator('.active-document-pane').boundingBox();
  await page.locator('.cm-content').focus();await page.keyboard.insertText(' added ');
  await expect(goal).toHaveAccessibleName(/Daily goal: 1,000 \/ 1,250/);
  expect(await goal.evaluate(el=>getComputedStyle(el).opacity)).toBe('1');
  expect(await goal.locator('..').evaluate(el=>getComputedStyle(el).opacity)).toBe('1');
  expect(await page.locator('.active-document-pane').boundingBox()).toEqual(beforeGrowth);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath(`counter-${width}-${zoom}.png`)});
 });
}
