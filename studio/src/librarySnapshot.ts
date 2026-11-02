import type {Document, DraftingState, LibraryEntry, ReviewSnapshot} from './localCore';

export interface LibraryScopeSelection {
  contextSheets: string[];
  contextGroups: string[];
  targetSheets: string[];
  targetGroups: string[];
}
export interface CapturedLibraryScope { context: ReviewSnapshot[]; targets: ReviewSnapshot[]; ordered: ReviewSnapshot[]; bytes: number }

/** Resolve explicit references in library order and capture exact source once. */
export async function captureLibraryScope(
  state: DraftingState, selection: LibraryScopeSelection, active: {id: string; document: Document} | null,
  read: (path: string) => Promise<Document>, limit = 16000,
): Promise<CapturedLibraryScope> {
  const entries: LibraryEntry[] = state.library?.map(e => ({...e})) ?? [
    ...state.groups.map(g => ({id:g.id, kind:'group' as const, parentId:null})),
    ...state.scenes.map(s => ({id:s.id, kind:'scene' as const, parentId:s.groupId})),
  ];
  const scenes = new Map(state.scenes.map(scene => [scene.id, {...scene}]));
  const groups = new Set(state.groups.map(group => group.id));
  if (entries.length !== scenes.size + groups.size || new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('The library contains invalid references.');
  const validate = (ids: string[], known: Set<string>) => { if (ids.some(id => !known.has(id))) throw new Error('A selected library item is no longer available. Choose it again.'); };
  validate(selection.contextSheets, new Set(scenes.keys())); validate(selection.targetSheets, new Set(scenes.keys()));
  validate(selection.contextGroups, groups); validate(selection.targetGroups, groups);
  const contextSheets = new Set(selection.contextSheets); const targets = new Set(selection.targetSheets);
  const contextGroups = new Set(selection.contextGroups); const targetGroups = new Set(selection.targetGroups);
  if (active && !scenes.has(active.id)) throw new Error('The active sheet is no longer in the library.');
  if (active) contextSheets.add(active.id);
  const ordered: {id:string; context:boolean; target:boolean}[] = []; const seen = new Set<string>();
  function visit(parent: string | null, inContext: boolean, inTarget: boolean, ancestors: Set<string>) {
    for (const entry of entries.filter(value => value.parentId === parent)) {
      if (seen.has(entry.id)) throw new Error('The library contains duplicate references.');
      seen.add(entry.id);
      if (entry.kind === 'group') {
        if (!groups.has(entry.id) || ancestors.has(entry.id)) throw new Error('The library contains an invalid group.');
        const next = new Set(ancestors); next.add(entry.id);
        visit(entry.id, inContext || contextGroups.has(entry.id), inTarget || targetGroups.has(entry.id), next);
      } else {
        if (!scenes.has(entry.id)) throw new Error('The library contains a missing sheet.');
        ordered.push({id:entry.id, context:inContext || contextSheets.has(entry.id), target:inTarget || targets.has(entry.id)});
      }
    }
  }
  visit(null, false, false, new Set());
  if (seen.size !== scenes.size + groups.size) throw new Error('The library contains missing or cyclic references.');
  if (state.libraryLegacy) {
    const order = new Map(state.scenes.map((scene, index) => [scene.id, index]));
    ordered.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  }
  const selected = ordered.filter(item => item.context || item.target);
  if (!selected.some(item => item.target)) throw new Error('Choose at least one revision target.');
  // Copy the editor buffer before any asynchronous reads.
  const buffer = active ? {...active.document} : null;
  const snapshots = await Promise.all(selected.map(async item => {
    const scene = scenes.get(item.id)!;
    const doc = active?.id === item.id && buffer ? buffer : await read(scene.path);
    if (doc.path !== scene.path || doc.generatedCompatibility) throw new Error('A selected sheet is unavailable or is generated output.');
    return {path:doc.path, source:doc.text, sourceHash:doc.contentHash, sceneId:item.id};
  }));
  const bytes = snapshots.reduce((total, item) => total + new TextEncoder().encode(item.source).length, 0);
  if (bytes > limit) throw new Error(`The selected context and targets exceed ${limit.toLocaleString()} UTF-8 bytes. Choose fewer sheets.`);
  return {context:snapshots.filter((_, index) => selected[index].context), targets:snapshots.filter((_, index) => selected[index].target), ordered:snapshots, bytes};
}
