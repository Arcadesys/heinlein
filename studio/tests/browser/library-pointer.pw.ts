import {test,expect,type Page,type Locator} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function drag(page:Page,source:Locator,target:Locator,part=.8){const a=await source.boundingBox(),b=await target.boundingBox();await page.mouse.move(a!.x+a!.width/2,a!.y+a!.height/2);await page.mouse.down();await page.mouse.move(b!.x+b!.width/2,b!.y+b!.height*part,{steps:12});await page.mouse.up();}
test.beforeEach(async({page})=>{await page.goto('/tests/browser/library-pointer.html');await page.evaluate(()=>localStorage.removeItem('heinlein-pointer-fixture'));await page.reload();await expect(page.locator('.scene-open')).toHaveText(['Alpha','Beta','Gamma']);});
test('physical pointer reorder persists, suppresses accidental open, and ordinary clicks still open',async({page})=>{
 await expect(page.getByRole('button',{name:'Alpha',exact:true})).toHaveAttribute('draggable','false');
 await drag(page,page.getByRole('button',{name:'Alpha',exact:true}),page.getByRole('button',{name:'Beta',exact:true}));
 await expect(page.locator('.scene-open')).toHaveText(['Beta','Alpha','Gamma']);
 await expect(page.locator('#opened')).toBeEmpty();
 await page.reload();await expect(page.locator('.scene-open')).toHaveText(['Beta','Alpha','Gamma']);
 await page.getByRole('button',{name:'Beta',exact:true}).click();await expect(page.locator('#opened')).toHaveText('ms/b.md');
});
test('pointer can move a scene into another chapter and reorder chapter groups',async({page})=>{
 await drag(page,page.getByRole('button',{name:'Alpha',exact:true}),page.getByRole('button',{name:'Ending',exact:true}));
 await expect(page.locator('.tree-group').filter({has:page.getByRole('button',{name:'Ending',exact:true})}).first().locator('.scene-open')).toHaveText(['Gamma','Alpha']);
 await drag(page,page.getByRole('button',{name:'Ending',exact:true}),page.getByRole('button',{name:'Opening',exact:true}),.1);
 await expect(page.locator('.tree-toggle')).toHaveText(['Ending','Opening']);
 await page.reload();await expect(page.locator('.tree-toggle')).toHaveText(['Ending','Opening']);
 await expect(page.locator('.scene-open')).toHaveText(['Gamma','Alpha','Beta']);
});
test('Escape cancels a pending drag without a write',async({page})=>{
 const a=await page.getByRole('button',{name:'Alpha',exact:true}).boundingBox(),b=await page.getByRole('button',{name:'Beta',exact:true}).boundingBox();
 await page.mouse.move(a!.x+30,a!.y+20);await page.mouse.down();await page.mouse.move(b!.x+30,b!.y+b!.height*.8,{steps:8});
 await expect(page.locator('#status')).toContainText('Release to move');
 await page.keyboard.press('Escape');await page.mouse.up();
 await expect(page.locator('.scene-open')).toHaveText(['Alpha','Beta','Gamma']);
 expect(await page.evaluate(()=>localStorage.getItem('heinlein-pointer-fixture'))).toBeNull();
});
test('keyboard move controls retain focus and accessible targets at enlarged text',async({page})=>{
 await page.evaluate(()=>{document.documentElement.style.fontSize='150%';});
 await page.locator('summary[aria-label="Actions for Alpha"]').click();
 await page.getByRole('group',{name:'Actions for Alpha'}).getByRole('button',{name:'Move later',exact:true}).click();
 await expect(page.locator('.scene-open')).toHaveText(['Beta','Alpha','Gamma']);
 await expect(page.getByRole('button',{name:'Alpha',exact:true})).toBeFocused();
 expect((await new AxeBuilder({page}).include('.drafting-panel').analyze()).violations).toEqual([]);
});
test('dropping in the existing position does not write',async({page})=>{
 await drag(page,page.getByRole('button',{name:'Alpha',exact:true}),page.getByRole('button',{name:'Beta',exact:true}),.1);
 await expect(page.locator('.scene-open')).toHaveText(['Alpha','Beta','Gamma']);
 expect(await page.evaluate(()=>localStorage.getItem('heinlein-pointer-fixture'))).toBeNull();
});
test('holding a drag at the edge scrolls a long library and Escape stops it',async({page})=>{
 await page.goto('/tests/browser/library-pointer.html?long');await expect(page.locator('.scene-open')).toHaveCount(33);
 const a=await page.getByRole('button',{name:'Alpha',exact:true}).boundingBox(),box=await page.locator('.drafting-panel').boundingBox();
 await page.mouse.move(a!.x+30,a!.y+20);await page.mouse.down();await page.mouse.move(a!.x+30,box!.y+box!.height-10,{steps:10});
 await expect.poll(()=>page.locator('.drafting-panel').evaluate(el=>el.scrollTop)).toBeGreaterThan(0);
 await page.keyboard.press('Escape');await page.mouse.up();
 expect(await page.evaluate(()=>localStorage.getItem('heinlein-pointer-fixture'))).toBeNull();
});
