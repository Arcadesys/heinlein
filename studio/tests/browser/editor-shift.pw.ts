import {test, expect} from '@playwright/test';
for (const zoom of [1, 2]) for (const theme of ['default', 'contrast']) {
  test(`visible writing stays anchored: ${theme}, ${zoom * 100}%`, async ({page}) => {
    await page.goto('/tests/browser/editor-shift.html');
    await page.waitForFunction(() => (window as any).shiftFixture);
    await page.evaluate(async ({zoom, theme}) => {
      document.documentElement.dataset.zoom = String(zoom * 100);
      (window as any).shiftFixture.theme(theme);
      await document.fonts.ready;
      const view = (window as any).shiftFixture.view;
      view.dispatch({selection: {anchor: view.state.doc.line(181).from + 25}, scrollIntoView: true});
      view.focus();
    }, {zoom, theme});
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const {at} = (window as any).shiftFixture.sample();
      let scroller = (window as any).shiftFixture.view.contentDOM.parentElement;
      while (scroller && (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) || scroller.scrollHeight <= scroller.clientHeight)) scroller = scroller.parentElement;
      scroller.scrollTop += (at.top - innerHeight / 2);
    });
    await page.waitForTimeout(200);
    const sample = () => page.evaluate(() => (window as any).shiftFixture.sample());
    const before = await sample();
    expect(before.at.top).toBeGreaterThan(0);
    expect(before.at.bottom).toBeLessThan((await page.viewportSize())!.height);
    const positions = [];
    for (const character of 'extra words ') {
      await page.keyboard.type(character);
      positions.push(await sample());
    }
    await page.waitForTimeout(2200);
    const idle = await sample();
    await page.keyboard.press('ControlOrMeta+s');
    await page.waitForTimeout(300);
    const saved = await sample();
    expect(idle.at).toEqual(positions.at(-1).at);
    expect(saved.at).toEqual(idle.at);
    expect(saved.source).toBe(before.source + 'extra words '.length);
    expect(await page.evaluate(() => {const f = (window as any).shiftFixture; return (window as any).projectFixture.savedText === f.baseline.slice(0, f.insertionOffset) + 'extra words ' + f.baseline.slice(f.insertionOffset);})).toBe(true);
    for (const state of [...positions, idle, saved]) {
      expect(state.anchor.top).toBeCloseTo(before.anchor.top, 0);
      expect(state.width).toBeCloseTo(before.width, 0);
    }
    await page.keyboard.type(' paused', {delay: 200});
    const paused = await sample();
    expect(paused.anchor.top).toBeCloseTo(before.anchor.top, 0);
    await page.waitForTimeout(2200);
    expect((await sample()).at).toEqual(paused.at);
    await page.waitForTimeout(4500); // Include routine notice expiry as well as autosave.
    expect((await sample()).anchor.top).toBeCloseTo(paused.anchor.top, 0);
    // Reflow is deliberate. Once settled, further typing must not change width
    // or move the paragraph when the caret is already comfortably visible.
    await page.setViewportSize({width: page.viewportSize()!.width === 320 ? 900 : 600, height: 900});
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const view = (window as any).shiftFixture.view;
      view.dispatch({selection: view.state.selection, scrollIntoView: true});
    });
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      const {at} = (window as any).shiftFixture.sample();
      let scroller = (window as any).shiftFixture.view.contentDOM.parentElement;
      while (scroller && (!/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) || scroller.scrollHeight <= scroller.clientHeight)) scroller = scroller.parentElement;
      scroller.scrollTop += at.top - innerHeight / 2;
    });
    await page.waitForTimeout(200);
    const reflow = await sample();
    await page.keyboard.type('x');
    const afterReflow = await sample();
    expect(afterReflow.width).toBe(reflow.width);
    expect(afterReflow.anchor.top).toBeCloseTo(reflow.anchor.top, 0);
    await page.keyboard.press('Enter');
    await page.keyboard.type('New fragment — kept.');
    const newline = await sample();
    expect(newline.anchor.top).toBeCloseTo(reflow.anchor.top, 0);
    await page.waitForTimeout(2200);
    expect((await sample()).at).toEqual(newline.at);
  });
}

for (const zoom of [100, 200]) {
  test(`notice slot stays readable and stable at ${zoom}%`, async ({page}, info) => {
    await page.goto('/tests/browser/editor-shift.html');
    await page.waitForFunction(() => (window as any).shiftFixture);
    await page.evaluate(async zoom => {
      document.documentElement.dataset.zoom = String(zoom);
      (window as any).shiftFixture.theme('contrast');
      await document.fonts.ready;
      const view = (window as any).shiftFixture.view;
      view.dispatch({selection: {anchor: view.state.doc.line(181).from + 25}, scrollIntoView: true});
      view.focus();
    }, zoom);
    await page.waitForTimeout(300);
    const anchor = () => page.evaluate(() => (window as any).shiftFixture.sample().anchor.top);
    const before = await anchor();
    const status = page.locator('.studio > .status');
    for (const text of ['', 'Saved scene.md locally', 'Synthetic multiline notice. '.repeat(80) + 'END OF NOTICE']) {
      await status.evaluate((el, text) => {el.textContent = text;}, text);
      await page.waitForTimeout(100);
      expect(await anchor()).toBeCloseTo(before, 0);
    }
    const box = await status.boundingBox();
    expect(box!.height).toBe(zoom / 100 * 64);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(await status.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    const nav = await page.locator('.navigator').boundingBox();
    expect(box!.y + box!.height).toBeLessThanOrEqual(nav!.y);
    const preview = (await page.locator('.preview').boundingBox())!.y;
    expect(box!.y + box!.height).toBeLessThanOrEqual(preview);
    await status.focus();
    await expect(status).toBeFocused();
    await page.keyboard.press('End');
    await expect.poll(() => status.evaluate(el => el.scrollTop)).toBeGreaterThan(0);
    await expect(status).toContainText('END OF NOTICE');
    await expect.poll(() => status.evaluate(el => {const text=el.firstChild!;const range=document.createRange();range.setStart(text, text.textContent!.length - 13);range.setEnd(text,text.textContent!.length);const end=range.getBoundingClientRect(),box=el.getBoundingClientRect();return end.top >= box.top && end.bottom <= box.bottom;})).toBe(true);
    await page.waitForTimeout(4500);
    expect(await status.evaluate(el => getComputedStyle(el).opacity)).toBe('1');
    expect((await status.boundingBox())!.height).toBe(box!.height);
    await status.evaluate(el => el.classList.add('error'));
    await expect(status).toBeVisible();
    await page.screenshot({path: info.outputPath('synthetic-long-notice.png')});
  });
}
