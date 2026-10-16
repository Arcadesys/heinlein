// @vitest-environment jsdom
import {expect, it, vi} from 'vitest';
import {createReviewPanel, type ReviewScope} from './reviewPanel';
import type {LocalCore, QuestionStatus, ReviewRequest, ReviewResult} from './localCore';
const cryptoModule = 'node:crypto';
const {webcrypto} = await import(cryptoModule) as {webcrypto: Crypto};
const processModule = 'node:process';
const {env} = await import(processModule) as {env: Record<string, string | undefined>};
const ready: QuestionStatus = {configured: true, model: 'synthetic-model', message: 'Synthetic', accounts: [{id: 'synthetic-account', label: 'Synthetic', signedIn: true, planEnabled: true}], activeAccountId: 'synthetic-account', models: [{slug: 'synthetic-model', displayName: 'Synthetic'}], selectedModel: 'synthetic-model', signInPending: false, generation: 1, usageLimited: false};
function deferred<T>() {let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};}
async function settle() {for (let i = 0; i < 14; i++) await Promise.resolve();}
const initial = 'Bad 🦊—fragment.\r\n\r\nUnrelated queer character and deliberate repetition. Repetition.\r\n';
function valid(request: ReviewRequest): ReviewResult {return {reviewId: `review:${request.requestId}`, requestId: request.requestId, model: 'synthetic-model', schemaVersion: 1, scope: request.scope, edits: [{id: 'edit', path: request.snapshots[0].path, fromUtf8: 0, toUtf8: 3, original: request.snapshots[0].source.slice(0, 3), replacement: request.snapshots[0].source.startsWith('New') ? 'Bad' : 'New', reason: 'Synthetic <img src=x onerror=alert(1)> suggestion', role: 'editor', status: 'pending', proposalId: null}]};}
function malformed(request: ReviewRequest, variant: number): unknown {const value = valid(request); const edit = value.edits[0]; switch (variant % 12) {case 0: return '{"edits": [ malformed JSON'; case 1: return null; case 2: return {...value, schemaVersion: 99}; case 3: return {...value, requestId: 'wrong-request'}; case 4: edit.path = '../unrelated.md'; break; case 5: edit.fromUtf8 = -1; break; case 6: edit.fromUtf8 = 5; edit.toUtf8 = 7; edit.original = '🦊'; break; case 7: edit.toUtf8 = 1e9; break; case 8: edit.original = 'wrong bytes'; break; case 9: edit.fromUtf8 = 0.5; break; case 10: value.edits.push({...edit, id: 'overlap'}); break; case 11: return {...value, edits: [null]};} return value;}

it('review_fuzz_renderer: replayable stateful asynchronous operations preserve manuscript authority', async () => {
  const start = Number(env.HEINLEIN_REVIEW_FUZZ_START ?? 1), seeds = Number(env.HEINLEIN_REVIEW_FUZZ_SEEDS ?? 64), steps = Number(env.HEINLEIN_REVIEW_FUZZ_STEPS ?? 384);
  expect(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(seeds) && seeds > 0 && seeds <= 1024 && Number.isSafeInteger(steps) && steps >= 32 && steps <= 4096).toBe(true);
  const names = ['open', 'request', 'response', 'malformed', 'provider-error', 'cancel', 'retry', 'type', 'save', 'navigate', 'accept', 'reject', 'prepare-return', 'confirm', 'refresh'];
  const counts = Object.fromEntries(names.map(name => [name, 0])); let malformedCount = 0; let discardedLate = 0; let stoppedGuards = 0; let dispatched = 0; let nativeReviewOpened = 0; let explicitAccepted = 0; let effectiveClicks = 0;
  vi.stubGlobal('crypto', webcrypto); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  try {
    for (let seed = start; seed < start + seeds; seed++) {
      let rng = seed >>> 0; const next = () => {rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng >>> 8;};
      const files = new Map([['one.md', initial], ['two.md', initial + 'Second scene.\r\n'], ['unrelated.md', 'PRIVATE UNRELATED 🐺\r\n— unchanged\u0000']]);
      const expectedDisk = new Map(files); let path = 'one.md'; let text = files.get(path)!; let expectedText = text; let explicitSaves = 0; let epoch = 0;
      const requests: {request: ReviewRequest; wait: ReturnType<typeof deferred<ReviewResult>>; canceled: boolean; settled: boolean}[] = [];
      const results = new Map<string, ReviewResult>(); const snapshots = new Map<string, ReviewRequest>();
      const preparations: {reviewId: string; wait: ReturnType<typeof deferred<{proposalId: string}>>; epoch: number}[] = [];
      const confirmations: {id: string; guard: () => string | null; wait: ReturnType<typeof deferred<void>>}[] = [];
      let frozen: ReviewScope | null = null;
      const core = {
        available: () => true, questionStatus: vi.fn(async () => ready),
        requestReview: vi.fn((request: ReviewRequest) => {dispatched++; expect(request.snapshots).toEqual(frozen!.snapshots); expect(request.repositoryId).toBe('synthetic'); const wait = deferred<ReviewResult>(); requests.push({request, wait, canceled: false, settled: false}); snapshots.set(`review:${request.requestId}`, request); return wait.promise;}),
        cancelQuestion: vi.fn(async (id: string) => {const found = requests.find(item => item.request.requestId === id); if (found) found.canceled = true; return true;}),
        prepareReviewEdit: vi.fn((_repo: string, reviewId: string) => {expect(text).toBe(files.get(path)); const wait = deferred<{proposalId: string}>(); preparations.push({reviewId, wait, epoch}); return wait.promise;}),
        getReview: vi.fn(async (_repo: string, reviewId: string) => structuredClone(results.get(reviewId)!)),
        rejectReviewEdit: vi.fn(async (_repo: string, reviewId: string) => {const result = results.get(reviewId)!; result.edits[0].status = 'rejected'; return structuredClone(result);}),
        saveDocument: vi.fn(async (_repo: string, target: string, _hash: string, value: string) => {files.set(target, value);}),
        applyProposalReview: vi.fn(),
      };
      document.body.replaceChildren();
      const panel = createReviewPanel(core as unknown as LocalCore, {
        capture: () => {frozen = {repositoryId: 'synthetic', scope: 'scene', label: path, snapshots: [{path, source: text, sourceHash: 'synthetic-base'}]}; return structuredClone(frozen);},
        unavailable: () => text !== files.get(path) ? 'Unsaved author edits' : null,
        reviewProposal: async (id, guard) => {nativeReviewOpened++; expect(guard()).toBeNull(); const wait = deferred<void>(); confirmations.push({id, guard, wait}); await wait.promise;},
        openConnection: () => {}, focusEditor: () => {},
      });
      document.body.append(panel.element);
      const click = (label: string) => {const node = [...panel.element.querySelectorAll('button')].find(item => item.textContent === label); if (node && !panel.element.hidden && !node.hidden && !node.disabled) {effectiveClicks++; node.click(); return true;} return false;};
      const trace: string[] = [];
      try {
        panel.open(); await settle();
        for (let step = 0; step < steps; step++) {
          const kind = step < 5 ? [1, 2, 10, 12, 13][step] : next() % names.length; counts[names[kind]]++; trace.push(`${step}:${names[kind]}`); if (trace.length > 32) trace.shift();
          const beforeSaves = core.saveDocument.mock.calls.length;
          if (kind === 0) panel.open();
          else if (kind === 1) click('Run Heinlein Review');
          else if (kind >= 2 && kind <= 4) {
            const candidates = requests.filter(item => !item.settled); const item = candidates.length ? candidates[next() % candidates.length] : null;
            if (item) {
              item.settled = true; const before = panel.element.querySelectorAll('[data-edit-action]').length;
              if (kind === 4) item.wait.reject({message: 'Synthetic provider error'});
              else if (kind === 3) {malformedCount++; item.wait.resolve(malformed(item.request, next()) as ReviewResult);}
              else {const result = valid(item.request); results.set(result.reviewId, result); item.wait.resolve(structuredClone(result));}
              await settle();
              if (item.canceled) {discardedLate++; expect(panel.element.querySelectorAll('[data-edit-action]').length).toBe(before);}
              if (kind === 3 && !item.canceled) expect(panel.element.querySelectorAll('[data-edit-action]').length).toBe(0);
            }
          } else if (kind === 5) click('Cancel review');
          else if (kind === 6) click('Retry review');
          else if (kind === 7) {text += ` Author-${seed}-${step}🦊`; expectedText = text; epoch++; panel.stateChanged();}
          else if (kind === 8) {explicitSaves++; expectedDisk.set(path, text); await core.saveDocument('synthetic', path, 'synthetic-base', text); panel.stateChanged();}
          else if (kind === 9) {panel.clear(); path = path === 'one.md' ? 'two.md' : 'one.md'; text = files.get(path)!; expectedText = text; epoch++; expect(panel.element.querySelectorAll('.question-text').length).toBe(1);}
          else if (kind === 10) {const dirty = text !== files.get(path); const calls = core.prepareReviewEdit.mock.calls.length; click('Accept edit'); if (dirty) expect(core.prepareReviewEdit.mock.calls.length).toBe(calls);}
          else if (kind === 11) click('Reject edit');
          else if (kind === 12) {const item = preparations.shift(); if (item) {const before = confirmations.length; item.wait.resolve({proposalId: item.reviewId}); await settle(); if (text !== files.get(path) || panel.element.hidden) {stoppedGuards++; expect(confirmations.length).toBe(before);}}}
          else if (kind === 13) {
            const item = confirmations.shift(); if (item) {
              const request = snapshots.get(item.id)!; const snapshot = request.snapshots[0]; const result = results.get(item.id)!;
              // This fake native authority only mutates during this explicit author-confirm operation.
              if (!item.guard() && files.get(snapshot.path) === snapshot.source && path === snapshot.path) {
                explicitAccepted++; const replacement = result.edits[0].replacement + snapshot.source.slice(3); files.set(snapshot.path, replacement); expectedDisk.set(snapshot.path, replacement); text = replacement; expectedText = replacement; result.edits[0].status = 'accepted';
                expect(replacement.slice(3)).toBe(snapshot.source.slice(3));
              } else stoppedGuards++;
              item.wait.resolve();
            }
          } else if (kind === 14) click('Refresh review');
          await settle();
          expect(text).toBe(expectedText); expect([...files]).toEqual([...expectedDisk]); expect(files.get('unrelated.md')).toBe('PRIVATE UNRELATED 🐺\r\n— unchanged\u0000');
          expect(core.saveDocument.mock.calls.length).toBe(explicitSaves); if (kind !== 8) expect(core.saveDocument.mock.calls.length).toBe(beforeSaves);
          expect(core.applyProposalReview).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled(); expect(document.querySelector('img,script')).toBeNull();
        }
      } catch (error) {throw new Error(`Review fuzz replay seed=${seed} steps=${steps}; tail=${trace.join(', ')}; ${String(error)}`, {cause: error});}
      finally {panel.destroy(); for (const item of requests) if (!item.settled) item.wait.reject({message: 'Synthetic cleanup'}); for (const item of preparations) item.wait.resolve({proposalId: item.reviewId}); for (const item of confirmations) item.wait.resolve(); await settle();}
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    expect(nativeReviewOpened).toBeGreaterThanOrEqual(seeds); expect(explicitAccepted).toBeGreaterThanOrEqual(seeds); if (seeds * steps >= 4800) {expect(malformedCount).toBeGreaterThan(0); expect(discardedLate).toBeGreaterThan(0);}
    console.info(`Review renderer fuzz seeds ${start}..${start + seeds - 1}; ${seeds * steps} stateful operations; counts=${JSON.stringify(counts)}; malformed=${malformedCount}; discarded late=${discardedLate}; stopped guards=${stoppedGuards}; dispatched=${dispatched}; native reviews=${nativeReviewOpened}; explicit accepts=${explicitAccepted}; effective clicks=${effectiveClicks}`);
  } finally {vi.unstubAllGlobals(); document.body.replaceChildren();}
}, 120000);
