import {expect,type Page} from '@playwright/test';
export async function openHeinleinReview(page:Page) {
 await page.getByRole('button',{name:/^Heinlein(?: ·.*)?$/}).click();
 const review=page.getByRole('dialog',{name:'Heinlein Review',exact:true});
 if(!await review.isVisible())await page.locator('.question-panel').getByRole('button',{name:'Whole scene',exact:true}).click();
 await expect(review).toBeVisible();
}
