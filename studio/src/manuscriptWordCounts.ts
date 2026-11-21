import type {DraftingGroup, DraftingScene, LibraryEntry, LocalCore, Manuscript, RepositorySession} from './localCore';
import {wordCount} from './writingFeedback';

export type CountableManuscript = Manuscript | {project?: string; revision?: string | null; scenes: Pick<DraftingScene, 'path' | 'reference'>[]; groups?: DraftingGroup[]; library?: LibraryEntry[]};
export interface CountScene {path: string; title: string; groupIds: string[]}
export interface CountGroup {id: string; title: string; label: string; paths: string[]; source?: string}
export interface CountIndex {title: string; scenes: CountScene[]; groups: CountGroup[]}
export interface WordTotal {words: number; pending: number; unavailable: number; scenes: number}
export interface WordCountSnapshot {
  index: CountIndex | null;
  counts: ReadonlyMap<string, number>;
  pending: ReadonlySet<string>;
  current: {path: string; title: string; words: number; included: boolean} | null;
  activeGroupId: string | null;
}
const basename = (path: string) => path.split('/').pop() || path;

/** The manifest is the boundary. Never scan directories, references, exports or trash. */
export function indexWordCounts(book: CountableManuscript): CountIndex {
  const scenes = new Map<string, CountScene>();
  const groups: CountGroup[] = [];
  if ('scenes' in book) {
    const groupMap = new Map(book.groups?.map(group => [group.id, group]));
    const parents = new Map(book.library?.map(entry => [entry.id, entry.parentId]));
    const ancestors = (id: string | null | undefined) => {
      const found: string[] = [];
      while (id && groupMap.has(id) && !found.includes(id)) {found.push(id); id = parents.get(id);}
      return found.reverse();
    };
    for (const group of groupMap.values()) groups.push({id: group.id, title: group.title, label: ancestors(group.id).map(id => groupMap.get(id)!.title).join(' / '), paths: [], source: `__chapter__/${encodeURIComponent(group.id)}.md`});
    for (const item of book.scenes) {
      if (item.reference || scenes.has(item.path)) continue;
      const scene = item as Partial<DraftingScene> & {path: string};
      const groupIds = ancestors(scene.id && parents.has(scene.id) ? parents.get(scene.id) : scene.groupId);
      scenes.set(scene.path, {path: scene.path, title: scene.title || basename(scene.path), groupIds});
      for (const id of groupIds) groups.find(group => group.id === id)!.paths.push(scene.path);
    }
  } else {
    book.volumes.forEach((volume, vi) => {
      const parent: CountGroup = {id: `volume:${vi}`, title: volume.title, label: `Volume ${volume.number}: ${volume.title}`, paths: []};
      groups.push(parent);
      volume.chapters.forEach((chapter, ci) => {
        const group: CountGroup = {id: `chapter:${vi}:${ci}`, title: chapter.title, label: `${parent.label} / ${chapter.title}`, paths: [], source: chapter.source};
        groups.push(group);
        for (const scene of chapter.scenes) {
          if (!group.paths.includes(scene.path)) group.paths.push(scene.path);
          if (!parent.paths.includes(scene.path)) parent.paths.push(scene.path);
          const previous = scenes.get(scene.path);
          if (previous) previous.groupIds = [...new Set([...previous.groupIds, parent.id, group.id])];
          else scenes.set(scene.path, {path: scene.path, title: basename(scene.path), groupIds: [parent.id, group.id]});
        }
      });
    });
  }
  return {title: book.project || 'Manuscript', scenes: [...scenes.values()], groups};
}

export function wordTotal(snapshot: WordCountSnapshot, paths = snapshot.index?.scenes.map(scene => scene.path) ?? []): WordTotal {
  const unique = new Set(paths); let words = 0, pending = 0, unavailable = 0;
  for (const path of unique) {
    const count = snapshot.counts.get(path);
    if (count != null) words += count;
    else if (snapshot.pending.has(path)) pending++;
    else unavailable++;
  }
  return {words, pending, unavailable, scenes: unique.size};
}
export function formatWordTotal(total: WordTotal): string {
  const counted = total.scenes - total.pending - total.unavailable;
  const words = `${total.words.toLocaleString()} ${total.words === 1 ? 'word' : 'words'}`;
  if (total.pending && !counted) return 'Counting…';
  if (total.unavailable && !counted && !total.pending) return 'Count unavailable';
  return words + (total.pending ? ' (counting…)' : '') + (total.unavailable ? ` (${total.unavailable} unreadable; partial)` : '');
}

/** Stores numeric saved counts, plus only the open editor's buffers. Late reads cannot win. */
export function createManuscriptWordCounts(changed: () => void) {
  let index: CountIndex | null = null, bookKey = '', bufferKey = '', generation = 0, destroyed = false;
  let activePath: string | null = null, chapterSource: string | null = null;
  let source: {core: LocalCore; repository: RepositorySession; book: CountableManuscript} | null = null;
  const counts = new Map<string, number>(), revisions = new Map<string, number>();
  const pending = new Set<string>(), buffers = new Map<string, {text: string; words: number}>();
  function saved(key: string, path: string, text: string) {
    if (index && key === bookKey && index.scenes.some(scene => scene.path === path)) {
      counts.set(path, wordCount(text)); revisions.set(path, (revisions.get(path) ?? 0) + 1); pending.delete(path);
    }
  }
  function buffer(path: string, text: string) {
    if (buffers.get(path)?.text !== text) buffers.set(path, {text, words: wordCount(text)});
  }
  function snapshot(): WordCountSnapshot {
    const live = new Map(counts);
    if (bufferKey === bookKey && index) for (const scene of index.scenes) {
      const value = buffers.get(scene.path); if (value) live.set(scene.path, value.words);
    }
    const scene = index?.scenes.find(scene => scene.path === activePath);
    const current = activePath && buffers.get(activePath);
    return {index, counts: live, pending: new Set(pending), current: current ? {path: activePath!, title: scene?.title ?? basename(activePath!), words: current.words, included: bufferKey === bookKey && !!scene} : null,
      activeGroupId: chapterSource ? index?.groups.find(group => group.source === chapterSource)?.id ?? null : scene?.groupIds.at(-1) ?? null};
  }
  async function setManuscript(core: LocalCore, repository: RepositorySession, book: CountableManuscript) {
      source = {core, repository: {...repository}, book: structuredClone(book)};
      const request = ++generation; bookKey = repository.projectKey ?? ''; index = 'revision' in book && book.revision === null ? null : indexWordCounts(book);
      counts.clear(); revisions.clear(); pending.clear();
      for (const scene of index?.scenes ?? []) pending.add(scene.path);
      const queue = [...pending]; changed();
      // Managed projects lease the workspace for reads. Do not issue parallel reads here.
      for (const path of queue) {
        if (request !== generation || destroyed) return;
        const revision = revisions.get(path) ?? 0;
        try {
          const doc = await core.readDocument(repository.id, path);
          if (request !== generation || destroyed) return;
          if (doc.path !== path || doc.generatedCompatibility) throw Error('Not an editable source scene');
          if ((revisions.get(path) ?? 0) === revision) counts.set(path, wordCount(doc.text));
        } catch { /* A missing count is explicitly unavailable, never silently zero. */ }
        if (request !== generation || destroyed) return;
        pending.delete(path);
      }
      changed();
    }
  return {
    snapshot,
    clearScene() {buffers.clear(); activePath = null; chapterSource = null; changed();},
    clearManuscript() {generation++; source = null; index = null; counts.clear(); revisions.clear(); pending.clear(); bookKey = ''; changed();},
    openScene(key: string, path: string, text: string) {bufferKey = key; activePath = path; chapterSource = null; buffers.clear(); buffer(path, text); saved(key, path, text); changed();},
    changed(text: string) {if (activePath) {buffer(activePath, text); changed();}},
    openChapter(key: string, source: string, documents: {path: string; text: string}[]) {
      bufferKey = key; activePath = null; chapterSource = source; buffers.clear();
      for (const doc of documents) {saved(key, doc.path, doc.text); buffer(doc.path, doc.text);} changed();
    },
    changedChapter(documents: {path: string; text: string}[]) {for (const doc of documents) buffer(doc.path, doc.text); changed();},
    saved(key: string, path: string, text: string) {saved(key, path, text); changed();},
    setManuscript,
    refresh: () => source ? setManuscript(source.core, source.repository, source.book) : Promise.resolve(),
    destroy() {destroyed = true; generation++;},
  };
}
