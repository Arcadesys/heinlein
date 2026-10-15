// Small deterministic generator shared by the synthetic state-machine campaigns.
// Every failure includes the seed and the exact prefix needed to replay it.
export function seeded(seed: number) {
  let state = seed >>> 0;
  return (maximum: number) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % maximum;
  };
}
const environment = (globalThis as {process?: {env?: Record<string, string | undefined>}}).process?.env ?? {};
export function campaign(name: string, defaultSeeds = 12, defaultSteps = 100) {
  const integer = (key: string, fallback: number, maximum: number) => {
    const input = environment[key];
    const value = input === undefined ? fallback : Number(input);
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw new Error(`${key} must be between 1 and ${maximum}`);
    return value;
  };
  const result = {
    seeds: integer(`${name}_FUZZ_SEEDS`, defaultSeeds, 10000),
    steps: integer(`${name}_FUZZ_STEPS`, defaultSteps, 10000),
    firstSeed: integer(`${name}_FUZZ_FIRST_SEED`, 1, 0xffffffff),
  };
  if (result.firstSeed + result.seeds - 1 > 0xffffffff) throw new Error(`${name} seed range must not wrap past 4294967295`);
  return result;
}
export const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');
export function coverageCounter() {
  const counts: Record<string, number> = {};
  return {counts, record(name: string) {counts[name] = (counts[name] ?? 0) + 1;}};
}
export const textAtoms = ['alpha', ' — ', '🐺', '👩🏽‍🚀', 'e\u0301', '漢字', '\t', '\n', '\n\n', '\u2028', '<script>literal()</script>', '𝄞', 'fragment.'];
export function positions(text: string) {
  const result = [0];
  for (const point of text) result.push(result[result.length - 1] + point.length);
  return result;
}
