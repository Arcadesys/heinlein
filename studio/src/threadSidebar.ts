import type {LocalCore, ReviewResult} from './localCore';
import {readThreads,putThread,setThreadStatus,matchesThread,type ThreadScope,type WriterThread} from './threadStore';
import './threadSidebar.css';
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',cls='')=>{const node=document.createElement(tag);node.textContent=text;node.className=cls;return node;};
export function createThreadSidebar(core:LocalCore,hooks:{project():{id:string;repositoryId:string}|null;scope():ThreadScope|null;reviewScope(result:ReviewResult):ThreadScope;open(thread:WriterThread):Promise<void>;create(scope:ThreadScope):void}) {
  const element=el('section','','thread-sidebar');element.setAttribute('aria-label','Section threads');
  const heading=el('h3','Outstanding threads');heading.tabIndex=-1;
  const scopeLabel=el('p','','thread-scope');const list=el('ul','','thread-list');
  const notice=el('p','','thread-notice');notice.setAttribute('role','status');
  const show=el('input');show.type='checkbox';const label=el('label','Show resolved threads');label.prepend(show);
  const fresh=el('button','New conversation');fresh.type='button';fresh.onclick=()=>{const scope=hooks.scope();if(scope)hooks.create(scope);};
  const reload=el('button','Refresh threads');reload.type='button';reload.onclick=()=>void refresh();
  show.onchange=()=>render();element.append(heading,scopeLabel,fresh,label,list,reload,notice);
  let revision=0,disposed=false;
  function render(){
    if(disposed)return;
    const project=hooks.project(),scope=hooks.scope();element.hidden=!project||!scope;if(!project||!scope)return;
    scopeLabel.textContent=scope.label;list.replaceChildren();
    try {
      const threads=readThreads(project.id).filter(t=>matchesThread(t,scope)&&(show.checked||t.status==='open')).sort((a,b)=>b.updatedAt-a.updatedAt);
      if(!threads.length){list.append(el('li',show.checked?'No threads in this section.':'No outstanding threads in this section.'));return;}
      for(const thread of threads){
        const item=el('li');const open=el('button',thread.title,'thread-open');open.type='button';
        open.append(el('span',`${thread.scope.label} · ${thread.kind==='review'?'Review':'Conversation'} · ${thread.status==='open'?'Open':'Resolved'}`,'thread-detail'));
        open.onclick=()=>{if(hooks.project()?.id!==project.id){render();return;}notice.textContent='';void hooks.open(thread).catch(error=>{notice.textContent=error instanceof Error?error.message:'Thread could not be opened.';});};
        const resolve=el('button',thread.status==='open'?'Resolve':'Reopen');resolve.type='button';resolve.setAttribute('aria-label',`${resolve.textContent} thread: ${thread.title}`);
        resolve.onclick=()=>{if(hooks.project()?.id!==project.id){render();return;}try{setThreadStatus(project.id,thread.id,thread.status==='open'?'resolved':'open');render();notice.textContent=`Thread ${thread.status==='open'?'resolved':'reopened'}.`;heading.focus();}catch(error){notice.textContent=String(error);}};
        item.append(open,resolve);list.append(item);
      }
    }catch(error){notice.textContent=String(error);}
  }
  async function refresh(){render();const project=hooks.project();if(!project||!core.listReviews)return;const token=++revision;
    try{const reviews=await core.listReviews(project.repositoryId);if(disposed||token!==revision||hooks.project()?.id!==project.id)return;
      const existing=readThreads(project.id);
      for(const result of reviews){const id=`review:${result.reviewId}`;const prior=existing.find(t=>t.id===id);if(prior)continue;
        const scope=hooks.reviewScope(result);putThread(project.id,{id,kind:'review',title:`${scope.label} · Review`,scope,status:'open',updatedAt:0,reviewId:result.reviewId,model:result.model});}
      render();
    }catch(error){if(!disposed&&token===revision)notice.textContent=String(error);}
  }
  return {element,refresh,render,focus(){render();heading.focus();heading.scrollIntoView?.({block:'nearest'});},destroy(){disposed=true;revision++;element.remove();}};
}
