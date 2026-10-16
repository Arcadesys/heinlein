/** Read-only, explicit manuscript search. Nothing is indexed or persisted. */
export interface SearchScene { path: string; title: string }
export interface SearchScope {
  key: string;
  title: string;
  scenes: SearchScene[];
  /** Capture the open buffer once, including unsaved edits. Other scenes use disk. */
  buffer?: { path: string; text: string };
  read(path: string): Promise<string>;
}
export interface SearchMatch extends SearchScene { from: number; to: number; line: number; excerpt: string }
export const SEARCH_LIMITS = { query: 256, scenes: 500, sceneChars: 2_000_000, totalChars: 8_000_000, results: 200 };

/** Escaped Unicode regex preserves original UTF-16 offsets even when case folding changes length. */
export function literalMatches(source: string, query: string, matchCase: boolean, limit = SEARCH_LIMITS.results): Omit<SearchMatch, keyof SearchScene>[] {
  if (!query || query.length > SEARCH_LIMITS.query || limit <= 0) return [];
  const pattern = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'gu' : 'giu');
  const matches: Omit<SearchMatch, keyof SearchScene>[] = [];
  let line = 1; let scanned = 0;
  for (const match of source.matchAll(pattern)) {
    const from = match.index!; const to = from + match[0].length;
    for (; scanned < from; scanned++) {
      if (source[scanned] === '\n' || (source[scanned] === '\r' && source[scanned + 1] !== '\n')) line++;
    }
    const start = Math.max(0, from - 48); const end = Math.min(source.length, to + 80);
    matches.push({from, to, line, excerpt: `${start ? '…' : ''}${source.slice(start, end).replace(/\r\n|\r|\n/g, ' ')}${end < source.length ? '…' : ''}`});
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Convert raw UTF-16 positions into CodeMirror's newline-normalized positions. */
export function editorOffset(source: string, raw: number): number {
  return source.slice(0, raw).replace(/\r\n|\r/g, '\n').length;
}

export function createManuscriptSearch(host: HTMLElement, hooks: {
  scope(): SearchScope | null;
  openResult(match: SearchMatch, source: string, scopeKey: string): void;
  closed(): void;
}) {
  let panel: HTMLElement | null = null;
  let epoch = 0;
  let input: HTMLInputElement; let matchCase: HTMLInputElement; let status: HTMLElement; let list: HTMLElement; let cancel: HTMLButtonElement;
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') {
    const element = document.createElement(tag); element.textContent = text; element.className = className; return element;
  }
  function close() { epoch++; if (!panel) return; panel.remove(); panel = null; hooks.closed(); }
  function invalidate(message = 'Search changed. Choose Search to refresh results.') {
    epoch++; if (!panel) return;
    list.replaceChildren(); cancel.hidden = true; status.textContent = message;
  }
  async function search() {
    invalidate();
    const query = input.value; const exactCase = matchCase.checked;
    const scope = hooks.scope();
    if (!scope) { status.textContent = 'Open a manuscript to search its scenes.'; return; }
    if (!query || query.length > SEARCH_LIMITS.query) { status.textContent = `Enter 1–${SEARCH_LIMITS.query} characters to find.`; return; }
    const request = epoch;
    const active = () => panel !== null && epoch === request;
    const current = () => {
      if (!active()) return false;
      if (hooks.scope()?.key !== scope.key) { invalidate('The manuscript changed. Choose Search to refresh results.'); return false; }
      return true;
    };
    const scenes = [...new Map(scope.scenes.map(scene => [scene.path, scene])).values()];
    let count = 0; let scanned = 0; let unreadable = 0; let oversized = 0; let chars = 0; let bounded = scenes.length > SEARCH_LIMITS.scenes;
    cancel.hidden = false; status.textContent = `Searching ${scope.title}…`;
    try {
      for (const scene of scenes.slice(0, SEARCH_LIMITS.scenes)) {
        // Yield between scenes even for cached IPC reads, keeping typing and Cancel responsive.
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!current()) return;
        let source: string;
        try { source = scope.buffer?.path === scene.path ? scope.buffer.text : await scope.read(scene.path); }
        catch { if (!current()) return; unreadable++; continue; }
        if (!current()) return;
        if (source.length > SEARCH_LIMITS.sceneChars) { oversized++; continue; }
        if (chars + source.length > SEARCH_LIMITS.totalChars) { bounded = true; break; }
        chars += source.length; scanned++;
        const matches = literalMatches(source, query, exactCase, SEARCH_LIMITS.results - count);
        for (const match of matches) {
          const result: SearchMatch = {...scene, ...match};
          const item = node('li'); const button = node('button', '', 'manuscript-search-result'); button.type = 'button';
          button.append(node('strong', `${scene.title} · line ${match.line}`), node('span', scene.path, 'path'), node('span', match.excerpt));
          button.addEventListener('click', () => {
            if (!current()) return;
            close(); hooks.openResult(result, source, scope.key);
          });
          item.append(button); list.append(item); count++;
        }
        status.textContent = `${count} results · ${scanned} of ${scenes.length} scenes searched…`;
        if (count >= SEARCH_LIMITS.results) { bounded = true; break; }
      }
      if (!current()) return;
      status.textContent = `${count ? `${count} results` : 'No matches'} · ${scanned} of ${scenes.length} scenes searched.${unreadable ? ` ${unreadable} unreadable scenes skipped.` : ''}${oversized ? ` ${oversized} oversized scenes skipped.` : ''}${bounded ? ' Search limit reached; narrow your query.' : ''} Results are snapshots; search again after edits.`;
    } finally { if (active()) cancel.hidden = true; }
  }
  function open() {
    if (panel) { input.focus(); return; }
    panel = node('section', '', 'manuscript-search'); panel.setAttribute('aria-label', 'Find in manuscript');
    const heading = node('div', '', 'card-head'); const closeButton = node('button', 'Close'); closeButton.type = 'button'; closeButton.setAttribute('aria-label', 'Close manuscript search'); closeButton.addEventListener('click', close);
    heading.append(node('h2', 'Find in manuscript'), closeButton);
    const description = node('p', 'Local literal search across the selected manuscript. Includes the open buffer and saved text in other scenes. Nothing is sent to AI.', 'muted');
    const form = node('form'); input = node('input'); input.type = 'search'; input.maxLength = SEARCH_LIMITS.query; input.setAttribute('aria-label', 'Find text in manuscript');
    input.addEventListener('input', () => invalidate());
    const label = node('label'); matchCase = node('input'); matchCase.type = 'checkbox'; matchCase.addEventListener('change', () => invalidate()); label.append(matchCase, ' Match case');
    const submit = node('button', 'Search'); submit.type = 'submit';
    cancel = node('button', 'Cancel search'); cancel.type = 'button'; cancel.hidden = true; cancel.addEventListener('click', () => invalidate('Search canceled.'));
    form.append(input, label, submit, cancel); form.addEventListener('submit', event => { event.preventDefault(); void search(); });
    status = node('p', 'Enter text and choose Search.'); status.setAttribute('role', 'status');
    list = node('ol'); list.setAttribute('aria-label', 'Manuscript search results');
    panel.append(heading, description, form, status, list);
    panel.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(); } });
    host.append(panel); input.focus();
  }
  return {open, close, invalidate, isOpen: () => panel !== null};
}
