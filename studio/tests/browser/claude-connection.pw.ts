import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
for (const zoom of [100, 200]) {
  test(`the Claude card is readable, reachable and leaves the manuscript in place at ${zoom}%`, async ({page}, info) => {
    await page.goto('/tests/browser/questions.html?claude');
    await page.evaluate(zoom => {document.documentElement.dataset.zoom = String(zoom);}, zoom);
    const editor = page.locator('.cm-content');
    await expect(editor).toBeVisible();
    const geometry = () => editor.evaluate(el => {const r = el.getBoundingClientRect(); return {left: r.left, width: r.width, height: r.height};});
    const before = await geometry();
    await page.keyboard.press('Control+j');
    const pane = page.locator('.question-panel.heinlein-pane');
    await pane.locator('.question-settings-toggle').click();
    await pane.getByText('Account & model', {exact: true}).click();
    const choice = pane.getByRole('group', {name: 'Answer with'});
    await expect(choice).toBeVisible();
    await expect(choice.getByRole('radio', {name: /Claude/})).toBeChecked();
    await expect(choice.getByRole('radio', {name: /ChatGPT/})).not.toBeChecked();
    const card = pane.getByRole('region', {name: 'Claude connection'});
    await expect(card).toContainText('Key saved · ends in 1a2b');
    await expect(card.getByLabel('Anthropic API key')).toHaveAttribute('type', 'password');
    await expect(card.getByRole('combobox', {name: 'Claude model'})).toHaveValue('claude-opus-5-5');
    // ChatGPT plan controls are not offered while Claude answers.
    await expect(pane.getByRole('checkbox', {name: 'Allow Heinlein to use my ChatGPT plan'})).toBeHidden();
    for (const target of [...await choice.locator('label').all(), ...await card.locator('button:visible, input:visible, select:visible').all()]) {
      expect((await target.boundingBox())!.height, await target.evaluate(el => el.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(44);
    }
    expect(await pane.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    expect(await geometry()).toEqual(before);
    const report = await new AxeBuilder({page}).include('.question-panel').analyze();
    expect(report.violations.filter(v => v.impact === 'critical' || v.impact === 'serious')).toEqual([]);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({path: info.outputPath(`claude-card-${zoom}.png`)});
  });
}
