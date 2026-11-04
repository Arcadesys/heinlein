import { mountStudio } from './studio';
import { localCore } from './localCore';
import './fonts.bundle';
import './style.css';
import {initializePreferences} from './preferences';
const root=document.querySelector<HTMLElement>('#app')!;
root.textContent='Loading your writing preferences…';
await initializePreferences(localCore);
mountStudio(root, localCore);
