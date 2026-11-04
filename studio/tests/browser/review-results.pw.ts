import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for (const zoom of [100, 200]) for (const withEdits of [true, false]) {
  test(`${zoom}% completed review has reading feedback and ${withEdits ? 'a working diff jump' : 'rejection of improvement points without diffs'}`, async ({page}, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.goto('/tests/browser/questions.html');
    await expect(page).toHaveTitle('Passage Questions fixture');
    await expect(page).toHaveURL(/questions\.html$/);
    await page.evaluate(async () => {await (window as any).questionsFixture.ready; await document.fonts.ready;});
    await page.evaluate(zoom => document.documentElement.dataset.zoom = String(zoom), zoom);
    await expect(page.locator('.cm-content')).toBeVisible();
    const shape = () => page.locator('.cm-content').evaluate(node => ({width: node.getBoundingClientRect().width, lines: [...node.children].map(line => ({width:line.getBoundingClientRect().width,height:line.getBoundingClientRect().height}))}));
    const before = await shape();
    await page.getByRole('button', {name:'Heinlein', exact:true}).click();
    await page.getByRole('button', {name:'Whole scene', exact:true}).click();
    const pane = page.locator('.heinlein-review-panel');
    await pane.getByRole('button', {name:'Run review', exact:true}).click();
    await page.evaluate(withEdits => (window as any).questionsFixture.finishReviewWithFeedback(withEdits), withEdits);
    if (!withEdits) {
      await expect(pane.getByRole('button', {name:'Retry review',exact:true})).toBeVisible();
      await expect(pane.getByRole('status')).toContainText('Each improvement point needs at least one targeted diff.');
      await expect(pane.locator('.review-feedback-list')).toHaveCount(0);
      expect(await shape()).toEqual(before); expect(errors).toEqual([]);
      const state=await page.evaluate(()=>(window as any).questionsFixture.state());
      expect(state.source).toBe(state.original); expect(state.applied).toBe(0);
      return;
    }
    await expect(pane.getByRole('heading', {name:'Reading overview', exact:true})).toBeVisible();
    await expect(pane.locator('.review-feedback-list')).toHaveCount(2);
    await expect(pane.locator('.review-feedback-list li')).toHaveCount(6);
    await expect(pane.getByRole('heading', {name:'Three good things'})).toBeVisible();
    await expect(pane.getByRole('heading', {name:'Three points for improvement'})).toBeVisible();
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    expect(await shape()).toEqual(before);
    expect((await new AxeBuilder({page}).include('.heinlein-review-panel').analyze()).violations).toEqual([]);
    expect(await pane.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({path:`/tmp/heinlein-review-results-${info.project.name}-${zoom}-${withEdits ? 'diff' : 'empty'}.png`});
    const originals = ['The station clock stopped at midnight.', 'Mara crossed the empty platform.', 'Rain tapped the glass roof.'];
    for (let index=0;index<3;index++) {
      const point = pane.locator('.review-feedback-list').nth(1).locator('li').nth(index);
      const jump = point.getByRole('button', {name:new RegExp(`Jump to diff ${index+1}:`)});
      await expect(point.locator('.review-improvement-jump')).toHaveCount(1);
      await jump.scrollIntoViewIfNeeded(); await jump.focus();
      expect(await jump.evaluate(node => {const r=node.getBoundingClientRect(); return r.height >= 44 && r.width >= 44;})).toBe(true);
      await page.keyboard.press('Enter');
      await expect(pane).toBeHidden();
      await expect(page.locator('.cm-content')).toBeFocused();
      expect(await page.locator('.cm-content').evaluate(async node => {
        const {EditorView} = await import('/node_modules/@codemirror/view/dist/index.js');
        const view=EditorView.findFromDOM(node)!; const range=view.state.selection.main;
        return view.state.sliceDoc(range.from,range.to);
      })).toBe(originals[index]);
      expect(await shape()).toEqual(before);
      if(index<2) await page.getByRole('button', {name:'Heinlein', exact:true}).click();
    }
    const state = await page.evaluate(() => (window as any).questionsFixture.state());
    expect(state.source).toBe(state.original); expect(state.applied).toBe(0); expect(state.reviewed).toBe(0);
    expect(errors).toEqual([]);
  });
}
