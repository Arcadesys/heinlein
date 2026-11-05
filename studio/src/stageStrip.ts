import {stageLabels, type Stage} from './consensus';

const order = Object.keys(stageLabels) as Stage[];

/**
 * Read-only progress indicator shared by the review pane and the Revisions overlay.
 * State is carried by text and aria-current, never colour alone. It is not navigation.
 */
export function createStageStrip(label = 'Revision progress') {
  const element = document.createElement('ol');
  element.className = 'stage-strip';
  element.setAttribute('aria-label', label);
  const items = order.map((key, index) => {
    const item = document.createElement('li');
    item.dataset.stage = key;
    const mark = document.createElement('span'); mark.className = 'stage-mark'; mark.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.className = 'stage-name';
    const state = document.createElement('span'); state.className = 'sr-only';
    item.append(mark, name, state);
    element.append(item);
    return {key, index, item, mark, name, state};
  });
  function set(current: Stage, detail = '') {
    const at = order.indexOf(current);
    for (const {key, index, item, mark, name, state} of items) {
      const status = index < at ? 'complete' : index === at ? 'current' : 'upcoming';
      item.dataset.state = status;
      if (status === 'current') item.setAttribute('aria-current', 'step'); else item.removeAttribute('aria-current');
      mark.textContent = status === 'complete' ? '✓' : String(index + 1);
      name.textContent = status === 'current' && detail ? `${stageLabels[key]} · ${detail}` : stageLabels[key];
      state.textContent = status === 'complete' ? ' (completed)' : '';
    }
  }
  return {element, set};
}
