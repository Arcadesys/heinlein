import type {DraftingState, LibraryEntry} from './localCore';

/** Display discovered references alongside indexed sheets, without a write on open. */
export function withReferenceSheets(state: DraftingState): DraftingState {
  const references = (state.referenceSheets ?? []).filter(sheet => !state.scenes.some(scene => scene.path === sheet.path));
  if (!references.length) return state;
  const library: LibraryEntry[] = state.library ? [...state.library] : [
    ...state.groups.map(group => ({id: group.id, kind: 'group' as const, parentId: null})),
    ...state.scenes.map(scene => ({id: scene.id, kind: 'scene' as const, parentId: scene.groupId})),
  ];
  library.push(...references.map(scene => ({id: scene.id, kind: 'scene' as const, parentId: scene.groupId})));
  return {...state, scenes: [...state.scenes, ...references], library};
}
