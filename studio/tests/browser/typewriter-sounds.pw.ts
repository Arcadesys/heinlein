import {test, expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
test('kept typewriter choices preview, persist and preserve prose layout', async ({page}, info) => {
  const errors:string[]=[]; page.on('pageerror', error=>errors.push(error.message));
  await page.goto('/tests/browser/fixture.html');
  const editor=page.locator('.cm-content'); await expect(editor).toContainText('Synthetic prose');
  const before=await editor.evaluate(el=>({text:el.textContent,width:el.getBoundingClientRect().width}));
  const open=async()=>{await page.getByRole('button',{name:'More actions'}).click();await page.getByRole('button',{name:'Appearance',exact:false}).click();await page.getByRole('button',{name:'Editor',exact:true}).click();};
  await open();
  const select=page.getByRole('combobox',{name:'Typewriter sound',exact:true});
  await expect(select.locator('option')).toHaveText(['Classic mechanical','Wooden Thock','Analog Blip','Paper & Plastic','8-bit Triangle Wave']);
  await select.selectOption('8-bit-triangle');
  await page.getByRole('button',{name:'Preview typewriter sound',exact:true}).focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('button',{name:'Typewriter sound: off',exact:true}).last()).toHaveAttribute('aria-pressed','false');
  const volume=page.getByRole('slider',{name:'Typewriter volume',exact:true});await expect(volume).toHaveAttribute('max','500');await volume.focus();await page.keyboard.press('End');await expect(volume).toHaveValue('500');await expect(volume).toHaveAttribute('aria-valuetext','500% boosted');await expect(page.locator('.typewriter-volume-value')).toHaveText('500%');
  const decoded=await page.evaluate(async()=>{
    const ctx=new AudioContext(); const durations=[];
    for(const file of ['02_wooden_thock.mp3','07_analog_synth_blip.mp3','08_paper_plastic_tap.mp3','8-bit-triangle-wave.wav']){
      const response=await fetch(`/sounds/sound-sketchbook/${file}`);if(!response.ok)throw Error(file);
      durations.push((await ctx.decodeAudioData(await response.arrayBuffer())).duration);
    } await ctx.close();return durations;
  });
  expect(decoded.every(duration=>duration>0&&duration<1)).toBe(true);
  await select.focus(); await page.keyboard.press('Tab'); await expect(page.getByRole('button',{name:'Preview typewriter sound',exact:true})).toBeFocused();
  const audit=await new AxeBuilder({page}).include('.settings-window').analyze();
  expect(audit.violations.filter(v=>v.impact==='serious'||v.impact==='critical')).toEqual([]);
  expect(await select.evaluate(el=>{const r=el.getBoundingClientRect();return r.height>=44&&r.left>=0&&r.right<=innerWidth;})).toBe(true);
  await page.screenshot({path:info.outputPath('typewriter-settings.png')});
  await page.keyboard.press('Escape');
  expect(await editor.evaluate(el=>({text:el.textContent,width:el.getBoundingClientRect().width}))).toEqual(before);
  await page.reload();await expect(editor).toContainText('Synthetic prose'); await open(); await expect(select).toHaveValue('8-bit-triangle');await expect(volume).toHaveValue('500');
  expect(errors).toEqual([]);
});
