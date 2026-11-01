import {test, expect} from '@playwright/test';
// Invented manuscript + mocked host through production Studio. No native/provider/filesystem actions.
test('chapter revision reveals a scene left in Reading and keeps its exact selected source visible', async ({page}, info) => {
  const high = page.viewportSize()!.width === 320;
  const external: string[] = [], errors: string[] = [];
  const allowedOrigin = new URL(String(info.project.use.baseURL)).origin;
  page.on('request', request => {if (new URL(request.url()).origin !== allowedOrigin) external.push(request.url());});
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/tests/browser/markdown-reading.html?doc=chapter.md');
  const review = page.getByRole('region', {name: 'Heinlein Review', exact: true});
  await expect(review.locator('.review-edit').first()).toBeVisible();
  await review.getByRole('button', {name: 'Return to writing', exact: true}).click();
  if (high) await page.evaluate(() => {document.documentElement.dataset.zoom = '200';(window as any).readingFixture.theme();});
  const before = await page.evaluate(() => JSON.stringify((window as any).readingFixture.docs));
  await page.evaluate(() => (window as any).readingFixture.app.showDocument('harbor.md'));
  const mode = page.getByRole('group', {name: 'Document view', exact: true});
  await mode.getByRole('button', {name: 'Reading', exact: true}).click();
  await expect(page.locator('.active-document-pane .markdown-reader')).toBeVisible();
  await page.evaluate(() => (window as any).readingFixture.app.showDocument('chapter.md'));
  await mode.getByRole('button', {name: 'Reading', exact: true}).click();
  await expect(page.locator('.active-document-pane .markdown-reader')).toContainText('The Harbor');
  await mode.getByRole('button', {name: 'Source', exact: true}).click();
  await page.evaluate(() => {
    const view = (window as any).readingFixture.view(), from = view.state.doc.toString().lastIndexOf('twice');
    if (from < 0) throw Error('Synthetic chapter target missing');
    view.dispatch({selection: {anchor: from, head: from + 5}, scrollIntoView: true});view.focus();
  });
  await page.getByRole('button', {name: 'Reading assembled source actions', exact: true}).click();
  const revise = page.getByRole('button', {name: 'Revise source passage', exact: true});
  await revise.focus();await revise.scrollIntoViewIfNeeded();
  const trigger = await revise.boundingBox();expect(trigger!.height).toBeGreaterThanOrEqual(48);expect(trigger!.width).toBeGreaterThanOrEqual(48);
  await page.keyboard.press('Enter');
  const content = page.locator('.active-document-pane .markdown-editor:not(.assembled-editor) .cm-content');
  await expect(content).toBeVisible();
  await expect(mode.getByRole('button', {name: 'Source', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.active-document-pane .markdown-reader')).toBeHidden();
  await expect(page.getByRole('textbox', {name: 'Your drafting question', exact: true})).toBeFocused();
  const selection = await page.evaluate(() => {const v = (window as any).readingFixture.view();return v.state.sliceDoc(v.state.selection.main.from, v.state.selection.main.to);});
  expect(selection).toBe('twice');
  await page.getByRole('complementary', {name: 'Drafting questions', exact: true}).getByRole('button', {name: 'Close questions', exact: true}).click();
  await expect(content).toBeFocused();
  const visible = await page.evaluate(() => {
    const v = (window as any).readingFixture.view(), range = v.state.selection.main;
    const from = v.coordsAtPos(range.from), to = v.coordsAtPos(range.to), box = v.scrollDOM.getBoundingClientRect();
    const rect = from && to && {left:Math.min(from.left,to.left),right:Math.max(from.right,to.right),top:Math.min(from.top,to.top),bottom:Math.max(from.bottom,to.bottom)};
    return {text:v.state.sliceDoc(range.from,range.to),visible:!!rect && rect.left>=0 && rect.right<=innerWidth && rect.top>=Math.max(0,box.top) && rect.bottom<=Math.min(innerHeight,box.bottom),
      hit:!!rect && v.contentDOM.contains(document.elementFromPoint((rect.left+rect.right)/2,(rect.top+rect.bottom)/2)),
      exact:v.state.doc.toString()===(window as any).readingFixture.baseline['harbor.md'].replace(/\r\n|\r/g,'\n')};
  });
  expect(visible).toEqual({text:'twice',visible:true,hit:true,exact:true});
  const prose = await content.evaluate(element => {
    const bounds = element.closest('.cm-scroller')!.getBoundingClientRect(), words = new Set<string>();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      for (const match of (node.textContent ?? '').matchAll(/[A-Za-z]{3,}/g)) {
        const range = document.createRange();range.setStart(node, match.index!);range.setEnd(node, match.index! + match[0].length);
        const rects = [...range.getClientRects()];
        if (rects.length === 1 && rects.every(r => r.top >= Math.max(0,bounds.top) && r.bottom <= Math.min(innerHeight,bounds.bottom) && r.left >= 0 && r.right <= innerWidth && element.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))) words.add(match[0]);
      }
    }
    return {wholeVisibleWords: words.size, fontSize: parseFloat(getComputedStyle(element).fontSize)};
  });
  expect(prose.wholeVisibleWords).toBeGreaterThanOrEqual(3);
  if (high) expect(prose.fontSize).toBeGreaterThanOrEqual(32);
  expect(await page.evaluate(() => JSON.stringify((window as any).readingFixture.docs))).toBe(before);
  expect(await page.evaluate(() => (window as any).readingFixture.calls)).toEqual([]);
  await expect(page.locator('.markdown-editor')).toHaveCount(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(external).toEqual([]);expect(errors).toEqual([]);
  await page.screenshot({path:info.outputPath(`chapter-source-${high?'320-200HC':'desktop'}.png`),fullPage:true});
});
