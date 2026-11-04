import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for (const zoom of [100, 200]) {
  test(`expanded settings stay above the composer at ${zoom}%`, async ({page}) => {
    await page.goto('/tests/browser/questions.html');
    await page.evaluate(zoom => {document.documentElement.dataset.zoom = String(zoom);}, zoom);
    const editor = page.locator('.cm-content');
    const before = await editor.evaluate(el => {const r=el.getBoundingClientRect();return {left:r.left,width:r.width,height:r.height};});
    // Exercise the legacy question-panel rule even if its stylesheet loads last.
    await page.addStyleTag({content: '.question-panel { display: grid; grid-template-rows: auto auto minmax(8rem, 1fr) auto; overflow: hidden; }'});
    await page.keyboard.press('Control+j');
    const pane = page.locator('.question-panel.heinlein-pane');
    await expect(pane).toHaveCSS('display', 'flex');
    await pane.locator('.question-settings-toggle').click();
    await pane.getByText('Storage and revision safety', {exact:true}).click();
    const body = pane.locator('.heinlein-body');
    const composer = pane.locator('.heinlein-composer');
    const bounds = await pane.evaluate(el => {
      const b=el.querySelector('.heinlein-body')!.getBoundingClientRect();
      const c=el.querySelector('.heinlein-composer')!.getBoundingClientRect();
      return {bodyBottom:b.bottom,composerTop:c.top};
    });
    expect(bounds.bodyBottom).toBeLessThanOrEqual(bounds.composerTop + 1);
    await body.evaluate(el => {el.scrollTop=el.scrollHeight;});
    await expect(composer.getByRole('textbox', {name:'Your drafting question'})).toBeVisible();
    expect(await editor.evaluate(el => {const r=el.getBoundingClientRect();return {left:r.left,width:r.width,height:r.height};})).toEqual(before);
    const report = await new AxeBuilder({page}).include('.question-panel').analyze();
    expect(report.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
  });
}
