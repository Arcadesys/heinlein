// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNavigationDrawer } from './navigationDrawer';
import { REPOSITORY_DRAG_TYPE, SCENE_DRAG_TYPE } from './draftingPanel';

describe('unified navigation drawer', () => {
  beforeEach(() => { localStorage.clear(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
  function setup() {
    const files = document.createElement('section'); const manuscript = document.createElement('section');
    files.innerHTML = '<button>Open folder</button><input value="retained">';
    manuscript.innerHTML = '<button>New scene</button>';
    const scenes = document.createElement('section'); scenes.textContent = 'Scene passages';
    const changed = vi.fn(); const drawer = createNavigationDrawer(files, manuscript, scenes, changed);
    document.body.append(drawer.element);
    const tabs = ['files', 'manuscript', 'scenes'].map(key => drawer.element.querySelector<HTMLButtonElement>(`#navigation-tab-${key}`)!);
    const toggle = drawer.element.querySelector<HTMLButtonElement>('.navigation-toggle')!;
    return {drawer, files, manuscript, scenes, tabs, toggle, changed};
  }
  function key(node: HTMLElement, key: string) { node.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})); }
  it('shows exactly one named panel and one keyboard tab stop', () => {
    const {files, manuscript, tabs} = setup();
    expect(files.hidden).toBe(false); expect(manuscript.hidden).toBe(true);
    expect(tabs.map(tab => tab.tabIndex)).toEqual([0, -1, -1]);
    for (const tab of tabs) {
      const panel = document.getElementById(tab.getAttribute('aria-controls')!)!;
      expect(panel.getAttribute('role')).toBe('tabpanel'); expect(panel.getAttribute('aria-labelledby')).toBe(tab.id);
    }
  });
  it('switches with clicks, arrows, Home and End while retaining live data', () => {
    const {files, manuscript, tabs} = setup(); const input = files.querySelector('input')!; input.value = 'still here';
    tabs[1].click(); expect(manuscript.hidden).toBe(false); expect(files.hidden).toBe(true);
    expect(document.activeElement).toBe(tabs[1]);
    key(tabs[1], 'ArrowRight'); expect(document.activeElement).toBe(tabs[2]);
    key(tabs[2], 'ArrowRight'); expect(document.activeElement).toBe(tabs[0]);
    key(tabs[0], 'ArrowLeft'); expect(document.activeElement).toBe(tabs[2]);
    key(tabs[2], 'Home'); expect(document.activeElement).toBe(tabs[1]);
    key(tabs[1], 'End'); expect(document.activeElement).toBe(tabs[0]);
    tabs[0].click(); expect(files.querySelector('input')).toBe(input); expect(input.value).toBe('still here');
  });
  it('Escape closes from panel content and restores focus to the single opener', () => {
    const {drawer, manuscript, toggle, tabs} = setup(); drawer.select('manuscript');
    const control = manuscript.querySelector('button')!; control.focus(); key(control, 'Escape');
    expect(document.activeElement).toBe(toggle); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('navigation-drawer')!.hidden).toBe(true);
    toggle.click(); expect(document.activeElement).toBe(tabs[1]); expect(drawer.visible('manuscript')).toBe(true);
  });
  it.each([REPOSITORY_DRAG_TYPE, SCENE_DRAG_TYPE])('reveals existing drop targets for internal drags: %s', type => {
    const {files, manuscript, tabs} = setup();
    const event = new Event('dragover', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'dataTransfer', {value: {types: [type], dropEffect: 'none'}});
    tabs[1].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true); expect(manuscript.hidden).toBe(false); expect(files.hidden).toBe(true);
    expect(manuscript.querySelector('button')!.textContent).toBe('New scene');
  });
  it('does not switch panels or accept arbitrary external drops', () => {
    const {files, manuscript, tabs} = setup();
    const event = new Event('dragover', {bubbles: true, cancelable: true});
    Object.defineProperty(event, 'dataTransfer', {value: {types: ['Files'], dropEffect: 'none'}});
    tabs[1].dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false); expect(manuscript.hidden).toBe(true); expect(files.hidden).toBe(false);
  });
  it('persists one open state and the selected tab across remounts', () => {
    const {drawer} = setup(); drawer.select('manuscript'); drawer.toggle(); document.body.replaceChildren();
    const next = setup(); expect(next.toggle.getAttribute('aria-expanded')).toBe('false');
    next.toggle.click(); expect(next.drawer.visible('manuscript')).toBe(true);
  });
  it('migrates the old fully collapsed layout without restoring broken vertical rails', () => {
    localStorage.setItem('heinlein-studio-collapsed-v1', JSON.stringify({files: true, manuscript: true}));
    const {drawer, toggle} = setup(); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.element.querySelectorAll('.panel-toggle')).toHaveLength(0);
  });
  it('migrates the old manuscript-only state', () => {
    localStorage.setItem('heinlein-studio-collapsed-v1', JSON.stringify({files: true, manuscript: false}));
    expect(setup().drawer.visible('manuscript')).toBe(true);
  });
  it.each(['{broken', 'null', '[]', '{"open":true,"active":"unknown"}'])('ignores invalid stored state: %s', value => {
    localStorage.setItem('heinlein-studio-navigation-v1', value);
    expect(setup().drawer.visible('files')).toBe(true);
  });
  it('starts closed on a narrow first launch so the editor stays reachable', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true})));
    expect(setup().toggle.getAttribute('aria-expanded')).toBe('false');
  });
});
