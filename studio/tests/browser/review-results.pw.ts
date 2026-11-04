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
    if (withEdits) {
      await expect(pane).toBeHidden();
      await expect(page.getByRole('button',{name:'Chats',exact:true})).toHaveAttribute('aria-expanded','false');
      await page.getByRole('button',{name:'Heinlein',exact:true}).click();
    }
    if (!withEdits) {
      await expect(pane.getByRole('button', {name:'Retry review',exact:true})).toBeVisible();
      await expect(pane.getByRole('status')).toContainText('An improvement point contains invalid diff references.');
      await expect(pane.locator('.review-feedback-list')).toHaveCount(0);
      expect(await shape()).toEqual(before); expect(errors).toEqual([]);
      const state=await page.evaluate(()=>(window as any).questionsFixture.state());
      expect(state.source).toBe(state.original); expect(state.applied).toBe(0);
      return;
    }
    await expect(pane.getByRole('heading', {name:'Reading overview', exact:true})).toBeVisible();
    await expect(pane.locator('.review-feedback-list')).toHaveCount(2);
    await expect(pane.locator('.review-feedback-list li')).toHaveCount(6);
    await expect(pane.getByRole('heading', {name:'Strengths'})).toBeVisible();
    await expect(pane.getByRole('heading', {name:'Points for improvement'})).toBeVisible();
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

for (const zoom of [100, 200]) {
  test(`${zoom}% starts a new review from the visible results button`, async ({page}, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {if (message.type() === 'error') errors.push(message.text());});
    await page.goto('/tests/browser/questions.html');
    await expect(page).toHaveTitle('Passage Questions fixture');
    await expect(page).toHaveURL(/questions\.html$/);
    await page.evaluate(async () => {await (window as any).questionsFixture.ready; await document.fonts.ready;});
    await page.evaluate(zoom => document.documentElement.dataset.zoom = String(zoom), zoom);
    const shape = () => page.locator('.cm-content').evaluate(node => ({width: node.getBoundingClientRect().width, lines: [...node.children].map(line => ({width:line.getBoundingClientRect().width,height:line.getBoundingClientRect().height}))}));
    const before = await shape();
    await page.getByRole('button', {name:'Heinlein', exact:true}).click();
    await page.getByRole('button', {name:'Whole scene', exact:true}).click();
    const pane = page.locator('.heinlein-review-panel');
    await pane.getByRole('button', {name:'Run review', exact:true}).click();
    await page.evaluate(() => (window as any).questionsFixture.finishReviewWithFeedback(true));
    await expect(pane).toBeHidden();
    await page.getByRole('button',{name:'Heinlein',exact:true}).click();
    const startNew = pane.getByRole('button', {name:'Start a new review', exact:true});
    await expect(startNew).toBeVisible();
    await expect(pane.locator('.review-more-menu')).toBeHidden();
    expect(await startNew.evaluate(node => {const r=node.getBoundingClientRect(); return r.height >= 44 && r.width >= 44 && r.left >= 0 && r.right <= innerWidth;})).toBe(true);
    expect(await pane.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    expect((await new AxeBuilder({page}).include('.heinlein-review-panel').analyze()).violations).toEqual([]);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
    await startNew.scrollIntoViewIfNeeded();
    await page.screenshot({path:`/tmp/heinlein-new-review-${info.project.name}-${zoom}.png`});
    await startNew.focus();
    await expect(startNew).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(pane.locator('.review-setup-view')).toBeVisible();
    await expect(pane.locator('.review-results')).toBeHidden();
    await expect(pane.getByRole('button', {name:'Run review', exact:true})).toBeFocused();
    expect(await shape()).toEqual(before);
    const state = await page.evaluate(() => (window as any).questionsFixture.state());
    expect(state.source).toBe(state.original); expect(state.applied).toBe(0);
    expect(errors).toEqual([]);
  });
}


test('completed review closes Chats and keeps manuscript chips actionable', async ({page}, info) => {
  const errors:string[]=[]; page.on('pageerror',error=>errors.push(error.message));
  await page.goto('/tests/browser/questions.html');
  await page.evaluate(async()=>{await (window as any).questionsFixture.ready;await document.fonts.ready;});
  const editor=page.locator('.cm-content');
  const shape=()=>editor.evaluate(node=>({width:node.getBoundingClientRect().width,lines:[...node.children].map(line=>line.getBoundingClientRect().height)}));
  const before=await shape();
  await page.getByRole('button',{name:'Heinlein',exact:true}).click();
  await page.getByRole('button',{name:'Whole scene',exact:true}).click();
  await page.locator('.heinlein-review-panel').getByRole('button',{name:'Run review',exact:true}).click();
  await page.evaluate(()=>(window as any).questionsFixture.finishReviewWithFeedback(true));
  await expect(page.getByRole('button',{name:'Chats',exact:true})).toHaveAttribute('aria-expanded','false');
  await expect(page.locator('.heinlein-review-panel')).toBeHidden(); await expect(editor).toBeFocused();
  expect(await shape()).toEqual(before);
  const chip=editor.locator('[data-review-id]').first();await expect(chip).toBeVisible();await chip.click();
  const dialog=page.getByRole('dialog',{name:'Review suggestion',exact:true});
  await expect(dialog).toBeVisible();await expect(dialog.locator('.review-inline-diff')).toBeVisible();
  await expect(dialog.getByRole('button',{name:'Reject',exact:true})).toBeVisible();
  expect((await new AxeBuilder({page}).include('.review-suggestion-dialog').analyze()).violations).toEqual([]);
  await page.keyboard.press('Escape');await expect(editor).toBeFocused();expect(await shape()).toEqual(before);
  const state=await page.evaluate(()=>(window as any).questionsFixture.state());expect(state.source).toBe(state.original);expect(state.applied).toBe(0);
  expect(errors).toEqual([]);await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  await page.screenshot({path:`/tmp/heinlein-auto-close-review-${info.project.name}.png`});
});
