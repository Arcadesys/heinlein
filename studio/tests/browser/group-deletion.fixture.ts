import '../../src/fonts.bundle';
import '../../src/style.css';
import {mountStudio} from '../../src/studio';
import {applyAppearance,loadAppearance} from '../../src/appearance';
import {groupDeletionModel} from '../groupDeletionModel';
const model=groupDeletionModel();const app=mountStudio(document.querySelector<HTMLElement>('#app')!,model.core);
Object.assign(window,{groupDeletionFixture:{...model,theme:()=>applyAppearance({...loadAppearance(),theme:'contrast'})}});
await app.selectRepository(async()=>model.session);await app.showDocument('ms/first.md');
document.documentElement.dataset.groupDeletionReady='true';
