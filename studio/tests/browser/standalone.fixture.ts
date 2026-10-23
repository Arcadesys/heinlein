// Synthetic host, no native filesystem/dialog/credential/provider/network authority.
import { mountStudio } from '../../src/studio';
import { syntheticDraftBridge } from '../standaloneBridge';
import '../../src/fonts.bundle';
import '../../src/style.css';
const key = 'synthetic-standalone-acceptance-v1';
const bridge = syntheticDraftBridge(JSON.parse(localStorage.getItem(key) ?? '[]'), rows => localStorage.setItem(key, JSON.stringify(rows)));
Object.assign(window, { draftFixture: bridge });
const app = mountStudio(document.querySelector('#app')!, bridge.core);
Object.assign(window, { openSyntheticProject: () => app.selectRepository(async () => ({ id: 'project', name: 'Synthetic project', manifests: [] })).then(() => app.showDocument('scene.md')) });
