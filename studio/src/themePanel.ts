import {appearanceVariables, type Appearance} from './appearance';
import type {LocalCore, QuestionStatus} from './localCore';
import {createThemeStore, parseTheme, renderTheme, themeCSS, themeDiff, themePrompt, themeVariables, type ThemeTokens} from './themeTokens';
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text = '') {const result = document.createElement(tag); result.textContent = text; return result;}
function button(text: string, run: () => void) {const result = node('button', text); result.type = 'button'; result.addEventListener('click', run); return result;}
function field(title: string, id: string) {const label = node('label', title); const input = node('textarea'); input.id = id; label.htmlFor = id; input.rows = 3; return {label, input};}
export function createThemePanel(core: LocalCore, baseline: () => Appearance, target = document.documentElement) {
  const store = createThemeStore(); let candidate: ThemeTokens | null = null; let configuration: QuestionStatus | null = null;
  let epoch = 0; let pending: string | null = null; let disposed = false; let checking = false;
  const element = node('section'); element.className = 'theme-builder'; element.setAttribute('aria-label', 'Vibecode your theme');
  const heading = node('h3', 'Vibecode your theme');
  const intro = node('p', 'Describe an aesthetic. Generate theme tokens, review the live sample and CSS diff, then apply. Only Apply saves a candidate. Closing discards it. Reset restores your selected built-in theme.');
  const scope = node('p', 'Only your aesthetic and the token contract below are sent. No manuscript, selection, history or file access. Uses the account and model selected in Questions; no automatic retry or fallback.');
  const description = field('Describe your aesthetic', 'theme-aesthetic'); description.input.maxLength = 1200;
  const payload = node('pre'); payload.className = 'theme-code'; payload.setAttribute('aria-label', 'Exact theme request'); payload.tabIndex = 0;
  const payloadDetails = node('details'); payloadDetails.append(node('summary', 'Review or copy the exact agent prompt'), payload);
  const connection = node('p', 'Open this section to check the selected Questions connection.'); connection.setAttribute('role', 'status');
  const message = node('p', store.warning || (store.state.accepted ? 'Saved accepted theme is active.' : 'Built-in baseline is active.')); message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite');
  const previewLabel = node('h4', 'Accepted theme sample');
  const preview = node('div'); preview.className = 'theme-scope theme-live-sample'; preview.setAttribute('aria-label', 'Live theme sample');
  const sampleInput = node('input'); sampleInput.type = 'text'; sampleInput.value = 'Readable writing — your words stay yours.'; sampleInput.setAttribute('aria-label', 'Theme sample text');
  const sampleButton = button('Sample action', () => {}); sampleButton.className = 'primary';
  const muted = node('p', 'Secondary text and labels'); muted.className = 'muted';
  const warning = node('p', 'Warning: sample only'); warning.className = 'theme-sample-warning';
  const danger = node('p', 'Error: sample only'); danger.className = 'theme-sample-danger';
  const disabledSample = button('Disabled sample action', () => {}); disabledSample.disabled = true;
  const hoverSample = button('Hover or focus this control', () => {}); hoverSample.className = 'theme-hover-sample';
  const selectedSample = node('p', 'Selected text sample — still readable'); selectedSample.className = 'theme-selected-sample';
  preview.append(node('p', 'Aa — A clear space to write.'), muted, sampleInput, sampleButton, hoverSample, disabledSample, selectedSample, warning, danger);
  const diff = node('pre', 'Generate or paste a candidate to review its CSS diff.'); diff.className = 'theme-code'; diff.tabIndex = 0; diff.setAttribute('aria-label', 'Theme CSS diff');
  const css = node('pre'); css.className = 'theme-code'; css.tabIndex = 0; css.setAttribute('aria-label', 'Candidate scoped CSS');
  const cssDetails = node('details'); cssDetails.append(node('summary', 'Candidate scoped CSS'), css);
  const external = field('Paste agent token JSON', 'theme-agent-json'); external.input.maxLength = 4096; external.input.spellcheck = false;
  const externalDetails = node('details'); externalDetails.append(node('summary', 'Use another coding agent'), node('p', 'Give your coding agent the exact prompt above, then paste its JSON response here. Raw CSS is rejected.'), external.label, external.input);
  function fail(error: unknown) {message.textContent = error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message.slice(0, 1000) : 'Theme request failed. Check Questions for account/model setup or usage limits. No retry was sent.';}
  function invalidate() {
    epoch++; const id = pending; pending = null;
    if (id && core.cancelQuestion) {try {void core.cancelQuestion(id).catch(() => {});} catch { /* local invalidation still wins */ }}
  }
  function refresh() {
    if (disposed) return;
    const accepted = store.state.accepted;
    renderTheme(target, accepted, baseline()); renderTheme(preview, candidate ?? accepted, baseline());
    previewLabel.textContent = candidate ? 'Candidate preview — not saved' : 'Accepted theme sample';
    const before = accepted ? themeVariables(accepted) : {...appearanceVariables(baseline()), '--warn': '#ffaa00', '--danger': '#ff9b8a', '--radius': '12px', '--radius-sm': '8px', '--gradient': 'linear-gradient(135deg, #ff8a00, var(--accent))', '--on-accent': '#ffffff'};
    diff.textContent = candidate ? themeDiff(Object.fromEntries(Object.keys(themeVariables(candidate)).map(key => [key, before[key] ?? '(baseline)'])), themeVariables(candidate)) : 'Generate or paste a candidate to review its CSS diff.';
    css.textContent = candidate ? themeCSS(candidate) : 'No candidate.';
    apply.disabled = !candidate || !!pending; discard.disabled = !candidate;
    revert.disabled = !store.state.canRevert; recheck.disabled = checking || !!pending;
    generate.disabled = !core.askQuestion || !!pending || checking || !configuration?.configured || !!configuration.usageLimited || !description.input.value.trim();
    cancel.disabled = !pending;
  }
  function adopt(text: string, source: string) {
    const next = parseTheme(text); candidate = next;
    message.textContent = `${source}. Checks passed: text 4.5:1, borders 3:1, accent focus 4.5:1; opaque colours and bounded corner radius only. Review the sample and diff before Apply.`;
    refresh();
  }
  async function check() {
    if (disposed || checking) return;
    checking = true; refresh();
    try {
      configuration = core.available() && core.questionStatus ? await core.questionStatus() : null;
      if (disposed) return;
      const account = configuration?.accounts.find(item => item.id === configuration?.activeAccountId)?.label;
      connection.textContent = configuration?.configured ? `Selected: ${account ?? 'ChatGPT account'} · ${configuration.model}${configuration.usageLimited ? ' · Usage limited' : ''}.` : 'Native ChatGPT generation unavailable. Configure the selected account/model in Questions, or use another coding agent below.';
    } catch {configuration = null; if (!disposed) connection.textContent = 'Could not read the selected connection. Open Questions to check it, or use another coding agent.';}
    finally {checking = false; refresh();}
  }
  async function send() {
    if (checking || pending || !configuration?.configured || configuration.usageLimited || !core.askQuestion || !configuration.activeAccountId || !configuration.model) return;
    const version = ++epoch;
    try {
      const question = themePrompt(description.input.value); const requestId = crypto.randomUUID();
      const binding = {generation: configuration.generation, accountId: configuration.activeAccountId, model: configuration.model};
      pending = requestId; candidate = null; message.textContent = 'Generating one candidate with the selected connection…'; refresh();
      const answer = await core.askQuestion({requestId, question, context: '', history: []}, binding);
      if (disposed || version !== epoch) return;
      if (answer.requestId !== requestId || answer.incomplete || !answer.text.trim()) throw new Error('The agent did not return a complete theme. No retry was sent; accepted theme is unchanged.');
      const current = await core.questionStatus!();
      if (disposed || version !== epoch) return;
      if (!current.configured || current.generation !== binding.generation || current.activeAccountId !== binding.accountId || current.model !== binding.model) throw new Error('Connection changed. Generate again explicitly with the selected account/model.');
      adopt(answer.text, `Agent candidate · ${answer.model}`);
    } catch (error) {if (!disposed && version === epoch) fail(error);}
    finally {if (!disposed && version === epoch) {pending = null; refresh();}}
  }
  function commit(action: () => void, text: string) {
    try {action(); invalidate(); candidate = null; message.textContent = text; refresh(); return true;} catch (error) {fail(error); return false;}
  }
  const generate = button('Generate theme candidate', () => {void send();});
  const cancel = button('Cancel theme request', () => {invalidate(); message.textContent = 'Theme request cancelled locally; late responses cannot change the theme.'; refresh();});
  const recheck = button('Check selected connection', () => {void check();});
  const apply = button('Apply theme', () => {if (candidate) commit(() => store.apply(candidate!), 'Accepted theme saved on this device. Revert restores the previous accepted theme.');});
  const discard = button('Discard candidate', () => {candidate = null; message.textContent = 'Candidate discarded. Accepted theme is unchanged.'; refresh();});
  const revert = button('Revert accepted theme', () => {commit(() => store.revert(), 'Previous accepted theme restored and saved on this device.');});
  const reset = button('Reset to baseline', () => {commit(() => store.reset(), 'Built-in baseline restored and saved.');});
  const paste = button('Preview pasted tokens', () => {try {invalidate(); candidate = null; adopt(external.input.value, 'Pasted agent candidate');} catch (error) {fail(error); refresh();}}); externalDetails.append(paste);
  const actions = node('div'); actions.className = 'theme-actions'; actions.append(generate, cancel, recheck);
  const reviewActions = node('div'); reviewActions.className = 'theme-actions'; reviewActions.append(apply, discard, revert, reset);
  description.input.addEventListener('input', () => {
    invalidate(); candidate = null;
    try {payload.textContent = themePrompt(description.input.value);} catch {payload.textContent = 'Enter an aesthetic to prepare the exact agent prompt.';}
    message.textContent = 'Aesthetic changed. Generate a new candidate explicitly.'; refresh();
  });
  payload.textContent = 'Enter an aesthetic to prepare the exact agent prompt.';
  element.append(heading, intro, scope, description.label, description.input, payloadDetails, connection, actions, externalDetails, message, previewLabel, preview, node('h4', 'CSS token diff: accepted → candidate'), diff, cssDetails, reviewActions);
  refresh();
  return {element, check, refresh,
    usePreset() {
      if (!store.state.accepted && !store.warning) {invalidate(); candidate = null; refresh(); return true;}
      return commit(() => store.reset(), 'Built-in theme selected. Custom candidate discarded.');
    },
    close() {invalidate(); candidate = null; message.textContent = store.state.accepted ? 'Accepted theme is active. Unsaved candidate discarded.' : 'Built-in baseline is active. Unsaved candidate discarded.'; refresh();},
    destroy() {invalidate(); disposed = true;},
  };
}
