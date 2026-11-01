// Synthetic full-Studio host only; never imported by production. Invented text and a simulated backend:
// no files, provider, native dialogs or credentials. Everything routes through the production panel and reader.
import { mountStudio } from '../../src/studio';
import {EditorView} from '@codemirror/view';
import {applyAppearance, DEFAULT_APPEARANCE} from '../../src/appearance';
import type { LocalCore, Manuscript, ProposalOutcome, ProposalReceipt, RecoveryDraft, ReviewResult } from '../../src/localCore';
import '../../src/fonts.bundle';
import '../../src/style.css';
const params = new URLSearchParams(location.search);
const key = 'heinlein-markdown-reading-synthetic-v1';
const opening = '---\r\ntitle: "The Salt Ledger — invented"\r\n---\r\n# The Salt Ledger\r\n\r\nThe ferry 🐺 came in *very* late — it always did.\nMarlo counted the **crates** twice. The manifest were wrong again, and the harbor clerk had stopped pretending otherwise.\r\n\r\nSee the [harbor map](https://example.test/map "Map") and this [odd link](javascript:alert(1)). Rope &amp; tar stay literal.\r\n\r\n![Harbor at dusk](https://example.test/harbor.png)\r\n\r\n<img src="https://example.test/tracker.png" onerror="alert(1)">\r\n\r\n## Inventory\n\n- Rope, *tarred*\n- Lamp oil\n  on the second shelf\n\n1. Count\n2. Sign\n\n> Nobody signs twice.\n\n| Crate | Weight |\n|---|---|\n| Salt | 40 |\n\n```js\nalert("never runs");\n```\n\nRain moved across the pier in long grey sheets. Nobody looked up.\n';
const harbor = '# The Harbor\r\n\r\nThe bell rang twice 🦊 — once for the tide.\r\n';
const sha = async (text: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const baseline: Record<string, string> = { 'opening.md': opening, 'harbor.md': harbor };
const hashes: Record<string, string> = { 'opening.md': await sha(opening), 'harbor.md': await sha(harbor) };
const utf8 = (text: string) => new TextEncoder().encode(text).length;
const definition = { id: 'contextual', version: 1, displayName: 'Story and clarity review', instructions: 'Keep intentional voice.' };
function record(): ReviewResult {
  const suggest = (id: string, path: string, before: string, original: string, replacement: string, comment: string, extra: Partial<ReviewResult['edits'][number]> = {}) => {
    const source = baseline[path], at = source.indexOf(before) + before.indexOf(original), from = utf8(source.slice(0, at));
    return { id, path, fromUtf8: from, toUtf8: from + utf8(original), original, replacement, reason: comment, role: 'editor' as const, status: 'pending' as const, proposalId: null, conflictGroup: null, selected: false, location: { line: source.slice(0, at).split('\n').length, column: [...source.slice(source.lastIndexOf('\n', at - 1) + 1, at)].length + 1 }, patch: JSON.stringify({ path, fromUtf8: from, toUtf8: from + utf8(original), before: original, replacement }), patchHash: 'd'.repeat(64), comments: [comment], provenance: [{ instanceId: 'reviewer-1', definitionId: definition.id, definitionVersion: 1, displayName: definition.displayName, requestId: 'synthetic-call', model: 'synthetic-selected-model', accountId: 'synthetic-account', accountGeneration: 1 }], ...extra };
  };
  return { schemaVersion: 2, reviewId: 'demo-salt-ledger', requestId: 'demo-prepared', revision: 1, projectKey: null, scope: 'scene', model: 'synthetic-selected-model', workflow: { definitions: [{ instanceId: 'reviewer-1', definition, hash: 'c'.repeat(64) }], sources: Object.keys(baseline).map((path, order) => ({ id: `source-${order}`, path, sourceHash: hashes[path], readOnly: false, order })), coverage: [], decisions: [], accountId: 'synthetic-account', accountGeneration: 1, contextNotice: 'Simulated browser backend with invented text. No provider, filesystem or OS access.' }, edits: [
    suggest('example-frontmatter', 'opening.md', 'title: "The', 'title', 'heading', 'Markup example. This changes frontmatter, which Reading does not show.'),
    suggest('example-heading-mark', 'opening.md', '## Inventory', '## ', '### ', 'Markup example. This changes only the heading marker.'),
    suggest('example-insert', 'opening.md', ' came in', '', ' quietly', 'Insertion example. A small bar shows where this would go.'),
    suggest('example-stale', 'opening.md', 'counted the', 'counted', 'tallied', 'Stale example. The source changed, so this has no mark and cannot be approved.', { sourceStale: true }),
    suggest('example-approve', 'opening.md', 'manifest were wrong', 'were', 'was', 'Example 1 · Approve. "Manifest" is **singular**, so the verb looks like a slip. See [a usage note](https://example.test/usage).'),
    suggest('example-overlap-word', 'opening.md', 'long grey sheets', 'grey', 'gray', 'Example 3 · Overlap, alternative A. Changes one word.', { conflictGroup: 'overlap' }),
    suggest('example-overlap-phrase', 'opening.md', 'long grey sheets', 'long grey sheets', 'slanting sheets', 'Example 3 · Overlap, alternative B. Rewrites the phrase, including the same word.', { conflictGroup: 'overlap' }),
    suggest('example-dismiss', 'opening.md', 'Nobody looked up.', 'Nobody looked up.', 'Nobody bothered to look up.', 'Example 2 · Dismiss. This softens a closing sentence that may be deliberate.'),
    suggest('example-harbor', 'harbor.md', 'rang twice', 'twice', 'two times', 'Other file example. This is marked only when The Harbor is open.'),
  ] };
}
let stored: { docs: Record<string, string>; record: ReviewResult; receipts: ProposalReceipt[] } = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { docs: { ...baseline }, record: record(), receipts: [] };
const calls: { action: string; id?: string }[] = [];
const recovery: RecoveryDraft | null = null;
let dirty = false;
let guide: { refresh(): void } | null = null;
const persist = () => { localStorage.setItem(key, JSON.stringify(stored)); guide?.refresh(); };
persist();
const doc = (path: string) => ({ path, text: stored.docs[path], contentHash: stored.docs[path] === baseline[path] ? hashes[path] : 'e'.repeat(64), sizeBytes: utf8(stored.docs[path]), frontmatter: null, generatedCompatibility: false });
const book: Manuscript = { path: 'scene-manifest.json', project: 'Invented demo', schemaVersion: 1, volumes: [{ number: 1, title: 'Volume', path: '', chapters: [{ number: 1, title: 'The Salt Ledger', path: '', source: 'chapter.md', scenes: [{ path: 'opening.md' }, { path: 'harbor.md' }] }] }] };
const useChapter = params.get('doc') === 'chapter.md';
const session = { id: 'synthetic-markdown-session', name: 'Invented demo folder', manifests: useChapter ? ['scene-manifest.json'] : [] };
function confirmation(edit: ReviewResult['edits'][number]) {
  return new Promise<boolean>(resolve => {
    const box = document.createElement('dialog');
    box.className = 'fixture-confirm';
    box.setAttribute('aria-label', 'Simulated final confirmation');
    const line = (tag: 'h2' | 'p' | 'h3', text: string) => { const n = document.createElement(tag); n.textContent = text; box.append(n); return n; };
    const title = line('h2', 'Simulated final confirmation');
    line('p', `The real app shows a native dialog here. Apply this exact patch to ${edit.path}?`);
    line('h3', 'Replace'); line('p', edit.original || '(nothing, this is an insertion)');
    line('h3', 'With'); line('p', edit.replacement || '(nothing, this is a removal)');
    const finish = (yes: boolean) => { box.close(); box.remove(); resolve(yes); };
    for (const [label, yes] of [['Confirm and apply', true], ['Cancel', false]] as const) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.onclick = () => finish(yes); box.append(b); }
    box.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
    document.body.append(box);
    box.showModal();
    title.tabIndex = -1; title.focus(); box.scrollTop = 0;
  });
}
const unavailable = async (): Promise<never> => { throw new Error('Synthetic host: no native filesystem, credentials or provider calls.'); };
const core: LocalCore = { available: () => true, pickRepository: async () => session, recentRepositories: async () => [], openRecentRepository: unavailable, listSystemFonts: async () => [],
  listDirectory: async () => Object.keys(baseline).map(path => ({ path, name: path, kind: 'file' as const, sizeBytes: utf8(baseline[path]) })), loadManuscript: async () => book,
  readDocument: async (_id, path) => { if (!(path in stored.docs)) throw new Error('Synthetic file is not available'); return doc(path); },
  saveDocument: async (_id, path, _hash, text) => { calls.push({ action: 'save' }); stored.docs[path] = text; persist(); return doc(path); },
  readRecovery: async () => recovery, stageRecovery: async (_id, path, baseHash, text) => ({ id: 'recovery', path, baseHash, text, updatedAt: 1 }), discardRecovery: async () => { }, setUnsavedChanges: async value => { dirty = value; }, requestClose: async () => { }, onCloseRequested: async () => () => { },
  questionStatus: async () => ({ configured: true, model: 'synthetic-selected-model', selectedModel: 'synthetic-selected-model', models: [{ slug: 'synthetic-selected-model', displayName: 'Synthetic selected model' }], accounts: [{ id: 'synthetic-account', label: 'Synthetic account', signedIn: true, planEnabled: true }], activeAccountId: 'synthetic-account', generation: 1, usageLimited: false, signInPending: false, message: 'Synthetic only: no live account' }),
  reviewDefinitions: async () => [structuredClone(definition)], previewReview: async () => [], listReviews: async () => [structuredClone(stored.record)], requestReview: async () => { calls.push({ action: 'run' }); throw new Error('This demo uses prepared suggestions and runs no reviewers. Use Reset demo to start again.'); }, cancelQuestion: async () => true, getReview: async () => structuredClone(stored.record),
  chooseReviewEdit: async (_repo, _review, id) => { calls.push({ action: 'choose', id }); const group = stored.record.edits.find(e => e.id === id)!.conflictGroup; stored.record.edits.forEach(e => { if (e.conflictGroup === group) e.selected = e.id === id; }); persist(); return structuredClone(stored.record); },
  rejectReviewEdit: async (_repo, _review, id) => { calls.push({ action: 'reject', id }); stored.record.edits.find(e => e.id === id)!.status = 'rejected'; persist(); return structuredClone(stored.record); },
  approveReviewEdit: async (_repo, _review, id): Promise<ProposalOutcome | null> => {
    calls.push({ action: 'approve', id });
    const edit = stored.record.edits.find(e => e.id === id)!;
    if (dirty) throw new Error('Save matching synthetic writing first');
    if (edit.conflictGroup && !edit.selected) throw new Error('Choose a conflict alternative first');
    if (!await confirmation(edit)) return null;
    const delta = stored.record.edits.filter(e => e.id !== id && e.status === 'accepted' && e.path === edit.path && e.toUtf8 <= edit.fromUtf8).reduce((n, e) => n + utf8(e.replacement) - utf8(e.original), 0);
    const data = new TextEncoder().encode(stored.docs[edit.path]), from = edit.fromUtf8 + delta, to = edit.toUtf8 + delta;
    stored.docs[edit.path] = new TextDecoder().decode(data.slice(0, from)) + edit.replacement + new TextDecoder().decode(data.slice(to));
    edit.status = 'accepted';
    stored.record.edits.filter(e => e.id !== id && e.conflictGroup && e.conflictGroup === edit.conflictGroup && e.status === 'pending').forEach(e => { e.status = 'supersededByAuthorChoice'; });
    const receipt: ProposalReceipt = { id: `receipt-${id}`, kind: 'apply', proposalId: `proposal-${id}`, path: edit.path, baseHash: 'a'.repeat(64), replacementHash: 'b'.repeat(64), diffHash: 'c'.repeat(64), origin: { kind: 'nativeOpenAi', sessionId: '', clientLabel: '', identityAssurance: 'unverifiedProviderMetadata', provider: 'openai', model: 'synthetic-selected-model', requestId: 'synthetic-call' }, parentReceiptId: null, status: 'completed', message: null, createdAtMs: 1, revertAvailable: false };
    stored.receipts.unshift(receipt);
    persist();
    return { receipt, warning: null };
  },
  listProposals: async () => ({ pending: [], receipts: structuredClone(stored.receipts) }), reviewProposal: unavailable, reviewProposalRevert: unavailable, applyProposalReview: unavailable, cancelProposalReview: async () => { },
};
// Opt-in scene state for the production breadcrumb navigation regression.
if (params.has('sceneNavigation')) Object.assign(core, {
  loadDrafting: async () => ({manifestPath: 'ms/manuscript.json', revision: 'synthetic-navigation', project: 'Invented demo', groups: [], scenes: [{id: 'opening', title: 'Opening', path: 'opening.md', groupId: null}], untrackedPaths: [], missingPaths: []}),
  previewDraftingChange: unavailable, applyDraftingChange: unavailable, undoDraftingChange: unavailable,
});
const app = mountStudio(document.querySelector<HTMLElement>('#app')!, core);
Object.assign(window, { readingFixture: { app, view: () => EditorView.findFromDOM(document.querySelector('.active-document-pane .cm-editor') as HTMLElement)!, theme: () => applyAppearance({...DEFAULT_APPEARANCE, theme: 'contrast'}), calls, get docs() { return stored.docs; }, baseline, get record() { return stored.record; } } });
function mountGuide() {
  const style = document.createElement('style');
  style.textContent = '.fixture-demo{padding:.75rem .9rem;border:3px dashed var(--fg);border-radius:8px}.fixture-demo>*+*{margin-top:.5rem}.fixture-demo pre{white-space:pre-wrap}.fixture-confirm{width:min(36rem,calc(100vw - 1rem));max-width:100vw;max-height:100vh;padding:1rem;color:var(--fg);background:var(--surface);border:3px solid var(--fg);font-size:1.0625rem}.fixture-confirm>*+*{margin-top:.5rem}.fixture-confirm h2{font-size:1.3rem;font-weight:700}.fixture-confirm button{display:block;width:100%;min-height:48px;margin-top:.75rem;border:2px solid var(--fg);white-space:normal}.fixture-confirm::backdrop{background:#000b}';
  document.head.append(style);
  const box = document.createElement('section');
  box.className = 'fixture-demo';
  box.setAttribute('aria-label', 'Demo guide');
  const add = (parent: HTMLElement, tag: 'p', text: string) => { const n = document.createElement(tag); n.textContent = text; parent.append(n); return n; };
  add(box, 'p', 'Simulated browser demo with invented text: not native or provider acceptance.').style.fontWeight = '700';
  const state = add(box, 'p', '');
  const help = document.createElement('details');
  const title = document.createElement('summary');
  title.textContent = 'Demo guide · what to try';
  help.append(title);
  add(help, 'p', 'Choose Return to writing, then Reading. Headings, lists, tables and code are formatted. Source stays exact.');
  add(help, 'p', 'Click an underlined phrase in Reading to open its card. Example 1 approves, Example 2 dismisses, and Example 3 needs you to choose between alternatives.');
  add(help, 'p', 'Markup examples show a Formatting suggestion button, because a heading marker has no visible text to underline.');
  add(help, 'p', 'Links do not open and images do not load. Selecting text in Reading cannot ask, split or edit.');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Simulated source file, exact text';
  const source = document.createElement('pre');
  source.tabIndex = 0;
  details.append(summary, source);
  const reset = document.createElement('button');
  reset.type = 'button';
  reset.textContent = 'Reset demo';
  reset.onclick = () => { localStorage.removeItem(key); location.reload(); };
  box.append(help, details, reset);
  guide = { refresh() { source.textContent = stored.docs['opening.md']; state.textContent = stored.docs['opening.md'] === baseline['opening.md'] ? 'Simulated source file: unchanged since reset.' : 'Simulated source file: changed since reset.'; } };
  guide.refresh();
  document.querySelector('.heinlein-review-panel .review-head')?.after(box);
}
void app.selectRepository(async () => session).then(() => app.showDocument(params.get('doc') ?? 'opening.md')).then(async () => {
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Heinlein Review')?.click();
  mountGuide();
  const panel = document.querySelector<HTMLElement>('.heinlein-review-panel')!;
  await new Promise<void>(resolve => { const look = () => { if (panel.querySelector('.review-saved button')) resolve(); else setTimeout(look, 20); }; look(); });
  panel.querySelector<HTMLButtonElement>('.review-saved button')!.click();
  if (params.get('view') === 'reading') [...document.querySelectorAll<HTMLButtonElement>('.active-document-pane .md-view-toggle button')].find(b => b.textContent === 'Reading')?.click();
});
