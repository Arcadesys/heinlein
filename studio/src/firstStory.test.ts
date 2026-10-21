// @vitest-environment jsdom
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {createFirstStory, emptyFirstStory, invalidateFirstStory, type FirstStoryState, type PublishingCopy} from './firstStory';
import type {LocalCore} from './localCore';
let controllers: ReturnType<typeof createFirstStory>[] = [];
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  HTMLDialogElement.prototype.showModal = function() {this.setAttribute('open', '');};
  HTMLDialogElement.prototype.close = function() {this.removeAttribute('open'); this.dispatchEvent(new Event('close'));};
});
afterEach(() => {controllers.forEach(c => c.destroy()); controllers = []; document.body.replaceChildren();});
const tick = async () => {await new Promise(resolve => setTimeout(resolve, 0));};
function fixture(initial = emptyFirstStory()) {
  let stored = structuredClone(initial); let selected: {id: string; name: string; manifests: string[]} | null = {id: 'project', name: 'Synthetic', manifests: []}; let problem: string | null = null;
  const preview: PublishingCopy = {destination:'copies / new-copy', preview:{id:'opaque-plan',sourceRevision:'source',manifestRevision:'manifest',sources:[{id:'first',title:'First',path:'ms/z.md',contentHash:'hash',sizeBytes:5}],manuscript:'Exact source.',config:'{}',treatment:'No source changes.',folderName:'new-copy'}};
  const core = {loadFirstStory:vi.fn(async () => structuredClone(stored)),saveFirstStory:vi.fn(async (_id: string, state: FirstStoryState, proof: boolean) => {stored = structuredClone(state); stored.revision = String(Number(stored.revision) + 1); if (proof) {stored.proofRevision = 'source';stored.steps[4] = 'done';} return structuredClone(stored);}),resetFirstStory:vi.fn(async () => null as FirstStoryState | null),previewPublishingCopy:vi.fn(async () => preview as PublishingCopy | null),confirmPublishingCopy:vi.fn(async () => false)} as unknown as LocalCore;
  const hooks = {session:() => selected,problem:() => problem,settle:vi.fn(async () => {}),openFolder:vi.fn(async () => {selected = {id:'new-project',name:'New',manifests:[]};}),draft:vi.fn(async () => {}),review:vi.fn()};
  const c = createFirstStory(core, hooks); controllers.push(c);document.body.append(c.element);
  const click = async (label: string) => {const b = [...c.element.querySelectorAll('button')].find(b => b.textContent === label); expect(b, label).toBeDefined(); b!.click();await tick();};
  return {c,core,hooks,click,stored:() => stored,setProblem:(p: string | null) => problem = p,noFolder:() => selected = null};
}
it('new writer can choose a folder and opt in before any manuscript exists', async () => {
  const f = fixture(); f.noFolder();await f.c.open();expect(f.c.element.textContent).toContain('Start with a place for your story');
  await f.click('Open a story folder…');expect(f.hooks.openFolder).toHaveBeenCalledOnce();
  expect(f.c.element.textContent).toContain('Start my story guide');expect(f.core.saveFirstStory).not.toHaveBeenCalled();
  await f.click('Start my story guide');expect(f.stored().enabled).toBe(true);expect(f.c.element.querySelectorAll('label input')).toHaveLength(4);
});
it('notes persist and reopen; stage navigation and skip require explicit author choice', async () => {
  const state = emptyFirstStory();state.enabled = true;const f = fixture(state);await f.c.open();
  const input = f.c.element.querySelector<HTMLInputElement>('label input')!;input.value = 'A messenger';input.dispatchEvent(new Event('input'));
  await f.click('Save idea and continue');expect(f.stored().idea[0]).toBe('A messenger');expect(f.stored().stage).toBe(1);
  await f.click('Skip this stage…');expect(f.stored().stage).toBe(1);await f.click('Keep this stage');expect(f.stored().steps[1]).toBe('todo');
  await f.click('Skip this stage…');await f.click('Skip this stage');expect(f.stored().steps[1]).toBe('skipped');
  await f.click('Close guide');await f.c.open();expect(f.c.element.textContent).toContain('3. Draft to an ending');
  expect(f.hooks.review).not.toHaveBeenCalled();await f.click('Open drafting');expect(f.hooks.draft).toHaveBeenCalledOnce();
});
it('reset cancellation preserves progress and malformed load offers explicit reset', async () => {
  const state=emptyFirstStory();state.enabled=true;state.idea[0]='Keep';const f=fixture(state);await f.c.open();await f.click('Reset guide…');expect(f.stored().idea[0]).toBe('Keep');
  vi.mocked(f.core.loadFirstStory!).mockRejectedValueOnce(new Error('Malformed guide; story unchanged'));await f.c.open();expect(f.c.element.textContent).toContain('Malformed guide');expect(f.c.element.textContent).toContain('Reset guide…');
});
it('source edits visibly invalidate proof and publishing checks, not earlier progress', async () => {
  const s=emptyFirstStory();s.enabled=true;s.stage=4;s.steps.fill('done');s.proofRevision='old';s.releaseChecks.fill(true);const f=fixture(s);await f.c.open();f.c.sourceChanged();
  expect(f.c.element.textContent).toContain('Story changed. Proof and release checks need a new saved revision.');await f.click('Save guide progress');expect(f.stored().proofRevision).toBeNull();expect(f.stored().steps[4]).toBe('todo');expect(f.stored().steps[0]).toBe('done');
  f.setProblem('Save your story first');await f.click('Mark this saved revision proofread');expect(f.c.element.textContent).toContain('Save your story first');expect(f.stored().proofRevision).toBeNull();
});
it('copy preview, cancellation, changed metadata and native confirmation remain separate', async () => {
  const s=emptyFirstStory();s.enabled=true;s.stage=5;const f=fixture(s);await f.c.open();
  await f.click('Preview publishing copy…');expect(f.core.confirmPublishingCopy).not.toHaveBeenCalled();await f.click('Cancel copy preview');expect(f.c.element.textContent).toContain('No publishing files written');
  await f.click('Preview publishing copy…');const title=f.c.element.querySelector<HTMLInputElement>('label input')!;title.value='Changed title';title.dispatchEvent(new Event('input'));expect(f.c.element.querySelector('[aria-label="Publishing copy preview"]')).toBeNull();
  await f.click('Preview publishing copy…');await f.click('Create this new copy…');expect(f.core.confirmPublishingCopy).toHaveBeenCalledWith('project','opaque-plan');expect(f.c.element.textContent).toContain('Creation canceled');
  vi.mocked(f.core.confirmPublishingCopy!).mockResolvedValueOnce(true);await f.click('Preview publishing copy…');await f.click('Create this new copy…');expect(f.c.element.textContent).toContain('heinlein build');expect(f.c.element.textContent).toContain('No files have been shared');
});
it('pure invalidation keeps notes and intentional skips', () => {const s=emptyFirstStory();s.steps[4]='skipped';s.plan='Keep my plan';invalidateFirstStory(s);expect(s.steps[4]).toBe('skipped');expect(s.plan).toBe('Keep my plan');});
