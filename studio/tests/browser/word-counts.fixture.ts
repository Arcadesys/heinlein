import '../../src/fonts.bundle';
import '../../src/style.css';
import {mountStudio} from '../../src/studio';
import {applyAppearance,loadAppearance} from '../../src/appearance';
import {EditorView} from '@codemirror/view';
import {groupDeletionModel} from '../groupDeletionModel';
import {wordCount} from '../../src/writingFeedback';
const model=groupDeletionModel();
if (location.search.includes('no-manuscript')) {const load=model.core.loadDrafting!; model.core.loadDrafting=async id=>({...await load(id),revision:null,groups:[],scenes:[],referenceSheets:[],library:[]});}
const app=mountStudio(document.querySelector<HTMLElement>('#app')!,model.core);
const view=()=>EditorView.findFromDOM(document.querySelector('.active-document-pane .cm-editor') as HTMLElement)!;
Object.assign(window,{wordCountFixture:{...model,app,view,wordCount,theme:()=>applyAppearance({...loadAppearance(),theme:'contrast'})}});
await app.selectRepository(async()=>model.session);await app.showDocument('ms/first.md');
document.documentElement.dataset.wordCountsReady='true';
