/** Local-only writing feedback. No manuscript text is stored by this module. */
export const DEFAULT_DAILY_GOAL = 1000;
export const WRITING_STORAGE_KEY = 'heinlein-studio-writing-v1';

/** Strip a complete, opening YAML/JSON frontmatter fence, leaving source untouched. */
export function proseText(source: string): string {
  const opening = /^(?:\uFEFF)?---[\t ]*(?:\r\n|\r|\n)/.exec(source);
  if (!opening) return source;
  const rest = source.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[\t ]*(?:\r\n|\r|\n|$)/m.exec(rest);
  // An unfinished fence may be prose. Do not hide the whole document while typing.
  return closing ? rest.slice(closing.index + closing[0].length) : source;
}

let segmenter: Intl.Segmenter | undefined;
/** Counts Unicode word-like segments; punctuation and Markdown markers do not count. */
export function wordCount(source: string): number {
  const prose = proseText(source);
  if (typeof Intl.Segmenter === 'function') {
    segmenter ??= new Intl.Segmenter(undefined, {granularity: 'word'});
    let words = 0;
    for (const segment of segmenter.segment(prose)) if (segment.isWordLike) words++;
    return words;
  }
  return prose.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*(?:['’][\p{L}\p{N}\p{M}]+)*/gu)?.length ?? 0;
}

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
export type WritingChangeOrigin = 'user' | 'history' | 'programmatic' | 'recovery';
export interface DailyGoalSnapshot {
  date: string;
  words: number;
  goal: number;
  remaining: number;
  complete: boolean;
  persistenceAvailable: boolean;
}
interface SceneProgress { peak: number; words: number }
interface StoredProgress { version: 1; goal: number; days: Record<string, Record<string, SceneProgress>> }
export interface DailyGoalOptions {
  /** Pass null for an explicitly in-memory tracker (for example, a private session). */
  storage?: StorageLike | null;
  now?: () => Date;
  onStorageError?: (error: unknown) => void;
}
const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validGoal = (value: unknown): value is number => validCount(value) && value > 0 && value <= 1_000_000;
const emptyRecord = <T>(): Record<string, T> => Object.create(null) as Record<string, T>;

function readProgress(raw: string | null): StoredProgress {
  const fresh: StoredProgress = {version: 1, goal: DEFAULT_DAILY_GOAL, days: emptyRecord()};
  if (!raw) return fresh;
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') return fresh;
  const candidate = value as Partial<StoredProgress>;
  if (candidate.version !== 1) return fresh;
  if (validGoal(candidate.goal)) fresh.goal = candidate.goal;
  if (!candidate.days || typeof candidate.days !== 'object') return fresh;
  for (const [date, scenes] of Object.entries(candidate.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !scenes || typeof scenes !== 'object') continue;
    const checked = emptyRecord<SceneProgress>();
    for (const [key, scene] of Object.entries(scenes)) {
      if (scene && validCount(scene.peak) && validCount(scene.words) && scene.words <= scene.peak) {
        checked[key] = {peak: scene.peak, words: scene.words};
      }
    }
    fresh.days[date] = checked;
  }
  return fresh;
}

/**
 * A conservative, additive daily goal: each scene earns words only above its daily
 * high-water mark. Deleting never removes credit; retyping to an old peak, undo,
 * redo, recovery, loads and programmatic changes never earn duplicate credit.
 * Rewrites below the peak intentionally earn nothing. Without transaction ranges,
 * ambiguous replacements/multi-range changes also earn nothing: only a provable
 * single insertion is credited. Use a stable repository + scene identity, and
 * annotate history/recovery rather than treating it as typing.
 */
export function createDailyGoalTracker(options: DailyGoalOptions = {}) {
  let storage: StorageLike | null = null;
  let persistenceAvailable = false;
  const failed = (error: unknown) => {
    persistenceAvailable = false;
    options.onStorageError?.(error);
  };
  try {
    storage = options.storage === undefined ? globalThis.localStorage : options.storage;
    persistenceAvailable = !!storage;
  } catch (error) { failed(error); }
  let raw: string | null = null;
  try { raw = storage?.getItem(WRITING_STORAGE_KEY) ?? null; }
  catch (error) {
    // A read-denied store may still contain progress. Never overwrite unseen data.
    storage = null;
    failed(error);
  }
  let data: StoredProgress;
  try { data = readProgress(raw); }
  catch (error) { data = readProgress(null); failed(error); }
  const now = options.now ?? (() => new Date());
  const day = () => localDateKey(now());
  const persist = () => {
    // Goals need recent daily baselines, not an ever-growing activity archive.
    const current = day();
    const keep = new Set([current, ...Object.keys(data.days).filter(date => date !== current).sort().slice(-30)]);
    for (const date of Object.keys(data.days)) if (!keep.has(date)) delete data.days[date];
    if (!storage) return;
    try { storage.setItem(WRITING_STORAGE_KEY, JSON.stringify(data)); persistenceAvailable = true; }
    catch (error) { failed(error); }
  };
  const scenesFor = (date: string) => data.days[date] ??= emptyRecord<SceneProgress>();
  const snapshotFor = (date: string): DailyGoalSnapshot => {
    const words = Object.values(data.days[date] ?? {}).reduce((sum, scene) => sum + scene.words, 0);
    return {date, words, goal: data.goal, remaining: Math.max(0, data.goal - words), complete: words >= data.goal, persistenceAvailable};
  };
  return {
    snapshot(): DailyGoalSnapshot { return snapshotFor(day()); },
    /** Returns the unchanged snapshot for an invalid goal. */
    setGoal(goal: number): DailyGoalSnapshot {
      if (validGoal(goal) && goal !== data.goal) { data.goal = goal; persist(); }
      return snapshotFor(day());
    },
    loadScene(sceneKey: string, source: string): DailyGoalSnapshot {
      const date = day();
      const scenes = scenesFor(date);
      const count = wordCount(source);
      const previous = scenes[sceneKey];
      const peak = Math.max(previous?.peak ?? 0, count);
      scenes[sceneKey] = {peak, words: previous?.words ?? 0};
      if (!previous || previous.peak !== peak) persist();
      return snapshotFor(date);
    },
    recordChange(sceneKey: string, before: string, after: string, origin: WritingChangeOrigin = 'user'): DailyGoalSnapshot {
      const date = day();
      const scenes = scenesFor(date);
      const oldCount = wordCount(before);
      const newCount = wordCount(after);
      const previous = scenes[sceneKey];
      // The before-text is the baseline on a new day or a previously unseen scene.
      const peak = Math.max(previous?.peak ?? 0, oldCount);
      // Before/after text cannot reliably identify all inserted ranges. Credit only
      // a provable single insertion, bounded by its word-like text. Replacements or
      // multi-cursor edits may undercount, but unchanged middle prose cannot become
      // false credit when several whitespace/punctuation edits split old words.
      let insertedWords = 0;
      if (origin === 'user' && newCount > peak) {
        let start = 0;
        while (start < before.length && start < after.length && before[start] === after[start]) start++;
        let oldEnd = before.length, newEnd = after.length;
        while (oldEnd > start && newEnd > start && before[oldEnd - 1] === after[newEnd - 1]) { oldEnd--; newEnd--; }
        if (oldEnd === start) insertedWords = wordCount(after.slice(start, newEnd));
      }
      const earned = origin === 'user' ? Math.min(Math.max(0, newCount - peak), insertedWords) : 0;
      const nextPeak = Math.max(peak, newCount);
      scenes[sceneKey] = {peak: nextPeak, words: (previous?.words ?? 0) + earned};
      if (!previous || previous.peak !== nextPeak || earned > 0) persist();
      return snapshotFor(date);
    },
  };
}

export type TypewriterKey = 'key' | 'delete' | 'return';
export interface TypewriterSoundOptions { createContext?: () => AudioContext }
/** Off by default. Call setEnabled(true) directly from a user click/tap gesture. */
export function createTypewriterSound(options: TypewriterSoundOptions = {}) {
  let context: AudioContext | undefined;
  let enabled = false;
  let generation = 0;
  let lastClick = -Infinity;
  let volume = 0.5;
  const buffers = new Map<TypewriterKey, AudioBuffer>();
  const makeContext = options.createContext ?? (() => {
    const Audio = globalThis.AudioContext ?? (globalThis as typeof globalThis & {webkitAudioContext?: typeof AudioContext}).webkitAudioContext;
    if (!Audio) throw new Error('Web Audio is unavailable');
    return new Audio();
  });
  return {
    enabled: () => enabled,
    async setEnabled(value: boolean): Promise<boolean> {
      const request = ++generation;
      enabled = false;
      if (!value) return false;
      try {
        if (!context || context.state === 'closed') { context = makeContext(); lastClick = -Infinity; buffers.clear(); }
        if (context.state === 'suspended') await context.resume();
        if (request !== generation) return enabled;
        enabled = context.state === 'running';
      } catch { if (request === generation) enabled = false; }
      return enabled;
    },
    volume: () => volume,
    setVolume(value: number): void { if (Number.isFinite(value)) volume = Math.max(0, Math.min(1, value)); },
    play(kind: TypewriterKey = 'key'): void {
      if (!enabled || volume === 0 || !context || context.state !== 'running' || context.currentTime - lastClick < 0.025) return;
      try {
        lastClick = context.currentTime;
        // Reuse each mechanical strike and release after its first playback.
        let buffer = buffers.get(kind);
        if (!buffer) {
          const duration = kind === 'return' ? 0.16 : kind === 'delete' ? 0.045 : 0.035;
          buffer = context.createBuffer(1, Math.ceil(context.sampleRate * duration), context.sampleRate);
          const samples = buffer.getChannelData(0);
          const frequency = kind === 'return' ? 1650 : kind === 'delete' ? 850 : 1150;
          for (let i = 0; i < samples.length; i++) {
            const t = i / context.sampleRate;
            const strike = Math.exp(-t * 240);
            const release = t > 0.014 ? 0.35 * Math.exp(-(t - 0.014) * 180) : 0;
            const ring = kind === 'return' ? 0.4 * Math.sin(2 * Math.PI * frequency * t) * Math.exp(-t * 32) : 0;
            samples[i] = (Math.random() * 2 - 1) * (strike + release) + ring;
          }
          buffers.set(kind, buffer);
        }
        const source = context.createBufferSource();
        const gain = context.createGain();
        gain.gain.value = 0.05 * volume;
        source.buffer = buffer;
        source.connect(gain);
        gain.connect(context.destination);
        source.onended = () => { source.disconnect(); gain.disconnect(); };
        source.start();
      } catch { enabled = false; }
    },
    destroy(): void {
      generation++;
      enabled = false;
      try { if (context && context.state !== 'closed') void context.close().catch(() => {}); } catch { /* optional audio must not block teardown */ }
      context = undefined;
      buffers.clear();
    },
  };
}
