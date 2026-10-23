// Synthetic host, no native filesystem/dialog/credential/provider/network authority.
import { mountStudio } from '../../src/studio';
import { syntheticDraftBridge } from '../standaloneBridge';
import type {RecoveryDraft} from '../../src/localCore';
import '../../src/fonts.bundle';
import '../../src/style.css';
const key = 'synthetic-standalone-acceptance-v1';
const bridge = syntheticDraftBridge(JSON.parse(localStorage.getItem(key) ?? '[]'), rows => localStorage.setItem(key, JSON.stringify(rows)));
const projectFixture={failWrites:false,savedText:'placed text'};let projectHash='project-0',serial=0;let recovery:RecoveryDraft|null=null;
const documentFor=(path:string)=>({path,text:projectFixture.savedText,contentHash:projectHash,sizeBytes:new TextEncoder().encode(projectFixture.savedText).length,frontmatter:null,generatedCompatibility:false});
bridge.core.readDocument=async(_id,path)=>documentFor(path);
bridge.core.readRecovery=async()=>recovery;
bridge.core.stageRecovery=async(_id,path,baseHash,text)=>{if(projectFixture.failWrites)throw Error('Synthetic project disk full');return recovery={id:`recovery-${++serial}`,path,baseHash,text,updatedAt:Date.now()};};
bridge.core.saveDocument=async(_id,path,hash,text)=>{if(projectFixture.failWrites)throw Error('Synthetic project disk full');if(hash!==projectHash)throw Error('Stale project revision');projectFixture.savedText=text;projectHash=`project-${++serial}`;return documentFor(path);};
bridge.core.discardRecovery=async(_id,_path,id)=>{if(recovery&&recovery.id!==id)throw Error('Newer project recovery');recovery=null;};
Object.assign(window, { draftFixture: bridge, projectFixture });
const app = mountStudio(document.querySelector('#app')!, bridge.core);
Object.assign(window, { openSyntheticProject: () => app.selectRepository(async () => ({ id: 'project', name: 'Synthetic project', manifests: [] })).then(() => app.showDocument('scene.md')) });
