// @vitest-environment jsdom
import {afterEach, expect, it} from 'vitest';
import {createReviewActivity} from './reviewActivity';
afterEach(()=>document.body.replaceChildren());
function setup(){const opened:string[]=[];const activity=createReviewActivity(()=>opened.push('open'));document.body.append(activity.element);return {activity,opened};}
it('shows a radial with real call progress while the review is hidden',()=>{
 const {activity}=setup();activity.setVisible(true);activity.start('one','Scene one',4);expect(activity.element.hidden).toBe(true);
 activity.setVisible(false);activity.progress('one',2,4);
 const ring=activity.element.querySelector('[role=progressbar]')!;expect(ring.getAttribute('aria-valuenow')).toBe('2');expect(ring.getAttribute('aria-valuemax')).toBe('4');
 expect(activity.element.textContent).toContain('Review in progress');expect(activity.element.textContent).toContain('2 of 4 calls completed');
 activity.progress('one',1,4);expect(ring.getAttribute('aria-valuenow')).toBe('2');
});
it('announces completion without taking focus and leaves a way to reopen after dismissal',()=>{
 const {activity,opened}=setup();const writer=document.createElement('textarea');document.body.append(writer);writer.focus();
 activity.start('one','Scene one',1);activity.finish('one','complete','Review complete. Three suggestions ready.');
 expect(document.activeElement).toBe(writer);expect(activity.element.querySelector('[role=status]')!.textContent).toContain('Review complete.');
 expect(activity.element.querySelector<HTMLElement>('.review-completion-toast')!.hidden).toBe(false);
 const buttons=[...activity.element.querySelectorAll('button')];buttons.find(b=>b.getAttribute('aria-label')==='Dismiss notification')!.click();
 expect(activity.element.querySelector<HTMLElement>('.review-completion-toast')!.hidden).toBe(true);expect(activity.element.hidden).toBe(false);
 buttons[0].click();expect(opened).toEqual(['open']);
});
it('ignores a late completion from an earlier review',()=>{
 const {activity}=setup();activity.start('one','Old scene',1);activity.start('two','New scene',2);activity.finish('one','complete','Old result');
 expect(activity.element.textContent).not.toContain('Old result');expect(activity.element.querySelector('button')!.dataset.reviewState).toBe('running');
});
it('keeps incomplete or failed reviews distinct from success',()=>{
 const {activity}=setup();activity.start('one','Scene one',3);activity.finish('one','attention','Review incomplete. 1 of 3 calls completed.');
 expect(activity.element.textContent).toContain('Review needs attention');expect(activity.element.textContent).not.toContain('Review ready');
});
it('clears activity on cancellation or disposal without reporting completion',()=>{
 const {activity}=setup();activity.start('one','Scene one',1);activity.cancel('one');expect(activity.element.hidden).toBe(true);
 activity.finish('one','complete','Late result');expect(activity.element.hidden).toBe(true);activity.destroy();expect(document.querySelector('.review-background')).toBeNull();
});
it('acknowledges the toast when the review is opened',()=>{
 const {activity}=setup();activity.start('one','Scene one',1);activity.finish('one','complete','Review complete.');activity.setVisible(true);activity.setVisible(false);
 expect(activity.element.querySelector<HTMLElement>('.review-completion-toast')!.hidden).toBe(true);
});
