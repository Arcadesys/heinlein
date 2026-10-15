import { mountStudio } from './studio';
import { localCore } from './localCore';
import './style.css';
mountStudio(document.querySelector<HTMLElement>('#app')!, localCore);
