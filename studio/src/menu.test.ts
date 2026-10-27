// @vitest-environment jsdom
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {attachMenu} from './menu';

describe('dropdown menu', () => {
  beforeEach(() => { document.body.replaceChildren(); });
  function setup(run = vi.fn()) {
    const trigger = document.createElement('button'); trigger.textContent = 'Scene'; document.body.append(trigger);
    const menu = attachMenu(trigger, 'Scenes in Chapter 3', () => [
      {label: 'Scenes', heading: true},
      {label: 'Tide tables', run: () => run('one')},
      {label: 'Salt Rooms', current: true, run: () => run('two')},
      {label: 'Locked', disabled: true},
      {label: 'The long way back', run: () => run('three')},
    ]);
    return {trigger, menu, run};
  }
  const items = () => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
  const key = (node: Element, k: string) => node.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true, cancelable: true}));

  it('opens on click, names itself, and focuses the current item with a text cue', () => {
    const {trigger} = setup(); trigger.click();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[role="menu"]')!.getAttribute('aria-label')).toBe('Scenes in Chapter 3');
    expect(document.activeElement).toBe(items()[1]);
    expect(items()[1].textContent).toContain('You are here');
    expect(items()[1].getAttribute('aria-current')).toBe('true');
  });
  it('moves with arrows, skips disabled items, wraps, and supports Home and End', () => {
    const {trigger} = setup(); trigger.click();
    key(document.activeElement!, 'ArrowDown'); expect(document.activeElement).toBe(items()[3]);
    key(document.activeElement!, 'ArrowDown'); expect(document.activeElement).toBe(items()[0]);
    key(document.activeElement!, 'ArrowUp'); expect(document.activeElement).toBe(items()[3]);
    key(document.activeElement!, 'Home'); expect(document.activeElement).toBe(items()[0]);
    key(document.activeElement!, 'End'); expect(document.activeElement).toBe(items()[3]);
  });
  it('runs the chosen item, closes, and does not run disabled items', () => {
    const {trigger, run} = setup(); trigger.click();
    items()[0].click();
    expect(run).toHaveBeenCalledWith('one'); expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    trigger.click(); expect(items().find(item => item.textContent === 'Locked')!.disabled).toBe(true);
  });
  it('closes on Escape and returns focus to the trigger', () => {
    const {trigger} = setup(); trigger.click(); key(document.activeElement!, 'Escape');
    expect(document.querySelector('[role="menu"]')).toBeNull(); expect(document.activeElement).toBe(trigger);
  });
  it('opens with ArrowDown from the trigger and closes on an outside press', () => {
    const {trigger} = setup(); key(trigger, 'ArrowDown');
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    document.body.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
  it('explains an empty menu instead of opening blank', () => {
    const trigger = document.createElement('button'); document.body.append(trigger);
    attachMenu(trigger, 'Chapters', () => []); trigger.click();
    expect(document.querySelector('[role="menu"]')!.textContent).toContain('Nothing to choose yet.');
  });
});
