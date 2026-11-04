import './reviewActivity.css';

type NoticeKind = 'complete' | 'attention';
/** Background activity only. Never moves focus or changes review/source authority. */
export function createReviewActivity(open: () => void) {
  const element = document.createElement('section');
  element.className = 'review-background';
  element.setAttribute('aria-label', 'Review activity');
  element.hidden = true;
  const badge = document.createElement('button'); badge.type = 'button'; badge.className = 'review-activity-button';
  badge.title = 'Open review'; badge.onclick = open;
  const ring = document.createElement('span'); ring.className = 'review-radial'; ring.setAttribute('role', 'progressbar'); ring.setAttribute('aria-label', 'Review calls completed');
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 36 36'); svg.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(ns, 'circle'), arc = document.createElementNS(ns, 'circle');
  for (const circle of [track, arc]) {circle.setAttribute('cx', '18'); circle.setAttribute('cy', '18'); circle.setAttribute('r', '14');}
  track.classList.add('review-radial-track'); arc.classList.add('review-radial-arc'); svg.append(track, arc); ring.append(svg);
  const words = document.createElement('span'), label = document.createElement('span'), detail = document.createElement('span');
  words.className = 'review-activity-words'; detail.className = 'review-activity-count'; words.append(label, detail); badge.append(ring, words);
  const toast = document.createElement('section'); toast.className = 'review-completion-toast'; toast.setAttribute('aria-label', 'Review notification');
  const message = document.createElement('p');
  const announcer = document.createElement('p'); announcer.className = 'sr-only'; announcer.setAttribute('role', 'status'); announcer.setAttribute('aria-live', 'polite'); announcer.setAttribute('aria-atomic', 'true');
  const actions = document.createElement('div'); actions.className = 'review-toast-actions';
  const reopen = document.createElement('button'); reopen.type = 'button'; reopen.textContent = 'Open review'; reopen.onclick = open;
  const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.textContent = 'Dismiss'; dismiss.setAttribute('aria-label', 'Dismiss notification');
  dismiss.onclick = () => {notice = ''; render(); badge.focus();};
  actions.append(reopen, dismiss); toast.append(message, actions); element.append(badge, toast, announcer);
  let visible = false, run: {id: string; scope: string; completed: number; total: number | null} | null = null;
  let ready: {kind: NoticeKind; scope: string} | null = null, notice = '';
  function render() {
    element.hidden = visible || (!run && !ready);
    badge.hidden = Boolean(notice);
    ring.hidden = !run;
    label.textContent = run ? 'Review in progress' : ready?.kind === 'complete' ? 'Review ready' : 'Review needs attention';
    detail.textContent = run ? run.total ? `${run.completed} of ${run.total} calls completed` : 'Preparing review…' : 'Open review';
    badge.title = `Open review${run?.scope || ready?.scope ? `: ${run?.scope ?? ready?.scope}` : ''}`;
    badge.dataset.reviewState = run ? 'running' : ready?.kind ?? '';
    ring.classList.toggle('review-radial-indeterminate', Boolean(run && (!run.total || run.completed === 0)));
    ring.setAttribute('aria-valuemin', '0');
    if (run?.total) {
      ring.setAttribute('aria-valuemax', String(run.total)); ring.setAttribute('aria-valuenow', String(run.completed));
      ring.setAttribute('aria-valuetext', `${run.completed} of ${run.total} calls completed`);
    } else {for (const attr of ['aria-valuemax', 'aria-valuenow', 'aria-valuetext']) ring.removeAttribute(attr);}
    arc.setAttribute('stroke-dasharray', `${run?.total && run.completed ? 88 * run.completed / run.total : 22} 88`);
    toast.hidden = !notice;
    if (message.textContent !== notice) {message.textContent = notice; announcer.textContent = notice;}
  }
  return {element,
    start(id: string, scope: string, total: number | null) {run = {id, scope, completed: 0, total}; ready = null; notice = ''; render();},
    progress(id: string, completed: number, total: number) {
      if (run?.id !== id || !Number.isSafeInteger(completed) || !Number.isSafeInteger(total) || total < 1 || completed < 0 || completed > total || total < run.completed) return;
      run.completed = Math.max(run.completed, completed); run.total = total; render();
    },
    finish(id: string, kind: NoticeKind, text: string) {
      if (run?.id !== id) return;
      ready = {kind, scope: run.scope}; run = null; notice = visible ? '' : text; render();
    },
    cancel(id: string) {if (run?.id === id) {run = null; ready = null; notice = ''; render();}},
    setVisible(next: boolean) {visible = next; if (next) notice = ''; render();},
    clear() {run = null; ready = null; notice = ''; render();},
    destroy() {run = null; ready = null; element.remove();},
  };
}
