import {expect, test} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('restore a deleted passage while keeping newer writing', async ({page}) => {
  await page.goto('/tests/browser/document-tabs.html?titled&history');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  await page.evaluate(() => {
    const fixture = (window as any).documentFixture;
    fixture.theme(true);
    document.documentElement.dataset.zoom = '200';
    const view = fixture.view();
    view.dispatch({changes: {from: view.state.doc.length, insert: ' Still writing.'}});
  });
  async function openHistory() {
    await page.getByRole('button', {name:'Document actions',exact:true}).click();
    await page.getByRole('button', {name:'Editing actions',exact:true}).click();
    const history = page.getByRole('button',{name:'Scene history…'});
    await history.focus();
    await history.press('Enter');
    return page.getByRole('dialog',{name:'Scene history'});
  }
  const writingLayout = () => page.locator('.active-document-pane .cm-content').evaluate(el => {
    const box=el.getBoundingClientRect(),style=getComputedStyle(el);
    return {width:box.width,font:style.font,lineHeight:style.lineHeight};
  });
  const initialLayout=await writingLayout();
  const history = await openHistory();
  expect(await writingLayout()).toEqual(initialLayout);
  const restore = history.getByRole('button',{name:'Restore this passage'});
  await expect(history.getByLabel('Earlier passage')).toHaveValue('A lost passage — intact.\n');
  await expect(history.getByLabel('Current passage')).toHaveValue('');
  await expect(restore).toBeVisible();
  expect(await history.evaluate(el=>el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({page}).include('.scene-history').analyze()).violations).toEqual([]);
  await restore.focus();
  await restore.press('Enter');
  const text = () => page.evaluate(() => (window as any).documentFixture.view().state.doc.toString());
  expect(await text()).toBe('Opening.\nA lost passage — intact.\nAn unchanged bridge.\nA newer ending. Still writing.');
  await expect(page.locator('.active-document-pane .cm-content')).toBeFocused();
  expect(await writingLayout()).toEqual(initialLayout);
  await page.keyboard.press('Meta+z');
  expect(await text()).toBe('Opening.\nAn unchanged bridge.\nA newer ending. Still writing.');
});

test('restore selected words or reject a stale comparison', async ({page}) => {
  await page.goto('/tests/browser/document-tabs.html?titled&history');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  async function chooseEnding() {
    await page.getByRole('button', {name:'Document actions',exact:true}).click();
    await page.getByRole('button', {name:'Editing actions',exact:true}).click();
    await page.getByRole('button',{name:'Scene history…'}).click();
    const dialog = page.getByRole('dialog',{name:'Scene history'});
    await dialog.getByLabel('Changed passage').selectOption('1');
    return dialog;
  }
  let dialog = await chooseEnding();
  await dialog.getByRole('button',{name:'Choose a smaller selection'}).click();
  const earlier = dialog.getByLabel('Earlier passage'), current = dialog.getByLabel('Current passage');
  await earlier.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0,5));
  await current.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0,7));
  const preview = dialog.getByRole('button',{name:'Review selected restore…'});
  await preview.press('Enter');
  const review = page.getByRole('dialog', {name:'Review replacement'});
  await expect(review.getByRole('heading',{name:'Review replacement'})).toBeFocused();
  await expect(review.getByLabel('Current text to replace')).toHaveValue('A newer');
  await expect(review.getByLabel('Replacement text')).toHaveValue('First');
  await expect(review).toHaveAccessibleDescription('Replace starting at line 3, column 1.');
  const text = () => page.evaluate(() => (window as any).documentFixture.view().state.doc.toString());
  const before = 'Opening.\nAn unchanged bridge.\nA newer ending.';
  expect(await text()).toBe(before);
  await page.keyboard.press('Escape');
  await expect(review).toHaveCount(0);
  await expect(preview).toBeFocused();
  expect(await text()).toBe(before);
  await preview.press('Enter');
  await review.getByRole('button',{name:'Confirm replacement'}).press('Enter');
  expect(await text()).toBe('Opening.\nAn unchanged bridge.\nFirst ending.');
  await page.getByRole('button', {name:'Document actions',exact:true}).click();
  await page.getByRole('button', {name:'Editing actions',exact:true}).click();
  await page.getByRole('button',{name:'Scene history…'}).click();
  dialog = page.getByRole('dialog',{name:'Scene history'});
  await dialog.getByLabel('Compare with').selectOption('0');
  await expect(dialog.getByRole('status')).toHaveText('These versions have identical text.');
  await dialog.getByLabel('Compare with').selectOption('current');
  await expect(dialog.getByRole('button',{name:'Restore this passage'})).toBeVisible();
  await page.evaluate(() => (window as any).documentFixture.view().dispatch({changes:{from:0,insert:'Latest. '}}));
  await dialog.getByRole('button',{name:'Restore this passage'}).click();
  await expect(dialog.getByRole('status')).toContainText('scene changed');
  expect(await text()).toBe('Latest. Opening.\nAn unchanged bridge.\nFirst ending.');
});

test('review the exact insertion point, cancel, and refuse a stale confirmation', async ({page}) => {
  await page.goto('/tests/browser/document-tabs.html?titled&history');
  await page.waitForFunction(() => document.documentElement.dataset.tabsReady === 'true');
  await page.evaluate(() => {
    (window as any).documentFixture.theme(true);
    document.documentElement.dataset.zoom = '200';
  });
  const text = () => page.evaluate(() => (window as any).documentFixture.view().state.doc.toString());
  const before = await text();
  await page.getByRole('button',{name:'Document actions',exact:true}).click();
  await page.getByRole('button',{name:'Editing actions',exact:true}).click();
  await page.getByRole('button',{name:'Scene history…'}).click();
  const history = page.getByRole('dialog',{name:'Scene history'});
  await history.getByLabel('Changed passage').selectOption('1');
  await history.getByRole('button',{name:'Choose a smaller selection'}).click();
  await history.getByLabel('Earlier passage').evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(0,6));
  await history.getByLabel('Current passage').evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(2,2));
  const preview = history.getByRole('button',{name:'Review selected restore…'});
  await preview.press('Enter');
  const review = page.getByRole('dialog',{name:'Review insertion'});
  await expect(review).toHaveAccessibleDescription('Insert at line 3, column 3.');
  await expect(review.getByLabel('Immediately before the insertion point')).toHaveValue('Opening.\nAn unchanged bridge.\nA ');
  await expect(review.getByLabel('Immediately after the insertion point')).toHaveValue('newer ending.');
  await expect(review.getByLabel('Text to insert')).toHaveValue('First ');
  expect(await review.evaluate(el=>el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  expect((await new AxeBuilder({page}).include('.restore-confirmation').analyze()).violations).toEqual([]);
  await review.getByRole('button',{name:'Back to selection'}).press('Enter');
  await expect(preview).toBeFocused();
  expect(await text()).toBe(before);
  await preview.press('Enter');
  await review.getByRole('button',{name:'Confirm insertion'}).press('Enter');
  expect(await text()).toBe(before.replace('A newer','A First newer'));
  await page.keyboard.press('Meta+z');
  expect(await text()).toBe(before);
  await page.getByRole('button',{name:'Document actions',exact:true}).click();
  await page.getByRole('button',{name:'Editing actions',exact:true}).click();
  await page.getByRole('button',{name:'Scene history…'}).click();
  await history.getByRole('button',{name:'Choose a smaller selection'}).click();
  await history.getByLabel('Earlier passage').evaluate((el:HTMLTextAreaElement)=>el.setSelectionRange(0,1));
  await preview.press('Enter');
  await page.evaluate(()=> (window as any).documentFixture.view().dispatch({changes:{from:0,insert:'Latest. '}}));
  await review.getByRole('button',{name:'Confirm insertion'}).press('Enter');
  await expect(history.getByRole('status')).toContainText('scene changed');
  expect(await text()).toBe('Latest. ' + before);
});
