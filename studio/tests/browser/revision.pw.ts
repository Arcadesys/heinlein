import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const activate = async (locator: import('@playwright/test').Locator) => { await locator.focus(); await locator.page().keyboard.press('Enter'); };
test('prepared conflict choice and two sequential approvals keep unrelated Unicode prose', async ({ page }) => {
    await page.goto('/tests/browser/revision.html');
    const panel = page.getByRole('region', { name: 'Heinlein Review', exact: true });
    await expect(panel).toBeVisible();
    for (let n = 0; n < 5; n++)
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+=' : 'Control+=');
    await expect(page.locator('html')).toHaveAttribute('data-zoom', '200');
    await expect(panel.getByLabel('Number of reviewers', { exact: true })).toHaveValue('1');
    await activate(panel.getByRole('button', { name: 'Preview reviewer batch', exact: true }));
    await expect(panel).toContainText('1 selected calls');
    await activate(panel.getByRole('button', { name: 'Run Heinlein Review', exact: true }));
    await expect(panel.locator('.review-edit')).toHaveCount(3);
    await expect(panel.locator('input[type=radio]:checked')).toHaveCount(0);
    // Check the actual pending diffs at enlarged text, not just an empty result.
    const pendingBounds = await panel.evaluate(e => ({scroll:e.scrollWidth,client:e.clientWidth}));
    expect(pendingBounds.scroll).toBeLessThanOrEqual(pendingBounds.client+1);
    for (const node of await panel.locator('.review-edit pre').all()) { await expect(node).toBeVisible(); }
    const target = await panel.locator('.review-edit button').first().boundingBox();
    expect(target!.height).toBeGreaterThanOrEqual(44);
    expect((await new AxeBuilder({page}).include('.heinlein-review-panel').analyze()).violations).toEqual([]);

    const first = panel.locator('[data-finding-id="first"]');
    await expect(first).toContainText('Captured line 1, column 3');
    await expect(first.getByRole('button', { name: 'Approve…', exact: true })).toBeDisabled();
    const radio = first.getByRole('radio');
    await radio.focus();
    await page.keyboard.press('Space');
    await expect(first.getByRole('button', { name: 'Approve…', exact: true })).toBeEnabled();
    expect(await page.evaluate(() => (window as any).reviewFixture.text)).toBe(await page.evaluate(() => (window as any).reviewFixture.baseline));
    page.once('dialog', d => d.accept());
    await activate(first.getByRole('button', { name: 'Approve…', exact: true }));
    await expect(panel.locator('.review-edit')).toHaveCount(1);
    const last = panel.locator('[data-finding-id="unrelated"]');
    await expect(last.getByRole('button', { name: 'Approve…', exact: true })).toBeEnabled();
    await expect(last.getByRole('button', { name: 'Approve…', exact: true })).toBeFocused();
    page.once('dialog', d => d.accept());
    await activate(last.getByRole('button', { name: 'Approve…', exact: true }));
    await expect(panel.locator('.review-edit')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).reviewFixture.text)).toBe('🐺 good / great / keep — exactly.\r\n');
    const bounds = await panel.evaluate(e => ({ left: e.getBoundingClientRect().left, right: e.getBoundingClientRect().right, viewport: innerWidth, scroll: e.scrollWidth, client: e.clientWidth }));
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    expect((await new AxeBuilder({ page }).include('.heinlein-review-panel').analyze()).violations).toEqual([]);
});
test('rejected findings disappear only from pending and stay dismissed after close and page restart', async ({ page }) => {
    await page.goto('/tests/browser/revision.html');
    const panel = page.getByRole('region', { name: 'Heinlein Review', exact: true });
    await expect(panel).toBeVisible();
    await activate(panel.getByRole('button', { name: 'Preview reviewer batch', exact: true }));
    await activate(panel.getByRole('button', { name: 'Run Heinlein Review', exact: true }));
    await activate(panel.locator('[data-finding-id="unrelated"]').getByRole('button', { name: 'Reject edit', exact: true }));
    await expect(panel.locator('[data-finding-id="unrelated"]')).toHaveCount(0);
    await activate(panel.getByRole('button', { name: 'Close review', exact: true }));
    await page.getByRole('button', { name: 'Heinlein Review', exact: true }).click();
    await activate(panel.getByRole('button', { name: 'Reopen saved review synthetic-review-stable', exact: true }));
    await expect(panel.locator('.review-edit')).toHaveCount(2);
    await page.reload();
    await expect(panel).toBeVisible();
    await activate(panel.getByRole('button', { name: 'Reopen saved review synthetic-review-stable', exact: true }));
    await expect(panel.locator('[data-finding-id="unrelated"]')).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).reviewFixture.calls.filter((c: any) => c.action === 'run').length)).toBe(0);
    await panel.getByText('Versioned review JSON', { exact: true }).click();
    await expect(panel.locator('pre').filter({ hasText: '"status": "rejected"' })).toBeVisible();
    expect((await new AxeBuilder({ page }).include('.heinlein-review-panel').analyze()).violations).toEqual([]);
});
