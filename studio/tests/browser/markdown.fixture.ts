import {createQuestionPanel} from '../../src/questionPanel';
import type {LocalCore, QuestionRequest} from '../../src/localCore';
import '../../src/fonts.bundle';
import '../../src/style.css';
const answer = '# Reading advice\n\n**Keep the voice** — including *deliberate repetition*.\n\n1. Read aloud.\n2. Keep the source.\n\n> An invented quotation.\n\n```text\nA long line ' + 'example '.repeat(30) + '\n```\n\n[Documentation](https://example.com)\n\n| Choice | Result |\n| --- | --- |\n| Keep | Author decides |';
const panel = createQuestionPanel({available: () => true, cancelQuestion: async () => true,
  questionStatus: async () => ({configured: true, model: 'synthetic', message: 'Synthetic provider', generation: 1, accounts: [{id: 'mock', label: 'Synthetic account', signedIn: true, planEnabled: true}], activeAccountId: 'mock', models: [{slug: 'synthetic', displayName: 'Synthetic model'}], selectedModel: 'synthetic', signInPending: false, usageLimited: false}),
  askQuestion: async (request: QuestionRequest) => ({requestId: request.requestId, text: answer, model: 'synthetic', incomplete: false}),
} as unknown as LocalCore, {current: () => ({repositoryId: 'synthetic', path: 'scene.md', source: 'Unchanged source.', from: 0, to: 0, canCapture: true}), focusEditor: () => {}});
document.querySelector('#app')!.append(panel.element); panel.open();
