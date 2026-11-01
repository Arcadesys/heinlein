import type {MoveSource, MoveTarget} from './manuscriptMoves';
import type {DraftingState} from './localCore';

export interface BinderHooks {
  state(): DraftingState | null;
  currentPath(): string | null;
  open(path: string): void;
  bindMoveSource?(node: HTMLElement, source: MoveSource): void;
  bindMoveTarget?(node: HTMLElement, resolve: (source: MoveSource, event: DragEvent) => MoveTarget | null, label: string): void;
}

const NO_CHAPTER = '';
const basename = (path: string) => path.split('/').pop() || path;

/** Chapters and scenes share the drafting panel’s local move and undo flow. */
export function createBinderTree(hooks: BinderHooks) {
  const element = document.createElement('nav'); element.className = 'binder-tree'; element.setAttribute('aria-label', 'Chapters and scenes');
  const heading = document.createElement('h3'); heading.className = 'binder-heading'; heading.textContent = 'Chapters and scenes';
  const list = document.createElement('ul'); list.className = 'binder-list';
  element.append(heading, list);
  const expanded = new Set<string>(); let lastCurrentChapter: string | null = null; let seeded = false;

  function refresh() {
    const state = hooks.state(); const current = hooks.currentPath();
    list.replaceChildren(); element.hidden = !state || (!state.groups.length && !state.scenes.length);
    if (!state) return;
    const currentScene = state.scenes.find(scene => scene.path === current);
    const currentChapter = currentScene ? currentScene.groupId ?? NO_CHAPTER : null;
    // Follow the author into a new chapter once, then respect any manual collapse.
    if (currentChapter !== null && currentChapter !== lastCurrentChapter) expanded.add(currentChapter);
    lastCurrentChapter = currentChapter;
    // With nothing open yet, show the first chapter that has scenes so there is always a way in.
    if (!seeded && state.scenes.length) { seeded = true; if (currentChapter === null) expanded.add(state.scenes[0].groupId ?? NO_CHAPTER); }
    const sections = [...state.groups.map(group => ({id: group.id, title: group.title})),
      ...(state.scenes.some(scene => !scene.groupId) ? [{id: NO_CHAPTER, title: 'No chapter'}] : [])];
    for (const section of sections) {
      const scenes = state.scenes.filter(scene => (scene.groupId ?? NO_CHAPTER) === section.id);
      const item = document.createElement('li'); item.className = 'binder-chapter';
      const isOpen = expanded.has(section.id);
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'binder-chapter-toggle'; toggle.dataset.chapterId = section.id;
      toggle.setAttribute('aria-expanded', String(isOpen));
      const arrow = document.createElement('span'); arrow.className = 'binder-arrow'; arrow.setAttribute('aria-hidden', 'true'); arrow.textContent = isOpen ? '▾' : '▸';
      const title = document.createElement('span'); title.className = 'binder-title'; title.textContent = section.title;
      const count = document.createElement('span'); count.className = 'binder-count'; count.textContent = `${scenes.length} ${scenes.length === 1 ? 'scene' : 'scenes'}`;
      toggle.append(arrow, title, count);
      toggle.addEventListener('click', () => { if (expanded.has(section.id)) expanded.delete(section.id); else expanded.add(section.id); refresh(); });
      hooks.bindMoveTarget?.(toggle, source => source.kind === 'scene'
        ? section.id === NO_CHAPTER ? {kind: 'ungroupedEnd'} : {kind: 'groupEnd', id: section.id}
        : null, `Drop a scene into ${section.title}`);
      item.append(toggle);
      if (isOpen) {
        const inner = document.createElement('ul'); inner.className = 'binder-scenes';
        if (!scenes.length) { const empty = document.createElement('li'); empty.className = 'binder-empty muted'; empty.textContent = 'No scenes yet.'; inner.append(empty); }
        for (const scene of scenes) {
          const row = document.createElement('li');
          const open = document.createElement('button'); open.type = 'button'; open.className = 'binder-scene';
          const label = document.createElement('span'); label.textContent = scene.title || basename(scene.path); open.append(label);
          if (scene.path === current) {
            open.setAttribute('aria-current', 'true');
            const here = document.createElement('span'); here.className = 'binder-here'; here.textContent = 'You are here'; open.append(here);
          }
          hooks.bindMoveSource?.(open, {kind: 'scene', id: scene.id});
          open.title = 'Drag onto a chapter to move this scene.';
          open.addEventListener('click', () => hooks.open(scene.path));
          row.append(open); inner.append(row);
        }
        item.append(inner);
      }
      list.append(item);
    }
  }
  return {element, refresh};
}
