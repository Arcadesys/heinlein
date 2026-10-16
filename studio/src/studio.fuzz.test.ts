// @vitest-environment jsdom
import {afterAll, afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EditorView} from '@codemirror/view';
import {Transaction} from '@codemirror/state';
import {isolateHistory, undo, redo} from '@codemirror/commands';
import {AUTOSAVE_DELAY_MS, mountStudio} from './studio';
import type {Document, LocalCore, RecoveryDraft, RepositorySession} from './localCore';
import {campaign, coverageCounter, normalize, positions, seeded, textAtoms} from './testing/seeded';

const session: RepositorySession = {id: 'synthetic-session', projectKey: 'synthetic-project', name: 'Synthetic campaign', manifests: []};
const settings = campaign('STUDIO', 8, 100);
const totals = coverageCounter();
afterAll(() => {console.info('STUDIO_FUZZ_COVERAGE', JSON.stringify({...settings, operations: totals.counts}));});
const flush = async () => {for (let n = 0; n < 40; n++) await Promise.resolve();};
const doc = (path: string, text: string, revision = 0): Document => ({path, text, contentHash: `revision-${revision}`, frontmatter: null, generatedCompatibility: false, sizeBytes: new TextEncoder().encode(text).length});
const button = (label: string) => {
  const found = [...document.querySelectorAll('button')].find(control => control.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
};
const view = () => EditorView.findFromDOM(document.querySelector('.cm-editor') as HTMLElement)!;
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
type Kind = 'stage' | 'save' | 'discard';
type Pending = {id: number; kind: Kind; path: string; text?: string; finish: (fail?: boolean) => void};
function host() {
  let revision = 0; let next = 0; let close = () => {};
  const files = new Map<string, Document>([['scene.md', doc('scene.md', '---\r\nunknown: 🐺\n---\rStart — here.\r\n')], ['other.md', doc('other.md', 'Other\nscene')]]);
  const recoveries = new Map<string, RecoveryDraft>();
  const pending: Pending[] = [];
  const staged: string[] = [];
  const trace: string[] = [];
  const completionCounts = {stage: 0, save: 0, discard: 0, errors: 0};
  const enqueue = <T>(kind: Kind, path: string, text: string | undefined, commit: () => T) => {
    const wait = deferred<T>(); const id = ++next;
    totals.record(`${kind}Requested`);
    trace.push(`request ${id} ${kind} ${JSON.stringify(text)}`);
    pending.push({id, kind, path, text, finish: (fail = false) => {
      pending.splice(pending.findIndex(item => item.id === id), 1);
      trace.push(`complete ${id} ${kind}${fail ? ' ERROR' : ''}`);
      if (fail) {totals.record(`${kind}Failure`); completionCounts.errors++; wait.reject(new Error(`Synthetic ${kind} I/O failure`)); return;}
      try {const result = commit(); totals.record(`${kind}Success`); completionCounts[kind]++; wait.resolve(result);} catch (error) {totals.record(`${kind}GuardRejected`); wait.reject(error);}
    }});
    return wait.promise;
  };
  const core: LocalCore = {
    available: () => true,
    pickRepository: vi.fn(async () => session), openRecentRepository: vi.fn(async () => session), recentRepositories: vi.fn(async () => []),
    listDirectory: vi.fn(async () => []), listSystemFonts: vi.fn(async () => []), loadManuscript: vi.fn(async () => {throw new Error('No synthetic manuscript');}),
    readDocument: vi.fn(async (_repository, path) => {
      const file = files.get(path); if (!file) throw new Error('Synthetic file absent'); return {...file};
    }),
    readRecovery: vi.fn(async (_repository, path) => recoveries.get(path) ?? null),
    stageRecovery: vi.fn((_repository, path, baseHash, text) => enqueue('stage', path, text, () => {
      const recovery = {id: `draft-${++revision}`, path, baseHash, text, updatedAt: revision};
      recoveries.set(path, recovery); staged.push(JSON.stringify([path, baseHash, text])); return recovery;
    })),
    saveDocument: vi.fn((_repository, path, baseHash, text) => {
      // This is checked at the IPC boundary, before allowing any write to finish.
      expect(staged).toContain(JSON.stringify([path, baseHash, text]));
      return enqueue('save', path, text, () => {
        if (files.get(path)?.contentHash !== baseHash) throw new Error('Conflict: synthetic disk changed');
        const saved = doc(path, text, ++revision); files.set(path, saved); return saved;
      });
    }),
    discardRecovery: vi.fn((_repository, path, id) => enqueue('discard', path, undefined, () => {
      if (recoveries.has(path) && recoveries.get(path)?.id !== id) throw new Error('A newer synthetic draft exists');
      recoveries.delete(path);
    })),
    setUnsavedChanges: vi.fn(async () => {}), requestClose: vi.fn(async () => {}),
    onCloseRequested: vi.fn(async callback => {close = callback; return () => {}; }),
  };
  return {core, files, recoveries, pending, trace, completionCounts, close: () => close()};
}
let app: ReturnType<typeof mountStudio> | undefined;
beforeEach(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  localStorage.clear(); document.body.replaceChildren(document.createElement('div'));
  vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout', 'Date']});
});
afterEach(() => {app?.destroy(); app = undefined; vi.useRealTimers();});
async function start(core: LocalCore) {
  app = mountStudio(document.body.firstElementChild as HTMLElement, core);
  await app.selectRepository(async () => session); await app.showDocument('scene.md'); await flush();
}
async function drain(machine: ReturnType<typeof host>) {
  // No timers are advanced here: finish only already-requested work and its
  // continuations, with a bound that is proportional to the queued operations.
  for (let n = 0; n < 10000; n++) {
    await flush();
    if (!machine.pending.length) return;
    machine.pending[0].finish();
  }
  throw new Error('The synthetic host did not quiesce');
}

describe('seeded actual Studio asynchronous state machine', () => {
  for (let offset = 0; offset < settings.seeds; offset++) {
    const seed = (settings.firstSeed + offset) >>> 0;
    it(`retains edits through delayed saves, recovery, retries and guards seed=${seed}`, async () => {
      const random = seeded(seed); const machine = host();
      const saves: Promise<boolean>[] = [];
      const operations = new Set<string>();
      const record = (name: string) => {operations.add(name); totals.record(name);};
      await start(machine.core);
      try {
        for (let step = 0; step < settings.steps; step++) {
          const choice = random(13); const current = view();
          const before = current.state.doc.toString();
          if (choice < 4) {
            const boundaries = positions(before); const index = random(boundaries.length);
            const from = boundaries[index]; const to = choice === 0 ? boundaries[index + random(boundaries.length - index)] : from;
            const insert = textAtoms[random(textAtoms.length)];
            const user = choice !== 3;
            machine.trace.push(`${step}: ${user ? 'type' : 'programmatic'} ${from}..${to} ${JSON.stringify(insert)}`);
            record(user ? 'type' : 'programmatic');
            const progress = document.querySelector<HTMLProgressElement>('progress')!.value;
            // A real edit first selects its target; this also reveals folded document details.
            if (user) current.dispatch({selection: {anchor: from, head: to}});
            current.dispatch({changes: {from, to, insert}, annotations: [isolateHistory.of('full'), ...(user ? [Transaction.userEvent.of('input.type')] : [])]});
            expect(current.state.doc.toString()).toBe(before.slice(0, from) + insert + before.slice(to));
            if (!user) expect(document.querySelector<HTMLProgressElement>('progress')!.value).toBe(progress);
          } else if (choice === 4 || choice === 5) {
            record(choice === 4 ? 'undo' : 'redo'); machine.trace.push(`${step}: ${choice === 4 ? 'undo' : 'redo'}`);
            const progress = document.querySelector<HTMLProgressElement>('progress')!.value;
            (choice === 4 ? undo : redo)(current);
            expect(document.querySelector<HTMLProgressElement>('progress')!.value).toBe(progress);
          } else if (choice === 6) {
            record('explicitSave'); machine.trace.push(`${step}: explicitSave`); saves.push(app!.saveCurrent());
          } else if (choice === 7) {
            record('timer'); machine.trace.push(`${step}: timer`); await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + random(800));
          } else if (choice === 8 || choice === 9) {
            if (machine.pending.length) {
              const pending = machine.pending[random(machine.pending.length)]; const fail = choice === 9 && random(3) === 0;
              record(fail ? `${pending.kind}FailureScheduled` : `${pending.kind}CompleteScheduled`);
              pending.finish(fail); await flush();
              expect(current.state.doc.toString()).toBe(before);
            }
          } else if (choice === 10 || choice === 11) {
            const label = choice === 10 ? 'navigation' : 'close'; record(label); machine.trace.push(`${step}: ${label}`);
            // While dirty or saving, navigation must either stop immediately or
            // ask. Always choose Keep editing in the generated phase.
            const badge = document.querySelector('.editor-toolbar [role="status"]')?.textContent;
            if (badge !== 'Saved locally') {
              totals.record(`${label}GuardCheck`);
              const leaving = choice === 10 ? app!.showDocument('other.md') : undefined;
              if (choice === 11) machine.close();
              await flush();
              if (document.querySelector('[aria-label="Unsaved changes"]')) {totals.record(`${label}KeepEditing`); button('Keep editing').click();}
              if (leaving) await leaving;
              await flush(); expect(view()).toBe(current); expect(current.state.doc.toString()).toBe(before);
              expect(machine.core.requestClose).not.toHaveBeenCalled();
            }
          } else {
            record('beforeunload'); machine.trace.push(`${step}: beforeunload`);
            const event = new Event('beforeunload', {cancelable: true}); window.dispatchEvent(event);
            const badge = document.querySelector('.editor-toolbar [role="status"]')?.textContent;
            if (badge?.includes('Unsaved') || badge?.includes('Saving')) expect(event.defaultPrevented).toBe(true);
          }
          await flush();
          expect(machine.pending.filter(item => item.kind === 'save').length).toBeLessThanOrEqual(1);
          expect(machine.pending.filter(item => item.kind === 'stage').length).toBeLessThanOrEqual(1);
          expect(document.querySelector('.preview script')).toBeNull();
          if (document.querySelector('.editor-toolbar [role="status"]')?.textContent === 'Saved locally') {
            expect(view().state.doc.toString()).toBe(normalize(machine.files.get('scene.md')!.text));
          }
        }
        // A successful explicit retry must durably converge to the newest buffer,
        // including edits made while earlier writes were pending.
        const finalVisible = view().state.doc.toString();
        saves.push(app!.saveCurrent()); await drain(machine); await Promise.all(saves);
        if (document.querySelector('.editor-toolbar [role="status"]')?.textContent !== 'Saved locally') {
          const retry = app!.saveCurrent(); await drain(machine); expect(await retry).toBe(true);
        }
        expect(normalize(machine.files.get('scene.md')!.text)).toBe(finalVisible);
        expect(view().state.doc.toString()).toBe(finalVisible);
        expect(document.querySelector('.editor-toolbar [role="status"]')?.textContent).toBe('Saved locally');
        // A stage completed after an older save can legitimately survive that
        // save's CAS cleanup, even when its bytes now match disk. A subsequent
        // explicit clean save must settle that safe, redundant recovery copy.
        if (machine.recoveries.size) {
          const cleanup = app!.saveCurrent(); await drain(machine); expect(await cleanup).toBe(true);
        }
        expect(machine.recoveries.size).toBe(0);
        await app!.showDocument('other.md'); expect(view().state.doc.toString()).toBe('Other\nscene');
        machine.close(); await flush(); expect(machine.core.requestClose).toHaveBeenCalledExactlyOnceWith(true);
      } catch (error) {
        throw new Error(`STUDIO_FUZZ_FIRST_SEED=${seed} STUDIO_FUZZ_SEEDS=1 STUDIO_FUZZ_STEPS=${settings.steps}\n${machine.trace.join('\n')}`, {cause: error});
      }
    }, 30000);
  }
});

// Minimized async sequences complement the long generated save campaigns. These
// still exercise mountStudio and actual CodeMirror transactions, not a UI model.
describe('reordered navigation and recovery responses', () => {
  for (let offset = 0; offset < settings.seeds; offset++) {
    const seed = (settings.firstSeed + offset) >>> 0;
    it(`ignores old recovery success/error after a newer scene wins seed=${seed}`, async () => {
      const random = seeded(seed); const machine = host(); await start(machine.core);
      const older = deferred<RecoveryDraft | null>(); const newer = deferred<RecoveryDraft | null>();
      machine.core.readDocument = vi.fn(async (_id, path) => doc(path, `${path} — 🐺\r\ncontent\n`));
      machine.core.readRecovery = vi.fn((_id, path) => path === 'older.md' ? older.promise : newer.promise);
      const oldRead = app!.showDocument('older.md'); await flush();
      const newRead = app!.showDocument('newer.md'); await flush();
      const draft = {id: 'newer-recovery', path: 'newer.md', baseHash: 'revision-0', text: 'recovered e\u0301\n🐺\r\n', updatedAt: 1};
      const withRecovery = random(2) === 0;
      newer.resolve(withRecovery ? draft : null); await newRead;
      const current = view(); const before = current.state.doc.toString();
      const fail = random(2) === 0;
      totals.record(fail ? 'staleRecoveryFailure' : 'staleRecoverySuccess');
      totals.record(withRecovery ? 'recoveryRestore' : 'newerCleanRead');
      if (fail) older.reject(new Error('Stale ownership failure'));
      else older.resolve({id: 'old-recovery', path: 'older.md', baseHash: 'revision-0', text: 'STALE RECOVERY', updatedAt: 1});
      await oldRead;
      expect(view()).toBe(current); expect(current.state.doc.toString()).toBe(before);
      expect(document.body.textContent).not.toContain('STALE RECOVERY');
      expect(document.querySelector('.status')?.textContent).not.toContain('Stale ownership');
      expect(current.state.readOnly).toBe(withRecovery);
      expect(machine.core.stageRecovery).not.toHaveBeenCalled();
      if (withRecovery) {
        const progress = document.querySelector<HTMLProgressElement>('progress')!.value;
        button('Restore draft').click(); expect(view().state.doc.toString()).toBe(normalize(draft.text));
        expect(document.querySelector<HTMLProgressElement>('progress')!.value).toBe(progress);
        await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS); await flush();
        expect(machine.core.stageRecovery).toHaveBeenCalledWith(session.id, 'newer.md', 'revision-0', draft.text);
      }
      await drain(machine);
    });
  }
  it('preserves programmatic edits arriving while repository selection is pending', async () => {
    const machine = host(); await start(machine.core); const current = view();
    const picker = deferred<RepositorySession | null>();
    const opening = app!.selectRepository(() => picker.promise); await flush();
    expect(current.state.readOnly).toBe(true);
    current.dispatch({changes: {from: 0, to: current.state.doc.length, insert: 'Late — author words 🐺'}});
    expect(await app!.saveCurrent()).toBe(false);
    expect(await app!.showDocument('other.md')).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(machine.core.stageRecovery).not.toHaveBeenCalled();
    picker.resolve({...session, id: 'other-session', name: 'Other synthetic repository'}); await opening;
    expect(view()).toBe(current);
    expect(current.state.doc.toString()).toBe('Late — author words 🐺');
    expect(document.querySelector('.status')?.textContent).toContain('changed while');
    expect(machine.core.saveDocument).not.toHaveBeenCalled();
    expect(current.state.readOnly).toBe(false);
    expect(await app!.saveCurrent()).toBe(false);
    current.dispatch({changes: {from: current.state.doc.length, insert: ' More late text'}});
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS * 2);
    expect(machine.core.stageRecovery).not.toHaveBeenCalled();
    expect(document.querySelector('.status')?.textContent).toContain('Copy these edits');
    const canceled = app!.selectRepository(async () => null); await flush();
    button('Discard changes').click(); await canceled;
    expect(current.state.doc.toString()).toContain('More late text');
    expect(document.querySelector('.status')?.textContent).toContain('Copy these edits');
    const failed = app!.selectRepository(async () => {throw new Error('Picker failed');}); await flush();
    button('Discard changes').click(); await failed;
    expect(document.querySelector('.status')?.textContent).toContain('Copy these edits');
    const reopened = app!.selectRepository(async () => session); await flush();
    button('Discard changes').click(); await reopened;
    await app!.showDocument('scene.md');
    view().dispatch({changes: {from: 0, to: view().state.doc.length, insert: 'Writing after reopening'}});
    const saving = app!.saveCurrent(); await drain(machine); expect(await saving).toBe(true);
    expect(machine.files.get('scene.md')?.text).toBe('Writing after reopening');
  });
  it('resumes editing and recovery after a canceled picker with late editor text', async () => {
    const machine = host(); await start(machine.core);
    const picker = deferred<RepositorySession | null>();
    const opening = app!.selectRepository(() => picker.promise); await flush();
    view().dispatch({changes: {from: 0, to: view().state.doc.length, insert: 'Preserved after cancel'}});
    picker.resolve(null); await opening;
    expect(view().state.readOnly).toBe(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS); await drain(machine);
    expect(machine.core.saveDocument).toHaveBeenCalledWith(session.id, 'scene.md', 'revision-0', 'Preserved after cancel');
    expect(machine.files.get('scene.md')?.text).toBe('Preserved after cancel');
  });
  it('saves exact mixed-ending bytes after intermediate undo and boundary joining', async () => {
    const machine = host(); machine.files.set('scene.md', doc('scene.md', 'a\r\nb\nc\rd'));
    await start(machine.core);
    view().dispatch({changes: {from: 7, insert: '🐺'}, annotations: isolateHistory.of('full')});
    view().dispatch({changes: {from: 2, to: 4}, annotations: isolateHistory.of('full')});
    undo(view());
    let saving = app!.saveCurrent(); await drain(machine); expect(await saving).toBe(true);
    expect(machine.files.get('scene.md')?.text).toBe('a\r\nb\nc\rd🐺');
    machine.files.set('other.md', doc('other.md', 'a\rb\nc'));
    await app!.showDocument('other.md');
    view().dispatch({changes: {from: 2, to: 3}, annotations: isolateHistory.of('full')});
    saving = app!.saveCurrent(); await drain(machine); expect(await saving).toBe(true);
    expect(machine.files.get('other.md')?.text).toBe('a\r\n\nc');
    await app!.showDocument('scene.md'); await app!.showDocument('other.md');
    expect(view().state.doc.toString()).toBe('a\n\nc');
    expect(machine.recoveries.size).toBe(0);
  });
});
