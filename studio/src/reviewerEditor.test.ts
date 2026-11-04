// @vitest-environment jsdom
import { it, expect, vi } from 'vitest';
import { createReviewerManager } from './reviewerEditor';
import type { CustomReviewer, LocalCore } from './localCore';
const tick = () => new Promise(r => setTimeout(r, 0));
const find = (name: string) => [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? b.textContent) === name)!;
it('creates, duplicates and lists reviewers in the Review agents dialog', async () => {
    document.body.replaceChildren();
    const store: CustomReviewer[] = [];
    const core = {
        listCustomReviewers: vi.fn(async () => store.map(r => ({...r}))),
        saveCustomReviewer: vi.fn(async (r: CustomReviewer) => { const saved = {...r, id: r.id || `custom-${store.length}`}; const i = store.findIndex(x => x.id === saved.id); if (i < 0) store.push(saved); else store[i] = saved; return saved; }),
        deleteCustomReviewer: vi.fn(async (id: string) => { store.splice(store.findIndex(r => r.id === id), 1); return [...store]; }),
    } as unknown as LocalCore;
    const manager = createReviewerManager(core, document.body);
    await manager.open();
    expect(document.body.textContent).toContain('No custom reviewers yet');
    find('+ New reviewer').click(); await tick();
    const select = document.querySelector('.review-agent-editor select') as HTMLSelectElement;
    select.value = '1'; select.dispatchEvent(new Event('change'));
    find('Save reviewer').click(); await tick(); await tick();
    expect(store.map(r => r.displayName)).toEqual(['Explaining what you just wrote']);
    expect(document.querySelector('.review-agents-row')!.textContent).toContain('Explaining what you just wrote');
    find('Duplicate Explaining what you just wrote').click(); await tick(); await tick();
    expect(store).toHaveLength(2);
    expect(store[1].displayName).toBe('Explaining what you just wrote copy');
    find('Return to writing').click();
    expect(manager.isOpen()).toBe(false);
});
