import type { GitHubConflict, GitHubResolution } from './githubTypes';
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '') => { const e = document.createElement(tag); e.textContent = text; return e; };
/** Every resolution requires a named author action. Candidate text is never source. */
export function createGitHubConflictPanel(conflict: GitHubConflict, resolve: (value: GitHubResolution) => Promise<void>, references:Record<string,string>={}) {
    const element = node('section');
    element.className = 'github-conflict';
    element.setAttribute('aria-label', conflict.label);
    element.append(node('h3', conflict.label), node('p', conflict.resolution ? 'Choice recorded. Review the resulting batch before applying.' : 'Choose how to resolve this conflict. No choice is selected.'));
    for (const [label, text] of [['Original', conflict.original], ['Your writing', conflict.yours], ['GitHub writing', conflict.github]]) {
        const details = node('details');
        let display=text;if(conflict.kind!=='prose'){try{const value:unknown=JSON.parse(text);if(Array.isArray(value)&&value.every(v=>typeof v==='string'))display=value.map((id,i)=>`${i+1}. ${references[id]??id}`).join('\n');else if(typeof value==='string')display=references[value]??value;}catch{/* Deletion labels and prose remain literal. */}}
        details.append(node('summary', label), node('pre', display));
        element.append(details);
    }
    const label = node('label', conflict.kind === 'prose' ? 'Your result' : 'Your structural result (JSON)');
    const result = node('textarea');
    result.value = conflict.resolution?.choice === 'combined' ? conflict.resolution.result ?? '' : '';
    result.rows = 8;
    result.maxLength = 2 * 1024 * 1024;
    label.append(result);
    if(conflict.kind==='prose')element.append(label);else{const advanced=node('details');advanced.append(node('summary','Custom structure result (advanced)'),node('p','Use the exact stable IDs in the preview for a custom JSON result. Keeping either displayed version requires no JSON editing.'),label);const ids=node('pre',JSON.stringify(references,null,2));advanced.append(ids);element.append(advanced);}
    if (conflict.kind !== 'prose')
        element.append(node('p', 'Keep either displayed version, or use the advanced custom result. Nothing changes until the whole batch is valid and confirmed.'));
    for (const [text, choice] of [['Keep mine', 'mine'], ['Use GitHub', 'github'], ['Use my result', 'combined']] as const) {
        const button = node('button', text);
        button.type = 'button';
        button.addEventListener('click', () => { void resolve({ choice, result: choice === 'combined' ? result.value : null }); });
        element.append(button);
    }
    return { element };
}
