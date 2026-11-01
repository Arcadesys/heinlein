import { describe, expect, it, vi } from 'vitest';
import { createDailyGoalTracker, createTypewriterSound, DEFAULT_DAILY_GOAL, localDateKey, proseText, wordCount, WRITING_STORAGE_KEY } from './writingFeedback';

function memoryStorage() {
  const values = new Map<string, string>();
  return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }};
}
const today = () => new Date(2026, 9, 14, 12);

describe('prose word counts', () => {
  it('ignores complete opening YAML or JSON frontmatter and handles line endings and BOM', () => {
    expect(wordCount('---\ntitle: Many metadata words\n---\nTwo words.')).toBe(2);
    expect(wordCount('\uFEFF---\r\n{"title": "Many metadata words"}\r\n---\r\nTwo words.')).toBe(2);
    expect(wordCount('---\rtitle: Many metadata words\r---\rTwo words.')).toBe(2);
    expect(wordCount('---\ntitle: Many metadata words\n...\nTwo words.')).toBe(2);
  });
  it('does not strip later horizontal rules or incomplete fences', () => {
    const source = 'Opening words\n---\nMiddle words\n---\nLast words';
    expect(proseText(source)).toBe(source);
    expect(wordCount('---\nAn unfinished fence')).toBe(3);
    expect(wordCount('  ---\nStill prose\n---\nMore prose')).toBe(4);
    expect(wordCount('---\ntitle: Hidden\n---')).toBe(0);
  });
  it('counts Unicode prose, contractions and digits without counting punctuation or emoji', () => {
    expect(wordCount("# Café naïve don't l’été 42 — … 🐈")).toBe(5);
    expect(wordCount('Привет мир مرحبا بالعالم')).toBe(4);
    expect(wordCount('你好世界')).toBeGreaterThan(1);
    expect(wordCount('— ... # ** 🐈')).toBe(0);
    expect(wordCount('')).toBe(0);
  });
  it('has a Unicode-aware fallback if word segmentation is unavailable', () => {
    const descriptor = Object.getOwnPropertyDescriptor(Intl, 'Segmenter');
    Object.defineProperty(Intl, 'Segmenter', {value: undefined, configurable: true});
    try { expect(wordCount("Café don't l’été — 🐈")).toBe(3); }
    finally { if (descriptor) Object.defineProperty(Intl, 'Segmenter', descriptor); }
  });
});

describe('additive daily writing goal', () => {
  it('defaults to 1000 and does not credit loaded words', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    expect(tracker.snapshot()).toMatchObject({words: 0, goal: DEFAULT_DAILY_GOAL, remaining: 1000, complete: false});
    expect(tracker.loadScene('project/scene', 'Existing manuscript words').words).toBe(0);
    expect(tracker.recordChange('project/scene', 'Existing manuscript words', 'Existing manuscript words and new words').words).toBe(3);
  });
  it('does not count repeated characters within the same word or persist on every keystroke', () => {
    const storage = memoryStorage();
    const save = vi.spyOn(storage, 'setItem');
    const tracker = createDailyGoalTracker({storage, now: today});
    tracker.loadScene('scene', '');
    let before = '';
    for (const after of ['H', 'He', 'Hel', 'Hell', 'Hello', 'Hello ', 'Hello w', 'Hello wo', 'Hello world']) {
      tracker.recordChange('scene', before, after);
      before = after;
    }
    expect(tracker.snapshot().words).toBe(2);
    expect(tracker.recordChange('scene', before, before).words).toBe(2);
    expect(save).toHaveBeenCalledTimes(3); // baseline and two new words
  });
  it('keeps earned progress when deleting and does not recredit retyping up to the peak', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    tracker.loadScene('scene', '');
    tracker.recordChange('scene', '', 'one two three');
    expect(tracker.recordChange('scene', 'one two three', '').words).toBe(3);
    expect(tracker.recordChange('scene', '', 'one two three').words).toBe(3);
    expect(tracker.recordChange('scene', 'one two three', 'one two three four').words).toBe(4);
  });
  it('ignores repeated undo and redo and programmatic or recovery growth', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    tracker.loadScene('scene', 'one');
    tracker.recordChange('scene', 'one', 'one two');
    for (let i = 0; i < 5; i++) {
      tracker.recordChange('scene', 'one two', 'one', 'history');
      tracker.recordChange('scene', 'one', 'one two', 'history');
    }
    expect(tracker.snapshot().words).toBe(1);
    tracker.recordChange('scene', 'one two', 'one two three four', 'programmatic');
    tracker.recordChange('scene', 'one two three four', 'one two three four five', 'recovery');
    expect(tracker.snapshot().words).toBe(1);
    expect(tracker.recordChange('scene', 'one two three four five', 'one two three four five six').words).toBe(2);
  });
  it('credits pasted net-new prose across scene switches, but no metadata or reload words', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    tracker.loadScene('a', '---\ntitle: metadata\n---\nFirst');
    tracker.recordChange('a', '---\ntitle: metadata\n---\nFirst', '---\ntitle: metadata\n---\nFirst second third');
    tracker.loadScene('b', 'Existing');
    tracker.recordChange('b', 'Existing', 'Existing fourth fifth');
    expect(tracker.snapshot().words).toBe(4);
    tracker.loadScene('a', '---\ntitle: metadata\n---\nFirst second third');
    tracker.recordChange('a', '---\ntitle: metadata\n---\nFirst second third', '---\ntitle: metadata\n---\nFirst second third sixth');
    expect(tracker.snapshot().words).toBe(5);
    tracker.loadScene('b', 'Existing fourth fifth');
    expect(tracker.snapshot().words).toBe(5);
  });
  it('does not credit deletions that expose metadata or whitespace splitting existing words', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    const source = '---\ntitle: many existing metadata words\n---\nHello';
    tracker.loadScene('scene', source);
    expect(tracker.recordChange('scene', source, source.slice(4)).words).toBe(0);
    tracker.loadScene('other', 'Hello');
    expect(tracker.recordChange('other', 'Hello', 'Hel lo').words).toBe(0);
  });
  it('does not credit multi-range whitespace or punctuation splitting existing words', () => {
    for (const after of ['one two three four', 'one—two three/four', 'one \n two three \t four']) {
      const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
      tracker.loadScene('scene', 'onetwo threefour');
      expect(wordCount(after)).toBe(4);
      expect(tracker.recordChange('scene', 'onetwo threefour', after).words).toBe(0);
      expect(tracker.recordChange('scene', after, `${after} added`).words).toBe(1);
    }
  });
  it('conservatively ignores ambiguous mixed replacements while advancing the baseline', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    const before = 'onetwo threefour';
    const after = 'one newlytypedword two three four';
    tracker.loadScene('scene', before);
    expect(tracker.recordChange('scene', before, after).words).toBe(0);
    expect(tracker.recordChange('scene', after, `${after} added`).words).toBe(1);
    const replacement = 'Different words with much more new prose here';
    expect(tracker.recordChange('scene', `${after} added`, replacement).words).toBe(1);
    expect(tracker.recordChange('scene', replacement, `${replacement} now`).words).toBe(2);
  });
  it('bounds a single insertion combining new words and a split of an existing word', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    tracker.loadScene('scene', 'onetwo');
    expect(tracker.recordChange('scene', 'onetwo', 'one new two').words).toBe(1);
  });
  it('counts only growth above the before-text if no explicit load was made', () => {
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: today});
    expect(tracker.recordChange('scene', 'Existing words', 'Existing words plus new').words).toBe(2);
  });
  it('preserves peaks, progress and an adjustable goal across restart', () => {
    const storage = memoryStorage();
    const first = createDailyGoalTracker({storage, now: today});
    first.loadScene('scene', 'Existing');
    first.recordChange('scene', 'Existing', 'Existing one two');
    first.setGoal(3);
    const second = createDailyGoalTracker({storage, now: today});
    second.loadScene('scene', 'Existing');
    expect(second.snapshot()).toMatchObject({words: 2, goal: 3, complete: false});
    expect(second.recordChange('scene', 'Existing', 'Existing one two').words).toBe(2);
    expect(second.recordChange('scene', 'Existing one two', 'Existing one two three')).toMatchObject({words: 3, remaining: 0, complete: true});
    expect(storage.getItem(WRITING_STORAGE_KEY)).not.toContain('Existing');
  });
  it('starts a local-calendar day with the current source as baseline and keeps earlier totals', () => {
    const storage = memoryStorage();
    let time = new Date(2026, 9, 14, 23, 59);
    const tracker = createDailyGoalTracker({storage, now: () => time});
    tracker.loadScene('scene', 'Existing');
    tracker.recordChange('scene', 'Existing', 'Existing first second');
    tracker.setGoal(1500);
    time = new Date(2026, 9, 15, 0, 1);
    expect(tracker.snapshot()).toMatchObject({date: '2026-10-15', words: 0, goal: 1500});
    expect(tracker.recordChange('scene', 'Existing first second', 'Existing first second third').words).toBe(1);
    tracker.recordChange('scene', 'Existing first second third', 'Existing', 'history');
    tracker.recordChange('scene', 'Existing', 'Existing first second third', 'history');
    expect(tracker.snapshot().words).toBe(1);
    time = new Date(2026, 9, 14, 12);
    expect(tracker.snapshot().words).toBe(2);
  });
  it('does not count cross-midnight undo/redo before the first typed change', () => {
    let time = today();
    const tracker = createDailyGoalTracker({storage: memoryStorage(), now: () => time});
    tracker.loadScene('scene', 'one');
    tracker.recordChange('scene', 'one', 'one two three');
    time = new Date(2026, 9, 15, 0, 1);
    tracker.recordChange('scene', 'one two three', 'one', 'history');
    tracker.recordChange('scene', 'one', 'one two three', 'history');
    expect(tracker.snapshot().words).toBe(0);
    expect(tracker.recordChange('scene', 'one two three', 'one two three four').words).toBe(1);
  });
  it('uses local calendar fields rather than the UTC date', () => {
    const date = {getFullYear: () => 2026, getMonth: () => 0, getDate: () => 2, toISOString: () => '2026-01-01T23:00:00Z'};
    expect(localDateKey(date as unknown as Date)).toBe('2026-01-02');
  });
  it('ignores invalid goal values and invalid saved records', () => {
    const storage = memoryStorage();
    storage.setItem(WRITING_STORAGE_KEY, JSON.stringify({version: 1, goal: -100, days: {'2026-10-14': {bad: {peak: 1, words: 99}, valid: {peak: 3, words: 2}}}}));
    const tracker = createDailyGoalTracker({storage, now: today});
    for (const value of [NaN, Infinity, 0, -1, 1.5, 1_000_001]) expect(tracker.setGoal(value).goal).toBe(1000);
    expect(tracker.snapshot().words).toBe(2);
    expect(tracker.setGoal(250).goal).toBe(250);
  });
  it('handles corrupt and unavailable storage while maintaining in-memory progress', () => {
    const onStorageError = vi.fn();
    const storage = {getItem: () => '{bad json', setItem: () => { throw new Error('quota'); }};
    const tracker = createDailyGoalTracker({storage, now: today, onStorageError});
    expect(tracker.snapshot().persistenceAvailable).toBe(false);
    tracker.loadScene('scene', '');
    expect(tracker.recordChange('scene', '', 'one two')).toMatchObject({words: 2, persistenceAvailable: false});
    expect(onStorageError).toHaveBeenCalled();
    const denied = createDailyGoalTracker({storage: {getItem: () => { throw new Error('denied'); }, setItem: () => {}}, now: today});
    expect(denied.snapshot().persistenceAvailable).toBe(false);
    expect(createDailyGoalTracker({storage: null, now: today}).snapshot().persistenceAvailable).toBe(false);
  });
  it('does not overwrite unseen saved progress after a storage read failure', () => {
    const setItem = vi.fn();
    const tracker = createDailyGoalTracker({storage: {getItem: () => { throw new Error('denied'); }, setItem}, now: today});
    tracker.recordChange('scene', '', 'one two');
    expect(tracker.snapshot()).toMatchObject({words: 2, persistenceAvailable: false});
    expect(setItem).not.toHaveBeenCalled();
  });
  it('bounds saved daily history to the current day plus 30 previous dates', () => {
    const storage = memoryStorage();
    let time = new Date(2026, 0, 1, 12);
    const tracker = createDailyGoalTracker({storage, now: () => time});
    for (let i = 1; i <= 40; i++) {
      time = new Date(2026, 0, i, 12);
      tracker.recordChange('scene', '', 'one');
    }
    const saved = JSON.parse(storage.getItem(WRITING_STORAGE_KEY)!);
    expect(Object.keys(saved.days)).toHaveLength(31);
    expect(tracker.snapshot().words).toBe(1);
  });
  it('safely supports scene keys that collide with object prototype names', () => {
    const storage = memoryStorage();
    const tracker = createDailyGoalTracker({storage, now: today});
    tracker.recordChange('__proto__', '', 'one');
    tracker.recordChange('constructor', '', 'two');
    expect(tracker.snapshot().words).toBe(2);
    expect(createDailyGoalTracker({storage, now: today}).snapshot().words).toBe(2);
  });
});

function audioMock() {
  const source = {connect: vi.fn(), disconnect: vi.fn(), start: vi.fn(), buffer: null, onended: null as (() => void) | null};
  const gain = {connect: vi.fn(), disconnect: vi.fn(), gain: {value: 1}};
  const context = {
    state: 'suspended', currentTime: 0, sampleRate: 48000, destination: {},
    resume: vi.fn(async () => { context.state = 'running'; }), close: vi.fn(async () => { context.state = 'closed'; }),
    createBuffer: vi.fn((_channels: number, length: number) => ({getChannelData: () => new Float32Array(length)})),
    createBufferSource: vi.fn(() => source), createGain: vi.fn(() => gain),
  };
  return {context, source, gain, createContext: vi.fn(() => context as unknown as AudioContext)};
}

describe('optional typewriter sounds', () => {
  it('is silent by default and creates audio only when explicitly enabled', async () => {
    const mock = audioMock();
    const sounds = createTypewriterSound({createContext: mock.createContext});
    sounds.play();
    expect(sounds.enabled()).toBe(false);
    expect(mock.createContext).not.toHaveBeenCalled();
    expect(await sounds.setEnabled(true)).toBe(true);
    expect(mock.context.resume).toHaveBeenCalledOnce();
    sounds.play();
    expect(mock.source.start).toHaveBeenCalledOnce();
    expect(mock.gain.gain.value).toBeLessThan(0.03);
    mock.source.onended?.();
    expect(mock.source.disconnect).toHaveBeenCalledOnce();
    expect(mock.gain.disconnect).toHaveBeenCalledOnce();
    await sounds.setEnabled(false);
    sounds.play();
    expect(mock.source.start).toHaveBeenCalledOnce();
    sounds.destroy();
    expect(mock.context.close).toHaveBeenCalledOnce();
  });
  it('rate limits simultaneous changes and handles unavailable or blocked audio', async () => {
    const mock = audioMock();
    const sounds = createTypewriterSound({createContext: mock.createContext});
    await sounds.setEnabled(true);
    sounds.play(); sounds.play();
    expect(mock.source.start).toHaveBeenCalledOnce();
    mock.context.currentTime = 0.1;
    sounds.play();
    expect(mock.source.start).toHaveBeenCalledTimes(2);
    const unavailable = createTypewriterSound({createContext: () => { throw new Error('unavailable'); }});
    expect(await unavailable.setEnabled(true)).toBe(false);
    expect(() => unavailable.play()).not.toThrow();
    const blocked = audioMock();
    blocked.context.resume.mockRejectedValue(new Error('blocked'));
    expect(await createTypewriterSound({createContext: blocked.createContext}).setEnabled(true)).toBe(false);
  });
  it('keeps optional audio failures from blocking editing or teardown', async () => {
    const mock = audioMock();
    const sounds = createTypewriterSound({createContext: mock.createContext});
    await sounds.setEnabled(true);
    mock.context.createBuffer.mockImplementation(() => { throw new Error('audio failure'); });
    expect(() => sounds.play()).not.toThrow();
    expect(sounds.enabled()).toBe(false);
    mock.context.close.mockImplementation(() => { throw new Error('close failure'); });
    expect(() => sounds.destroy()).not.toThrow();
  });
  it('does not re-enable audio when a delayed resume finishes after disabling or destroy', async () => {
    const mock = audioMock();
    let finish!: () => void;
    mock.context.resume.mockImplementation(() => new Promise(resolve => { finish = () => { mock.context.state = 'running'; resolve(); }; }));
    const sounds = createTypewriterSound({createContext: mock.createContext});
    const enabling = sounds.setEnabled(true);
    await sounds.setEnabled(false);
    finish();
    expect(await enabling).toBe(false);
    expect(sounds.enabled()).toBe(false);
    mock.context.state = 'suspended';
    const enablingAgain = sounds.setEnabled(true);
    sounds.destroy(); finish();
    expect(await enablingAgain).toBe(false);
  });
});

describe('typewriter volume and cached sounds', () => {
  it('reuses one sample per key kind, applies volume and mutes at zero', async () => {
    const mock = audioMock();
    const sounds = createTypewriterSound({createContext: mock.createContext});
    await sounds.setEnabled(true);
    sounds.setVolume(0.8); sounds.play('key');
    expect(mock.gain.gain.value).toBeCloseTo(0.04);
    mock.context.currentTime += 0.1; sounds.play('key');
    expect(mock.context.createBuffer).toHaveBeenCalledTimes(1);
    mock.context.currentTime += 0.1; sounds.play('delete');
    mock.context.currentTime += 0.1; sounds.play('return');
    expect(mock.context.createBuffer).toHaveBeenCalledTimes(3);
    const lengths = mock.context.createBuffer.mock.calls.map(call => call[1]);
    expect(lengths[1]).toBeGreaterThan(lengths[0]);
    expect(lengths[2]).toBeGreaterThan(lengths[1]);
    sounds.setVolume(0); mock.context.currentTime += 0.1; sounds.play();
    expect(mock.source.start).toHaveBeenCalledTimes(4);
    sounds.setVolume(2); expect(sounds.volume()).toBe(1);
    sounds.setVolume(NaN); expect(sounds.volume()).toBe(1);
    sounds.destroy();
  });
});
