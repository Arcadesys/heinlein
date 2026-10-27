// @vitest-environment jsdom
import {describe, expect, it, vi} from 'vitest';
import {createBinderTree} from './binderTree';
import type {DraftingState} from './localCore';

const state = (): DraftingState => ({manifestPath: 'ms/manuscript.json', revision: 'r', project: 'Novel', untrackedPaths: [], missingPaths: [],
  groups: [{id: 'g1', title: 'Arrivals'}, {id: 'g2', title: 'The Harbor'}],
  scenes: [{id: 's1', title: 'Opening', path: 'ms/a.md', groupId: 'g1'}, {id: 's2', title: 'Tide tables', path: 'ms/b.md', groupId: 'g2'},
    {id: 's3', title: 'Salt Rooms', path: 'ms/c.md', groupId: 'g2'}, {id: 's4', title: '', path: 'ms/loose.md', groupId: null}]});

describe('binder tree', () => {
  function setup(current: string | null, value: DraftingState | null = state()) {
    const open = vi.fn(); let path = current;
    const tree = createBinderTree({state: () => value, currentPath: () => path, open});
    document.body.replaceChildren(tree.element); tree.refresh();
    return {tree, open, move: (next: string | null) => { path = next; tree.refresh(); }};
  }
  const toggles = () => [...document.querySelectorAll<HTMLButtonElement>('.binder-chapter-toggle')];

  it('expands only the current chapter and marks the current scene with text', () => {
    setup('ms/c.md');
    expect(toggles().map(t => t.getAttribute('aria-expanded'))).toEqual(['false', 'true', 'false']);
    const here = document.querySelector<HTMLButtonElement>('[aria-current="true"]')!;
    expect(here.textContent).toContain('Salt Rooms'); expect(here.textContent).toContain('You are here');
  });
  it('opens a scene when chosen and lists scenes without a chapter', () => {
    const {open} = setup('ms/loose.md');
    expect(toggles().map(t => t.querySelector('.binder-title')!.textContent)).toEqual(['Arrivals', 'The Harbor', 'No chapter']);
    document.querySelector<HTMLButtonElement>('.binder-scene')!.click();
    expect(open).toHaveBeenCalledWith('ms/loose.md');
  });
  it('lets the author collapse the current chapter and expand another', () => {
    setup('ms/c.md'); toggles()[1].click();
    expect(toggles()[1].getAttribute('aria-expanded')).toBe('false');
    toggles()[0].click(); expect(toggles()[0].getAttribute('aria-expanded')).toBe('true');
    expect(toggles()[0].textContent).toContain('1 scene');
  });
  it('follows the author into another chapter once', () => {
    const {move} = setup('ms/a.md'); expect(toggles()[0].getAttribute('aria-expanded')).toBe('true');
    move('ms/b.md'); expect(toggles()[1].getAttribute('aria-expanded')).toBe('true');
  });
  it('opens the first chapter with scenes when nothing is open', () => {
    setup(null); expect(toggles().map(t => t.getAttribute('aria-expanded'))).toEqual(['true', 'false', 'false']);
  });
  it('hides itself with no manuscript', () => {
    setup(null, null); expect(document.querySelector<HTMLElement>('.binder-tree')!.hidden).toBe(true);
  });
});
