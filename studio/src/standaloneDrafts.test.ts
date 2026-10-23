// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { createStandaloneDrafts, DRAFT_MAX_WAIT } from './standaloneDrafts';
import { syntheticDraftBridge } from '../tests/standaloneBridge';
beforeEach(() => { Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }); });
const apps: ReturnType<typeof createStandaloneDrafts>[] = [];
afterEach(() => { apps.splice(0).forEach(a => a.destroy()); document.body.replaceChildren(); vi.useRealTimers(); vi.restoreAllMocks(); });
const settle = async () => {
    for (let i = 0; i < 30; i++)
        await Promise.resolve();
};
function setup(bridge = syntheticDraftBridge(), leave?:()=>Promise<boolean>) {
    const root = document.createElement('div'), parent = document.createElement('section');
    root.append(parent);
    document.body.append(root);
    let app: ReturnType<typeof createStandaloneDrafts>;
    let sync = Promise.resolve();
    app = createStandaloneDrafts(bridge.core, { root, parent, dirty: v => { sync = sync.then(() => bridge.core.setUnsavedChanges(v)); }, sync: () => sync, leave: leave??(()=>app.flush()), openCopy: vi.fn() });
    apps.push(app);
    app.mount();
    const view = () => EditorView.findFromDOM(parent.querySelector('.cm-editor')!)!;
    const type = (text: string) => view().dispatch({ changes: { from: view().state.doc.length, insert: text } });
    const button = (text: string) => [...root.querySelectorAll('button')].find(b => b.textContent === text)!;
    return { app, bridge, parent, root, view, type, button };
}
describe('standalone preservation', () => {
    it('starts blank with no identity/destination/provider calls; saves exact Unicode and reopens independently', async () => {
        const x = setup();
        expect(x.view().state.doc.toString()).toBe('');
        expect(x.bridge.calls).toEqual([]);
        x.type('🐺 e\u0301 — story\nend  ');
        await x.app.flush();
        expect(x.bridge.dirty).toBe(false);
        const d = [...x.bridge.records.values()][0];
        expect(d.text).toBe(x.app.text);
        expect(x.bridge.calls.map(c => c.kind)).toEqual(['create', 'save']);
        x.app.destroy();
        const y = setup(syntheticDraftBridge([d]));
        await y.app.start();
        expect(y.app.text).toBe(d.text);
        expect(y.bridge.calls.map(c => c.kind)).toEqual(['list', 'open']);
    });
    it('a delayed save cannot clear newer typing; close waits for both exact snapshots', async () => {
        const x = setup();
        x.type('first');
        await x.app.flush();
        let resume!: () => void;
        x.bridge.holdNextSave(r => resume = r);
        x.type(' — second');
        const flushing = x.app.flush();
        await settle();
        x.type(' 🐺 third');
        expect(x.bridge.dirty).toBe(true);
        resume();
        expect(await flushing).toBe(true);
        expect([...x.bridge.records.values()][0].text).toBe('first — second 🐺 third');
        expect(x.bridge.dirty).toBe(false);
    });
    it('storage failure refuses leave and retry preserves latest buffer', async () => {
        const x = setup();
        x.type('never discard');
        x.bridge.failNextSave();
        expect(await x.app.flush()).toBe(false);
        expect(x.bridge.dirty).toBe(true);
        expect(x.root.textContent).toContain('Not kept yet');
        x.type(' — newer');
        expect(await x.app.flush()).toBe(true);
        expect([...x.bridge.records.values()][0].text).toBe('never discard — newer');
    });
    it('continuous typing reaches a durable generation at max wait', async () => {
        vi.useFakeTimers();
        const x = setup();
        for (let i = 0; i < 12; i++) {
            x.type('a');
            await vi.advanceTimersByTimeAsync(450);
        }
        await settle();
        expect(x.bridge.calls.some(c => c.kind === 'save')).toBe(true);
        expect(DRAFT_MAX_WAIT).toBe(5000);
    });
    it('discard cancel leaves active; confirmed tombstone survives controller restart and explicit Restore', async () => {
        const x = setup();
        x.type('restorable — text');
        await x.app.flush();
        const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
        x.button('Remove draft…').click();
        await settle();
        expect([...x.bridge.records.values()][0].state).toBe('active');
        confirm.mockReturnValue(true);
        x.button('Remove draft…').click();
        await settle();
        const d = [...x.bridge.records.values()][0];
        expect(d.state).toBe('discarded');
        expect(x.app.text).toBe('');
        x.app.destroy();
        const y = setup(syntheticDraftBridge([d]));
        await y.app.list();
        const row = [...y.root.querySelectorAll('button')].find(b => b.textContent?.includes('restorable'))!;
        row.click();
        await settle();
        expect(y.root.textContent).toContain('Restore draft');
        y.button('Restore draft').click();
        await settle();
        expect(y.app.text).toBe(d.text);
        expect([...y.bridge.records.values()][0].state).toBe('active');
    });
    it('changing placement settings while preview is pending discards stale authority', async () => {
        const x = setup();
        x.type('exact');
        await x.app.flush();
        x.button('Choose a destination…').click();
        await settle();
        let resume!: () => void;
        x.bridge.holdNextPreview(r => resume = r);
        x.button('Choose location and preview…').click();
        await settle();
        const input = x.root.querySelector('input')!;
        input.value = 'new.md';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        resume();
        await settle();
        expect(x.root.textContent).toContain('draft changed');
        expect(x.button('Place copy…')).toBeUndefined();
        expect(x.bridge.calls.some(c => c.kind === 'cancelPreview')).toBe(true);
    });
    it('listed drafts cannot bypass the inactive standalone host leave guard',async()=>{
      const leave=vi.fn(async()=>false);const x=setup(undefined,leave);x.type('saved standalone');await x.app.flush();x.app.detach();const project=document.createElement('pre');project.textContent='UNSAVED project — exact';x.parent.replaceChildren(project);
      await x.app.list();[...x.root.querySelectorAll('dialog button')].find(b=>b.textContent?.includes('saved standalone'))!.dispatchEvent(new MouseEvent('click',{bubbles:true}));await settle();
      expect(leave).toHaveBeenCalledOnce();expect(project.isConnected).toBe(true);expect(x.parent.textContent).toBe('UNSAVED project — exact');expect(x.bridge.calls.filter(c=>c.kind==='open')).toHaveLength(0);
    });

    it('cancelling Drafts during a pending host leave never opens a late draft',async()=>{
      let finish!:(ok:boolean)=>void;const x=setup(undefined,()=>new Promise<boolean>(resolve=>finish=resolve));x.type('saved standalone');await x.app.flush();x.app.detach();const project=document.createElement('pre');project.textContent='project buffer';x.parent.replaceChildren(project);await x.app.list();[...x.root.querySelectorAll('dialog button')].find(b=>b.textContent?.includes('saved standalone'))!.dispatchEvent(new MouseEvent('click',{bubbles:true}));await settle();x.button('Back to writing').click();finish(true);await settle();expect(project.isConnected).toBe(true);expect(x.bridge.calls.filter(c=>c.kind==='open')).toHaveLength(0);
    });

});
