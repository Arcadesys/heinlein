// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNavigationDrawer } from './navigationDrawer';

describe('project navigation drawer', () => {
  beforeEach(() => { localStorage.clear(); document.body.replaceChildren(); vi.unstubAllGlobals(); });
  function setup() {
    const library = document.createElement('section');
    library.innerHTML = '<button>New scene</button><input value="retained">';
    const changed = vi.fn(); const drawer = createNavigationDrawer(library, changed);
    document.body.append(drawer.element);
    const toggle = drawer.element.querySelector<HTMLButtonElement>('.navigation-toggle')!;
    return {drawer, library, toggle, changed};
  }
  function key(node: HTMLElement, key: string) { node.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles: true, cancelable: true})); }
  it('holds one panel with no tabs', () => {
    const {drawer, library} = setup();
    expect(drawer.element.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(document.getElementById('navigation-drawer')!.children).toHaveLength(1);
    expect(library.parentElement!.id).toBe('navigation-drawer'); expect(drawer.visible()).toBe(true);
  });
  it('Escape closes from panel content and restores focus to the single opener, retaining live data', () => {
    const {drawer, library, toggle} = setup(); const input = library.querySelector('input')!; input.value = 'still here';
    const control = library.querySelector('button')!; control.focus(); key(control, 'Escape');
    expect(document.activeElement).toBe(toggle); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('navigation-drawer')!.getAttribute('aria-hidden')).toBe('true');
    expect(document.getElementById('navigation-drawer')!.inert).toBe(true);
    toggle.click(); expect(document.activeElement).toBe(library); expect(drawer.visible()).toBe(true);
    expect(library.querySelector('input')).toBe(input); expect(input.value).toBe('still here');
  });
  it('persists the open state across remounts', () => {
    const {drawer} = setup(); drawer.toggle(); document.body.replaceChildren();
    const next = setup(); expect(next.toggle.getAttribute('aria-expanded')).toBe('false');
    next.drawer.select(); expect(next.drawer.visible()).toBe(true);
  });
  it('migrates the old fully collapsed layout', () => {
    localStorage.setItem('heinlein-studio-collapsed-v1', JSON.stringify({files: true, manuscript: true}));
    const {drawer, toggle} = setup(); expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(drawer.element.querySelectorAll('.panel-toggle')).toHaveLength(0);
  });
  it.each(['{broken', 'null', '[]', '{"open":"yes"}'])('ignores invalid stored state: %s', value => {
    localStorage.setItem('heinlein-studio-navigation-v1', value);
    expect(setup().drawer.visible()).toBe(true);
  });
  it('starts closed on a narrow first launch so the editor stays reachable', () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({matches: true})));
    expect(setup().toggle.getAttribute('aria-expanded')).toBe('false');
  });
  it('suspends the drawer for Questions without changing its saved preference or reopening a narrow modal', () => {
    let small = false; const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({get matches(){return small;},addEventListener: (_event: string, callback: () => void) => listeners.add(callback),removeEventListener: (_event: string, callback: () => void) => listeners.delete(callback)}));
    const {drawer, changed} = setup(); drawer.select(false);
    const saved = localStorage.getItem('heinlein-studio-navigation-v1');
    drawer.suspend(true); expect(drawer.visible()).toBe(false); expect(localStorage.getItem('heinlein-studio-navigation-v1')).toBe(saved);
    expect(changed).toHaveBeenLastCalledWith(true);
    expect(document.getElementById('navigation-drawer')!.hidden).toBe(false);
    expect(document.getElementById('navigation-drawer')!.inert).toBe(true);

    small = true; listeners.forEach(callback => callback()); drawer.suspend(false);
    expect(drawer.visible()).toBe(false); expect(document.querySelector('dialog[open]')).toBeNull();
    expect(localStorage.getItem('heinlein-studio-navigation-v1')).toBe(saved);
    small = false; listeners.forEach(callback => callback()); expect(drawer.visible()).toBe(true); drawer.destroy();
  });
  it('holds its one panel inside the narrow-screen modal', () => {
    vi.stubGlobal('matchMedia', () => ({matches: true, addEventListener() {}, removeEventListener() {}}));
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    const {drawer, library} = setup(); drawer.select(false);
    expect(library.closest('dialog.navigation-modal')).not.toBeNull(); expect(drawer.visible()).toBe(true);
    drawer.destroy();
  });
  it('does not open a modal or steal writer focus when a desktop window narrows', () => {
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    let small=false;const listeners=new Set<()=>void>();
    vi.stubGlobal('matchMedia',()=>({get matches(){return small;},addEventListener:(_event:string,callback:()=>void)=>listeners.add(callback),removeEventListener:(_event:string,callback:()=>void)=>listeners.delete(callback)}));
    const {drawer,toggle}=setup();drawer.select(false);
    const writer=document.createElement('textarea');document.body.append(writer);writer.focus();
    const saved=localStorage.getItem('heinlein-studio-navigation-v1');
    small=true;listeners.forEach(callback=>callback());
    expect(document.activeElement).toBe(writer);expect(drawer.visible()).toBe(false);
    expect(document.querySelector('dialog[open]')).toBeNull();
    expect(localStorage.getItem('heinlein-studio-navigation-v1')).toBe(saved);
    small=false;listeners.forEach(callback=>callback());expect(drawer.visible()).toBe(true);
    small=true;listeners.forEach(callback=>callback());toggle.click();
    expect(drawer.visible()).toBe(true);expect(document.querySelector('dialog[open]')).not.toBeNull();drawer.destroy();
  });
});
