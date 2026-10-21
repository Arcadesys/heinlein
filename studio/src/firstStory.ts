import type {LocalCore, RepositorySession} from './localCore';
export interface PublishingMetadata {title: string; author: string; rights: string; language: string; formats: string[]; folderName: string; freePlayApproved: boolean; noCoverApproved: boolean}
export interface FirstStoryState {
  schemaVersion: 1; manuscriptPath: string; revision: string; enabled: boolean; stage: number;
  steps: ('todo' | 'done' | 'skipped')[]; idea: string[]; approach: 'discovery' | 'plan'; plan: string;
  structureReviewed: boolean; sentenceReviewed: boolean; sourceRevision: string | null; proofRevision: string | null;
  releaseChecks: boolean[]; publishing: PublishingMetadata | null;
}
export interface PublishingCopy {destination: string; preview: {id: string; sourceRevision: string; manifestRevision: string; sources: {id: string; title: string; path: string; contentHash: string; sizeBytes: number}[]; manuscript: string; config: string; treatment: string; folderName: string}}
export const FIRST_STORY_STAGES = ['Find an idea', 'Choose a way in', 'Draft to an ending', 'Revise story and voice', 'Proof a saved revision', 'Prepare a publishing copy'] as const;
export function emptyFirstStory(): FirstStoryState {return {schemaVersion: 1, manuscriptPath: 'ms/manuscript.json', revision: 'new', enabled: false, stage: 0, steps: Array(6).fill('todo'), idea: Array(4).fill(''), approach: 'discovery', plan: '', structureReviewed: false, sentenceReviewed: false, sourceRevision: null, proofRevision: null, releaseChecks: Array(4).fill(false), publishing: null};}
export function invalidateFirstStory(state: FirstStoryState) {
  state.proofRevision = null;
  if (state.steps[4] === 'done') state.steps[4] = 'todo';
  if (state.steps[5] === 'done') state.steps[5] = 'todo';
  state.releaseChecks.fill(false);
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => {const n = document.createElement(tag); n.textContent = text; return n;};
export function createFirstStory(core: LocalCore, options: {session(): RepositorySession | null; problem(): string | null; settle(): Promise<void>; openFolder(): Promise<void>; draft(): Promise<void>; review(): void}) {
  const element = node('dialog'); element.className = 'first-story'; element.setAttribute('aria-labelledby', 'first-story-title');
  let state: FirstStoryState | null = null; let copy: PublishingCopy | null = null; let busy = false; let generation = 0; let sourceGeneration = 0; let editGeneration = 0; let opener: HTMLElement | null = null;
  let lockedGeneration: number | null = null;
  const message = node('p'); message.setAttribute('role', 'status'); message.className = 'guide-status';
  function button(label: string, run: () => void | Promise<void>, primary = false) {const b = node('button', label); b.type = 'button'; b.disabled = busy; if (primary) b.className = 'primary'; b.addEventListener('click', () => {void act(run);}); return b;}
  function current(view: number, source: number) {return generation === view && sourceGeneration === source && element.open;}
  function requireCurrent(view: number, source: number) {if (!current(view, source)) throw new Error('Story or guide changed. Try again from the current guide.');}
  function syncEditLock() {element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>('input, textarea, select').forEach(input => input.disabled = lockedGeneration === generation);}
  async function withLockedEdits<T>(run: () => Promise<T>) {
    const view = generation; lockedGeneration = view; syncEditLock();
    try {return await run();} finally {if (lockedGeneration === view) {lockedGeneration = null; if (generation === view) syncEditLock();}}
  }
  async function act(run: () => void | Promise<void>) {
    if (busy) return; busy = true; const current = generation; element.setAttribute('aria-busy', 'true');
    element.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = true);
    try {await run();} catch (error) {if (generation === current) message.textContent = String(error);}
    finally {if (generation === current) {busy = false; element.removeAttribute('aria-busy'); element.querySelectorAll<HTMLButtonElement>('button').forEach(b => b.disabled = false);}}
  }
  function discardCopy() {
    if (!copy) return;
    copy = null; element.querySelector('[aria-label="Publishing copy preview"]')?.remove();
    message.textContent = 'Settings changed. Preview the publishing copy again before creating it.';
  }
  function field(label: string, value: string, update: (v: string) => void, multiline = false) {
    const wrap = node('label', label); const input = multiline ? node('textarea') : node('input'); input.value = value; input.maxLength = multiline ? 4000 : 200;
    input.addEventListener('input', () => {editGeneration++; discardCopy(); update(input.value);}); wrap.append(input); return wrap;
  }
  function check(label: string, value: boolean, update: (v: boolean) => void) {
    const wrap = node('label', label); wrap.className = 'guide-check'; const input = node('input'); input.type = 'checkbox'; input.checked = value;
    input.addEventListener('change', () => {editGeneration++; discardCopy(); update(input.checked);}); wrap.prepend(input); return wrap;
  }
  function help(summary: string, content: string) {const details = node('details'); details.append(node('summary', summary), node('p', content)); return details;}
  async function persist(proof = false) {
    const session = options.session(); if (!session || !state || !core.saveFirstStory) throw new Error('Choose a story folder in the native app first.');
    const current = generation; const source = sourceGeneration; const submitted = structuredClone(state);
    const saved = await core.saveFirstStory(session.id, submitted, proof);
    if (generation !== current) throw new Error('Story folder changed. Reopen the guide.');
    // Controls stay editable while saving. Retain author edits and bound objects;
    // accept only native-owned revisions and proof/check invalidations.
    state.revision = saved.revision; state.sourceRevision = saved.sourceRevision; state.proofRevision = saved.proofRevision;
    if (source !== sourceGeneration || (!proof && saved.sourceRevision !== submitted.sourceRevision)) invalidateFirstStory(state);
    else {
      for (const i of [4, 5]) if (saved.steps[i] !== submitted.steps[i]) state.steps[i] = saved.steps[i];
      saved.releaseChecks.forEach((value, i) => {if (value !== submitted.releaseChecks[i]) state!.releaseChecks[i] = value;});
    }
  }
  async function next() {if (!state) return; state.steps[state.stage] = 'done'; state.stage = Math.min(5, state.stage + 1); await persist(); render(true);}
  async function leave(run?: () => void | Promise<void>) {
    if (state?.enabled) {
      // Close/Escape and drafting/review exits must flush edits made while the
      // final native save was pending, before open() can reload stored progress.
      let submittedEdits: number;
      do {submittedEdits = editGeneration; await persist();} while (submittedEdits !== editGeneration);
    }
    element.close(); if (run) await run();
  }
  function confirmation(title: string, detail: string, proceed: () => Promise<void>) {
    const box = node('section'); box.className = 'guide-confirm'; box.setAttribute('aria-label', title); const heading = node('h3', title); heading.tabIndex = -1;
    box.append(heading, node('p', detail), button('Keep this stage', () => {box.remove(); element.querySelector<HTMLElement>('h2')?.focus();}), button('Skip this stage', async () => {await proceed();})); element.append(box); heading.focus();
  }
  function render(focus = false) {
    element.replaceChildren(); const title = node('h2', 'Your first story'); title.id = 'first-story-title'; title.tabIndex = -1;
    element.append(title, node('p', 'Optional. Resume any time.'), message);
    if (!options.session()) {
      element.append(node('h3', 'Start with a place for your story'), node('p', 'Choose or create an empty folder with Open Folder. Then open drafting and choose the manuscript-creation button. You can plan an idea here before writing a scene.'), button('Open a story folder…', async () => {element.close(); await options.openFolder(); await open();}, true));
    } else if (!core.loadFirstStory || !core.saveFirstStory) {
      element.append(node('p', 'Open the native Heinlein app to save guide progress for this story folder. You can still begin with a character, a want and an obstacle.'));
    } else if (!state) {
      element.append(node('p', 'Guide progress could not be opened. Your story files are unchanged. You can reset only the guide below.'));
    } else if (!state.enabled) {
      element.append(node('h3', 'Begin wherever you are'), node('p', 'An idea, a rough draft or a finished story is enough. This optional guide saves progress with this story folder. It never fills in prose or requests an AI review on its own.'), button('Start my story guide', async () => {state!.enabled = true; await persist(); render(true);}, true));
    } else {
      const nav = node('nav'); nav.setAttribute('aria-label', 'Story guide stages');
      FIRST_STORY_STAGES.forEach((label, i) => {const b = button(`${i + 1}. ${label} — ${state!.steps[i]}`, async () => {await persist(); state!.stage = i; await persist(); copy = null; render(true);}); if (i === state!.stage) b.setAttribute('aria-current', 'step'); nav.append(b);}); const stages = node('details'); stages.className = 'guide-stage-list'; stages.append(node('summary', 'Stages and progress'), nav); element.append(stages);
      const s = state; const stage = node('section'); stage.className = 'guide-current-stage'; const stepHeading = node('h3', `${s.stage + 1}. ${FIRST_STORY_STAGES[s.stage]}`); stepHeading.className = 'guide-current-step'; stepHeading.tabIndex = -1; stage.append(stepHeading);
      if (s.stage === 0) {
        stage.append(node('p', 'Next: name someone who wants something, and what gets in the way. A few words are enough.'));
        ['Who is this story about?', 'What do they want?', 'What stands in their way?', 'What might change?'].forEach((label, i) => stage.append(field(label, s.idea[i], v => s.idea[i] = v)));
        stage.append(node('p', 'Ready when you have a want and an obstacle, or a question you want to explore.'), help('An example, if useful', 'A courier wants to deliver a letter before dawn, but the bridge is gone. By the end, they may have to ask for help. Yours can be quieter, stranger or less planned.'), button('Save idea and continue', next, true));
      } else if (s.stage === 1) {
        stage.append(node('p', 'Next: choose how you want to begin. Discovery writing means finding the story while writing it; a light plan is only a few possible turns.'));
        const label = node('label', 'My way in'); const select = node('select'); for (const [value, text] of [['discovery', 'Discover by writing'], ['plan', 'Make a light plan']]) {const option = node('option', text); option.value = value; select.append(option);} select.value = s.approach; select.onchange = () => {editGeneration++; s.approach = select.value as typeof s.approach;}; label.append(select); stage.append(label, field('Optional notes: an opening, a turn, a possible ending', s.plan, v => s.plan = v, true), node('p', 'Ready when you have somewhere to start. You may change your mind as you write.'), button('Use this approach', next, true));
      } else if (s.stage === 2) {
        stage.append(node('p', 'Next: write one scene where the character tries something. Keep going toward an ending. A scene is one stretch of action or conversation; it need not be a chapter.'), button('Open drafting', () => leave(options.draft), true), node('p', 'New story? In drafting, use the manuscript-creation button, then New scene. Leave a note for any gap you cannot solve yet.'), help('When is a first draft ready?', 'Ready for revision when there is an ending you can respond to, even if the middle has gaps. Aim to discover what happens, not to perfect every sentence.'), button('My draft reaches an ending; continue', next));
      } else if (s.stage === 3) {
        stage.append(node('p', s.structureReviewed ? 'Next: make a separate sentence pass for clarity and voice.' : 'Next: read the whole story for cause and consequence before polishing sentences.'), check('I made a story/structure pass', s.structureReviewed, v => s.structureReviewed = v), check('I made a separate sentence/voice pass', s.sentenceReviewed, v => s.sentenceReviewed = v), help('Two different revision passes', 'Story pass: where does the want meet resistance? Does a choice affect the ending? Move or cut only what you choose. Sentence pass: check whether words carry your meaning and voice. Fragments, repetition, profanity and em dashes can be intentional. There is no style score to pass.'), button('Open advisory Heinlein Review', () => leave(options.review)), node('p', 'Review runs only when you ask, using the existing connection controls. Suggestions require your judgment and explicit approval.'), node('p', 'Ready when the story says what you want it to say, and the sentences sound like yours.'), button('Revision pass done; continue', next, true));
      } else if (s.stage === 4) {
        stage.append(node('p', 'Next: save the story, then read this stable revision for typos, missing words and accidental inconsistencies. Proofing is this final error check, separate from changing the story.'), node('p', s.proofRevision ? 'Proof applies to the saved revision. Later source edits clear proof and release checks.' : 'No current proof recorded. Save and resolve any recovery drafts first. Later source edits clear proof and release checks.'), node('p', 'Ready when you have checked the saved text and its intentional punctuation, names and details.'), button('Mark this saved revision proofread', async () => {const view = generation; const source = sourceGeneration; await options.settle(); requireCurrent(view, source); const problem = options.problem(); if (problem) throw new Error(problem); await persist(true); requireCurrent(view, source); state!.stage = 5; await persist(); render(true);}, true));
      } else {renderPublishing(stage, s);}
      element.append(stage, help('How this guide works', 'Use or skip any stage. You choose what is ready. Checking a box never changes your story, sends it to a provider or publishes it.'), button('Save guide progress', async () => {await persist(); message.textContent = 'Guide progress saved. Story text is unchanged.';}), button('Skip this stage…', () => confirmation('Skip this stage?', 'You can return to it at any time. No story text or publishing checks will be changed automatically.', async () => {s.steps[s.stage] = 'skipped'; s.stage = Math.min(5, s.stage + 1); await persist(); copy = null; render(true);})));
    }
    if (options.session() && core.resetFirstStory) element.append(button('Reset guide…', () => withLockedEdits(async () => {const view = generation; const reset = await core.resetFirstStory!(options.session()!.id); if (generation !== view) return; if (reset) {state = reset; copy = null; message.textContent = 'Guide reset. Story text is unchanged.'; render(true);}})));
    element.append(button('Close guide', () => leave())); syncEditLock(); if (focus) {const current = element.querySelector<HTMLElement>('.guide-current-step') ?? title; current.focus(); if (current !== title) current.scrollIntoView({block: 'start'});}
  }
  function renderPublishing(stage: HTMLElement, s: FirstStoryState) {
    stage.append(node('p', 'Next: choose metadata and make a separate publishing copy. Metadata means the title, author and rights information printed with the story. This prepares local files; it does not share or publish them.'), node('p', 'Text-only copies include every declared scene in reading order. Groups add no chapters. Scene frontmatter, links, images and include directives need a separate manual publishing project.'));
    const m = s.publishing ??= {title: '', author: '', rights: '', language: 'en-US', formats: ['html', 'epub'], folderName: 'first-story-publishing-copy', freePlayApproved: false, noCoverApproved: false};
    for (const [key, label] of [['title', 'Story title'], ['author', 'Author name to print'], ['rights', 'Rights statement (your choice)'], ['language', 'Language code'], ['folderName', 'New publishing-copy folder name']] as const) stage.append(field(label, m[key], v => {m[key] = v;}));
    const formats = node('fieldset'); formats.append(node('legend', 'Formats to build later')); for (const f of ['html', 'epub', 'pdf', 'docx', 'text']) formats.append(check(f.toUpperCase(), m.formats.includes(f), value => {m.formats = value ? [...m.formats, f] : m.formats.filter(x => x !== f);})); stage.append(formats);
    stage.append(check('I choose no cover for this text-only copy', m.noCoverApproved, v => m.noCoverApproved = v), check('I approve the existing FREE PLAY Publishing branding for this copy', m.freePlayApproved, v => m.freePlayApproved = v), help('What the imprint choice means', 'The existing publisher adds FREE PLAY Publishing / The Arcades branding and its preset colophon text. This is not a claim that you belong to that imprint. If you do not want this branding, stop here and configure a separate publishing project manually. No personal rights or author profile is inherited. PDF needs Chrome; EPUB/DOCX/HTML need the existing Pandoc setup.'), node('p', 'Release checklist — author judgment, never automatic edits:'));
    ['Rights and permissions are mine or cleared', 'Title, author and reading order are reviewed', 'No-cover choice and imprint are reviewed', 'I will inspect the built files before sharing'].forEach((label, i) => stage.append(check(label, s.releaseChecks[i], v => s.releaseChecks[i] = v)));
    stage.append(button('Preview publishing copy…', async () => {
      const view = generation; const source = sourceGeneration;
      await options.settle(); requireCurrent(view, source);
      const problem = options.problem(); if (problem) throw new Error(problem);
      if (!core.previewPublishingCopy) throw new Error('Publishing-copy support requires the native app.');
      await persist(); requireCurrent(view, source); discardCopy();
      const edits = editGeneration;
      const result = await core.previewPublishingCopy(options.session()!.id, structuredClone(m));
      if (generation !== view) return;
      if (!current(view, source) || editGeneration !== edits) {copy = null; message.textContent = 'Settings or story changed. Preview the publishing copy again before creating it.'; return;}
      copy = result; message.textContent = copy ? 'Preview ready. No publishing files written yet.' : 'Destination choice canceled. No publishing files written.'; render(true);
    }, true));
    if (copy) {
      const prepared = copy; const preview = node('section'); preview.setAttribute('aria-label', 'Publishing copy preview'); preview.append(node('h3', 'Publishing copy preview'), node('p', `New folder: ${prepared.destination}`), node('p', prepared.preview.treatment));
      const ordered = node('ol'); for (const source of prepared.preview.sources) ordered.append(node('li', `${source.title} — ${source.path}`)); preview.append(ordered);
      for (const [label, text] of [['Exact combined Markdown', prepared.preview.manuscript], ['Publisher configuration', prepared.preview.config], ['Source provenance', JSON.stringify({revision: prepared.preview.sourceRevision, manifestRevision: prepared.preview.manifestRevision, sources: prepared.preview.sources}, null, 2)]]) {const details = node('details'); const pre = node('pre', text); pre.tabIndex = 0; details.append(node('summary', label), pre); preview.append(details);}
      preview.append(button('Cancel copy preview', () => {copy = null; message.textContent = 'Copy preview canceled. No publishing files written.'; render(true);}), button('Create this new copy…', () => withLockedEdits(async () => {
        const view = generation; const source = sourceGeneration; const edits = editGeneration;
        await options.settle(); requireCurrent(view, source);
        if (copy !== prepared || edits !== editGeneration) throw new Error('Settings changed. Preview the publishing copy again before creating it.');
        const problem = options.problem(); if (problem) throw new Error(problem);
        const created = await core.confirmPublishingCopy!(options.session()!.id, prepared.preview.id);
        if (!current(view, source)) return;
        copy = null; render(true); message.textContent = created ? 'Publishing copy created. Source is unchanged. No files have been shared.' : 'Creation canceled. No publishing files written.';
        if (created) {const instructions = node('section'); instructions.append(node('h3', 'Build and inspect outside Studio'), node('p', 'Open a terminal in the new copy folder. Use the existing Heinlein CLI; inspect the HTML preview and chosen format before sharing. Later source changes need a new copy.'), node('pre', 'heinlein build\nheinlein serve --host 127.0.0.1 --port 8765')); element.insertBefore(instructions, element.lastElementChild);}
      }), true)); stage.append(preview);
    }
    stage.append(node('p', 'Ready for sharing only after you inspect the actual built files and decide where and how to release them. Studio does not handle distribution.'), button('Mark publishing preparation done', async () => {s.steps[5] = 'done'; await persist(); message.textContent = 'Preparation marked done by you. Nothing has been published.';}));
  }
  async function open() {
    opener = document.activeElement instanceof HTMLElement ? document.activeElement : null; const current = ++generation; const source = sourceGeneration; busy = false; copy = null; message.textContent = '';
    if (!element.open) element.showModal();
    state = null; render();
    const session = options.session();
    if (session && core.loadFirstStory) {try {const loaded = await core.loadFirstStory(session.id); if (current !== generation) return; if (source !== sourceGeneration) invalidateFirstStory(loaded); state = loaded;} catch (e) {if (current === generation) message.textContent = String(e);}}
    if (current === generation) render(true);
  }
  element.addEventListener('cancel', e => {e.preventDefault(); void act(() => leave());});
  element.addEventListener('close', () => opener?.isConnected && opener.focus());
  return {element, open, clear: () => {generation++; busy = false; state = null; copy = null; if (element.open) element.close();}, sourceChanged: () => {sourceGeneration++; editGeneration++; copy = null; if (state) {invalidateFirstStory(state); if (element.open) {message.textContent = 'Story changed. Proof and release checks need a new saved revision.'; render();}}}, destroy: () => {generation++; element.remove();}};
}
