// Development/test entry only; never imported by src/main.ts or production builds.
import {mountStudio} from '../../src/studio';
import type {LocalCore, QuestionRequest} from '../../src/localCore';
import {dark, light} from './tokens';
import '../../src/fonts.bundle';
import '../../src/style.css';
const session = {id: 'synthetic', name: 'Synthetic theme acceptance', manifests: []};
const source = 'Synthetic prose — exact words.\n\nA deliberate fragment.';
const documentFor = (path: string) => ({path, text: source, contentHash: 'a'.repeat(64), sizeBytes: source.length, frontmatter: null, generatedCompatibility: false});
const unavailable = async (): Promise<never> => {throw new Error('Synthetic fixture has no filesystem or native authority.');};
const requests: QuestionRequest[] = [];
Object.assign(window, {themeFixtureRequests: requests});
const core: LocalCore = {
  available: () => true, pickRepository: async () => null, recentRepositories: async () => [], openRecentRepository: unavailable,
  listDirectory: async () => [], readDocument: async (_id, path) => documentFor(path), loadManuscript: unavailable, listSystemFonts: async () => [],
  saveDocument: unavailable, readRecovery: async () => null, stageRecovery: unavailable, discardRecovery: unavailable,
  setUnsavedChanges: async () => {}, requestClose: unavailable, onCloseRequested: async () => () => {},
  questionStatus: async () => ({configured: true, model: 'synthetic-model', selectedModel: 'synthetic-model', message: 'Synthetic provider', accounts: [{id: 'synthetic-account', label: 'Synthetic account', signedIn: true, planEnabled: true}], activeAccountId: 'synthetic-account', models: [{slug: 'synthetic-model', displayName: 'Synthetic model'}], signInPending: false, generation: 1, usageLimited: false}),
  askQuestion: async request => {
    requests.push(request);
    if (request.question.includes('provider-failure')) throw {message: 'Synthetic empty-answer failure. No request retried.'};
    return {requestId: request.requestId, model: 'synthetic-model', text: JSON.stringify(request.question.includes('light paper') ? light : dark), incomplete: false};
  }, cancelQuestion: async () => true,
};
const label = document.querySelector<HTMLElement>('#fixture-label')!;
Object.assign(label.style, {position: 'fixed', zIndex: '200', bottom: '0', left: '0', background: '#000', color: '#fff', font: '16px/1.5 system-ui', padding: '4px', pointerEvents: 'none'});
const app = mountStudio(document.querySelector<HTMLElement>('#app')!, core);
void app.selectRepository(async () => session).then(() => app.showDocument('synthetic.md'));
