import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test('review agents can be created by keyboard and reopened at enlarged text without touching the manuscript', async ({page}, info) => {
  await page.goto('/tests/browser/library-app.html?reviewers');
  await page.getByRole('button',{name:'More actions'}).click();
  await page.getByRole('button',{name:/^Appearance/}).click();
  await page.getByRole('button',{name:'High contrast',exact:true}).click(); await page.keyboard.press('Escape');
  await page.evaluate(()=>{document.documentElement.style.fontSize='200%';});
  const open = async () => {await page.getByRole('button',{name:'More actions'}).click();await page.getByRole('button',{name:'Review agents…',exact:true}).click();};
  await open();
  const dialog=page.getByRole('dialog',{name:'Review agents',exact:true});
  await dialog.getByRole('button',{name:'+ New reviewer',exact:true}).click();
  await dialog.getByRole('combobox',{name:'Start from',exact:true}).selectOption({label:'Emotional punch'});
  await expect(dialog.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('Emotional punch');
  await dialog.getByRole('combobox',{name:'Start from',exact:true}).selectOption({label:'Blank'});
  await expect(dialog.getByRole('textbox',{name:'Name',exact:true})).toHaveValue('');
  await dialog.getByRole('textbox',{name:'Name',exact:true}).fill('Beta reader focus');
  await dialog.getByRole('textbox',{name:'What to look for, in plain language',exact:true}).fill('Find emotional turns that need more room.');
  expect((await new AxeBuilder({page}).include('.review-agents-dialog').analyze()).violations).toEqual([]);
  expect(await dialog.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(false);
  const save=dialog.getByRole('button',{name:'Save reviewer',exact:true});await save.focus();await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button',{name:'Edit Beta reader focus',exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('review-agents-200.png')});
  await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
  await page.reload();await open();
  await expect(dialog.getByRole('button',{name:'Edit Beta reader focus',exact:true})).toBeVisible();
  await expect(dialog).toContainText('notes only');
});
