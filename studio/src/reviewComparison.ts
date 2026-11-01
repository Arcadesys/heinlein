// Display-only helpers for the review panel. Nothing here produces or alters a patch:
// byte ranges and the native host remain authority, and these strings are never sent back.
import type {ReviewEdit} from './localCore';

const encoder = new TextEncoder();
const CONTEXT_BYTES = 240;
const continuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);

export interface PatchContext {before: string; after: string; cutBefore: boolean; cutAfter: boolean}

/** Surrounding raw text, only when these exact bytes still hold the suggestion's original text. */
export function patchContext(source: string, fromUtf8: number, toUtf8: number, original: string, windowBytes = CONTEXT_BYTES): PatchContext | null {
  const data = encoder.encode(source);
  if (fromUtf8 < 0 || toUtf8 < fromUtf8 || toUtf8 > data.length) return null;
  try {
    if (decode(data.slice(fromUtf8, toUtf8)) !== original) return null;
    let start = Math.max(0, fromUtf8 - windowBytes), end = Math.min(data.length, toUtf8 + windowBytes);
    while (start < fromUtf8 && continuation(data[start])) start++;
    while (end > toUtf8 && continuation(data[end])) end--;
    let before = decode(data.slice(start, fromUtf8)), after = decode(data.slice(toUtf8, end));
    let cutBefore = start > 0, cutAfter = end < data.length;
    const paragraphBefore = [...before.matchAll(/\r?\n[^\S\r\n]*\r?\n/g)].at(-1);
    if (paragraphBefore) {before = before.slice(paragraphBefore.index + paragraphBefore[0].length); cutBefore = true;}
    const paragraphAfter = after.search(/\r?\n[^\S\r\n]*\r?\n/);
    if (paragraphAfter >= 0) {after = after.slice(0, paragraphAfter); cutAfter = true;}
    return {before, after, cutBefore, cutAfter};
  } catch { return null; }
}

function words(text: string): string[] {
  const Segmenter = (Intl as unknown as {Segmenter?: typeof Intl.Segmenter}).Segmenter;
  return Segmenter ? [...new Segmenter(undefined, {granularity: 'word'}).segment(text)].map(part => part.segment) : [text];
}
export interface ChangedSpan {prefix: string; removed: string; added: string; suffix: string}

/** Narrows emphasis to the changed words. The four parts always rejoin to the exact inputs. */
export function changedSpan(original: string, replacement: string): ChangedSpan {
  const a = words(original), b = words(replacement);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return {prefix: a.slice(0, head).join(''), removed: a.slice(head, a.length - tail).join(''), added: b.slice(head, b.length - tail).join(''), suffix: a.slice(a.length - tail).join('')};
}

const invisible: [RegExp, string, string][] = [[/\r\n/y, 'CRLF line break', 'CRLF line breaks'], [/\n/y, 'LF line break', 'LF line breaks'], [/\r/y, 'CR line break', 'CR line breaks'], [/\t/y, 'tab', 'tabs'], [/\u00a0/y, 'non-breaking space', 'non-breaking spaces'], [/\u2028/y, 'line separator', 'line separators'], [/\u2029/y, 'paragraph separator', 'paragraph separators'], [/ /y, 'space', 'spaces'], [/\s/y, 'other space character', 'other space characters']];
function describeInvisible(text: string) {
  const counts = new Map<number, number>();
  let at = 0;
  while (at < text.length) {
    const index = invisible.findIndex(([pattern]) => {pattern.lastIndex = at; return pattern.test(text);});
    if (index < 0) {at++; continue;}
    counts.set(index, (counts.get(index) ?? 0) + 1); at = invisible[index][0].lastIndex;
  }
  return [...counts].map(([index, count]) => `${count} ${count === 1 ? invisible[index][1] : invisible[index][2]}`).join(', ');
}
/** Plain-language note for edits a reader cannot see in rendered text. Null when the change is visible. */
export function invisibleChangeNote(original: string, replacement: string): string | null {
  const {removed, added} = changedSpan(original, replacement);
  if (/\S/.test(removed) || /\S/.test(added)) return null;
  const parts = [removed && `removes ${describeInvisible(removed)}`, added && `adds ${describeInvisible(added)}`].filter(Boolean);
  return parts.length ? `This suggestion only changes spacing or line breaks: it ${parts.join(' and ')}.` : null;
}

/**
 * The same accepted-edit sum the native host uses to place a later patch. It never reads current text.
 * Native sums before the target is accepted; this also places accepted edits, so a target never counts itself.
 */
export function lineageDelta(edits: readonly ReviewEdit[], edit: ReviewEdit) {
  return edits.filter(e => e.id !== edit.id && e.status === 'accepted' && e.path === edit.path && e.toUtf8 <= edit.fromUtf8).reduce((n, e) => n + encoder.encode(e.replacement).length - encoder.encode(e.original).length, 0);
}

export const waiting = (edit: Pick<ReviewEdit, 'status'>) => edit.status === 'pending' || edit.status === 'prepared';

const decisions: Partial<Record<ReviewEdit['status'], string>> = {
  accepted: 'Applied after your confirmation',
  rejected: 'Rejected by you · not applied',
  supersededByAuthorChoice: 'Not applied · you approved a competing alternative',
  blockedByAppliedDecision: 'Blocked · depends on text you already changed',
};
export const decisionLabel = (status: ReviewEdit['status']) => decisions[status] ?? 'Waiting for your decision';

export function pendingLabel(edit: Pick<ReviewEdit, 'sourceStale' | 'conflictGroup' | 'selected'>) {
  if (edit.sourceStale) return 'Source changed · cannot be approved';
  if (edit.conflictGroup) return edit.selected ? 'Your selected alternative · not applied yet' : 'Competing alternative · choose one to approve';
  return 'Waiting for your decision';
}

export function reviewProgress(edits: Pick<ReviewEdit, 'status'>[]) {
  const count = (test: (edit: Pick<ReviewEdit, 'status'>) => boolean) => edits.filter(test).length;
  const parts: [number, string][] = [[count(waiting), 'waiting for your decision'], [count(e => e.status === 'accepted'), 'applied'], [count(e => e.status === 'rejected'), 'rejected'], [count(e => e.status === 'supersededByAuthorChoice'), 'replaced by your choice'], [count(e => e.status === 'blockedByAppliedDecision'), 'blocked']];
  const detail = parts.filter(([n]) => n).map(([n, label]) => `${n} ${label}`).join(' · ');
  return `${edits.length} ${edits.length === 1 ? 'suggestion' : 'suggestions'}${detail ? `: ${detail}` : ''}`;
}
