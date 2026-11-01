import type {LocalCore, Manuscript, RepositorySession} from './localCore';
import {createDailyGoalTracker, createTypewriterSound, wordCount, type TypewriterKey} from './writingFeedback';

export interface WritingSummary { sceneWords: number | null; credited: number; goal: number }
export function createWritingPanel(rendered?: (summary: WritingSummary) => void) {
  const element = document.createElement('section'); element.className = 'writing-panel'; element.setAttribute('aria-label', 'Writing progress');
  const scene = document.createElement('span'); const manuscript = document.createElement('span');
  const progressLabel = document.createElement('span');
  const progress = document.createElement('progress'); progress.setAttribute('aria-label', 'Daily writing goal');
  const goalLabel = document.createElement('label'); goalLabel.textContent = 'Daily goal';
  const goalInput = document.createElement('input'); goalInput.type = 'number'; goalInput.min = '1'; goalInput.max = '1000000'; goalInput.step = '100'; goalInput.setAttribute('aria-label', 'Daily word goal'); goalLabel.append(goalInput);
  const soundButton = document.createElement('button'); soundButton.type = 'button'; soundButton.textContent = 'Typewriter sound: off'; soundButton.setAttribute('aria-pressed','false');
  const error = document.createElement('span'); error.className = 'writing-error'; error.setAttribute('role','status');
  const help = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'How progress is counted';
  const explanation = document.createElement('p'); explanation.textContent = 'Daily growth credited above each scene’s earlier peak. Deletions keep earned progress; undo, redo, loading, and recovery earn none. Rewriting below an earlier peak, complex replacements, and multi-cursor edits may not add credit. Opening frontmatter is excluded. Days follow this computer’s local date. Goal history stays on this device; typewriter sounds start off each launch.';
  help.append(summary,explanation); element.append(scene,manuscript,progressLabel,progress,goalLabel,soundButton,error,help);
  const tracker = createDailyGoalTracker(); const sound = createTypewriterSound();
  let active: {projectKey:string; path:string; text:string; count:number; sceneKey:string} | null = null;
  let bookKey = ''; let generation = 0; let loading = false; let failed = 0; let destroyed = false;
  const counts = new Map<string,number>(); const revisions = new Map<string,number>(); let paths = new Set<string>();
  function render() {
    if (destroyed) return;
    scene.textContent = `Scene: ${active ? active.count.toLocaleString() : '—'} words`;
    manuscript.textContent = paths.size ? `Manuscript: ${[...counts.entries()].reduce((sum,[path,count])=>sum+(active?.projectKey===bookKey&&active.path===path?active.count:count),0).toLocaleString()} words${loading ? ' (counting…)' : failed ? ` (${failed} unreadable; partial)` : ''}` : 'Manuscript: —';
    const state = tracker.snapshot(); goalInput.value = String(state.goal); progress.max=state.goal; progress.value=Math.min(state.words,state.goal);
    progressLabel.textContent = `${state.words.toLocaleString()} / ${state.goal.toLocaleString()} daily growth credited`;
    if (!state.persistenceAvailable) error.textContent = 'Goal progress is session-only: local storage unavailable.';
    rendered?.({sceneWords: active ? active.count : null, credited: state.words, goal: state.goal});
  }
  goalInput.addEventListener('change',()=>{const value=Number(goalInput.value); if(Number.isInteger(value)&&value>=1&&value<=1000000)tracker.setGoal(value); render();});
  const soundControls: {button: HTMLButtonElement; slider?: HTMLInputElement}[] = [{button: soundButton}];
  function syncSound() {
    for (const {button, slider} of soundControls) {
      button.textContent = `Typewriter sound: ${sound.enabled() ? 'on' : 'off'}`;
      button.setAttribute('aria-pressed', String(sound.enabled()));
      if (slider) { slider.value = String(Math.round(sound.volume() * 100)); slider.setAttribute('aria-valuetext', `${slider.value}%`); }
    }
  }
  function toggleSound() {
    const requested = !sound.enabled();
    void sound.setEnabled(requested).then(enabled => {
      if (destroyed) return;
      syncSound();
      error.textContent = requested && !enabled ? 'Audio unavailable; writing still works.' : '';
      if (enabled) sound.play();
    });
  }
  soundButton.addEventListener('click', toggleSound);
  const timer = setInterval(render,60000);
  render();
  return {
    element,
    soundSettings() {
      const controls = document.createElement('div'); controls.className = 'settings-group';
      const toggle = document.createElement('button'); toggle.type = 'button';
      toggle.addEventListener('click', toggleSound);
      const label = document.createElement('label'); label.textContent = 'Typewriter volume ';
      const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '1';
      slider.setAttribute('aria-label', 'Typewriter volume');
      slider.addEventListener('input', () => { sound.setVolume(Number(slider.value) / 100); syncSound(); });
      slider.addEventListener('change', () => sound.play());
      label.append(slider);
      const note = document.createElement('p'); note.className = 'settings-hint';
      note.textContent = 'Mechanical clicks, backspace and carriage return. Off each launch. Paste, undo and loading stay silent.';
      controls.append(toggle, label, note); soundControls.push({button: toggle, slider}); syncSound();
      return controls;
    },
    typed(kind: TypewriterKey) {
      const enabled = sound.enabled(); sound.play(kind);
      if (enabled && !sound.enabled()) { syncSound(); error.textContent = 'Audio unavailable; writing still works.'; }
    },
    focusGoal() { goalInput.focus(); goalInput.select(); },
    clearScene() { active=null; render(); },
    clearManuscript() { generation++; paths=new Set(); counts.clear(); loading=false; failed=0; bookKey=''; render(); },
    openScene(projectKey:string, path:string, text:string, sceneId?:string) {
      const sceneKey=sceneId ? `scene:${sceneId}` : path;
      active={projectKey,path,text,count:wordCount(text),sceneKey}; if(projectKey)tracker.loadScene(`${projectKey}:${sceneKey}`,text);
      if(projectKey===bookKey&&paths.has(path)){counts.set(path,wordCount(text)); revisions.set(path,(revisions.get(path)??0)+1);} render();
    },
    saved(projectKey:string, path:string, text:string) {
      if(projectKey===bookKey&&paths.has(path)){counts.set(path,wordCount(text)); revisions.set(path,(revisions.get(path)??0)+1);} render();
    },
    changed(before:string, after:string, origin:'user'|'history'|'programmatic'|'recovery') {
      if(!active)return; active.text=after; active.count=wordCount(after);
      if(active.projectKey)tracker.recordChange(`${active.projectKey}:${active.sceneKey}`,before,after,origin);
      render();
    },
    async setManuscript(core:LocalCore, repository:RepositorySession, book:Manuscript | {scenes: {path:string}[]}) {
      const request=++generation; bookKey=repository.projectKey??''; counts.clear(); revisions.clear(); failed=0; loading=true;
      paths=new Set('scenes' in book ? book.scenes.map(s=>s.path) : book.volumes.flatMap(v=>v.chapters.flatMap(c=>c.scenes.map(s=>s.path))));
      const queue=[...paths]; render();
      await Promise.all(Array.from({length:Math.min(3,queue.length)},async()=>{
        while(queue.length&&request===generation&&!destroyed){ const path=queue.shift()!; const revision=revisions.get(path)??0;
          try { const doc=await core.readDocument(repository.id,path); if(request!==generation||destroyed)return;
            if((revisions.get(path)??0)===revision)counts.set(path,wordCount(doc.text));
          } catch {if(request===generation)failed++;}
        }
      }));
      if(request===generation&&!destroyed){loading=false; render();}
    },
    destroy(){destroyed=true; generation++; clearInterval(timer); sound.destroy();},
  };
}
