import './conversationRail.css';
export function createConversationRail(list:HTMLElement,measure:()=>HTMLElement|null,returnToWriter?:()=>void,modalChanged?:(modal:boolean)=>void) {
  const root=document.createElement('div');root.className='conversation-rail-root';
  const toggle=document.createElement('button');toggle.type='button';toggle.className='conversation-rail-toggle';toggle.setAttribute('aria-label','Chats');toggle.title='Open chats';toggle.setAttribute('aria-controls','conversation-rail');
  const toggleLabel=document.createElement('span');toggleLabel.className='chat-launcher-label';toggleLabel.textContent='Chats';
  const ns='http://www.w3.org/2000/svg',chatIcon=document.createElementNS(ns,'svg'),chatPath=document.createElementNS(ns,'path');
  chatIcon.setAttribute('viewBox','0 0 24 24');chatIcon.setAttribute('aria-hidden','true');chatIcon.setAttribute('focusable','false');chatPath.setAttribute('d','M4 4h16v12H9l-5 4V4Z');chatPath.setAttribute('fill','none');chatPath.setAttribute('stroke','currentColor');chatPath.setAttribute('stroke-width','2');chatPath.setAttribute('stroke-linejoin','round');chatIcon.append(chatPath);toggle.append(toggleLabel,chatIcon);
  const dock=document.createElement('aside');dock.className='conversation-rail-dock';dock.setAttribute('aria-label','Scene and chapter chats');
  const modal=document.createElement('dialog');modal.className='conversation-rail-dialog';modal.setAttribute('aria-label','Scene and chapter chats');
  const panel=document.createElement('section');panel.id='conversation-rail';panel.className='conversation-rail';panel.setAttribute('aria-label','Chats');
  const header=document.createElement('header');const heading=document.createElement('h2');heading.textContent='Chats';heading.tabIndex=-1;
  const back=document.createElement('button');back.type='button';back.textContent='Back to threads';
  const close=document.createElement('button');close.type='button';close.textContent='Close chats';
  const body=document.createElement('div');body.className='conversation-rail-body';const listHost=document.createElement('div');listHost.className='conversation-rail-list';const empty=document.createElement('p');empty.textContent='Open a project, then choose a scene or chapter for its chats.';empty.className='thread-sidebar';listHost.append(list,empty);body.append(listHost);header.append(heading,back,close);panel.append(header,body);dock.append(panel);root.append(toggle,dock,modal);
  let open=false,detail:HTMLElement|null=null;let disposed=false;let closing=false,returning=false,initialized=false,modalState=false;
  function render(){
    if(disposed)return;
    const focused=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const bounds=measure()?.getBoundingClientRect();const gap=bounds?innerWidth-bounds.right:0;
    // Dock only when the existing gutter can hold a readable panel. Otherwise
    // overlay the writer without resizing or rewrapping the manuscript.
    const rem=parseFloat(getComputedStyle(document.documentElement).fontSize)||16;
    const railWidth=Math.min(48*rem,Math.max(0,gap-16));dock.style.width=`${railWidth}px`;
    const wide=innerWidth>=1100&&!!bounds&&gap>=36*rem+16;
    if(bounds&&!initialized){open=wide;initialized=true;}
    const isModal=open&&!wide;if(isModal!==modalState){modalState=isModal;modalChanged?.(isModal);}
    toggle.setAttribute('aria-expanded',String(open));back.hidden=!detail;listHost.hidden=!!detail;empty.hidden=!list.hidden;
    dock.hidden=!open||!wide;
    if(open&&!wide){if(panel.parentElement!==modal)modal.append(panel);if(!modal.open){if(modal.showModal)modal.showModal();else modal.setAttribute('open','');}}
    else {if(modal.open){if(modal.close)modal.close();else modal.removeAttribute('open');}if(panel.parentElement!==dock)dock.append(panel);}
    if(open&&focused&&panel.contains(focused)&&!focused.closest('[hidden]')&&document.activeElement!==focused)focused.focus({preventScroll:true});
  }
  function show(){initialized=true;open=true;render();heading.focus({preventScroll:true});}
  function hide(){if(closing||returning)return;initialized=true;closing=true;detail?.querySelector<HTMLButtonElement>('.heinlein-close')?.click();open=false;render();closing=false;toggle.focus({preventScroll:true});returnToWriter?.();}
  toggle.onclick=()=>open?hide():show();close.onclick=hide;
  back.onclick=()=>{returning=true;detail?.querySelector<HTMLButtonElement>('.heinlein-close')?.click();returning=false;open=true;showList();heading.focus({preventScroll:true});};
  modal.addEventListener('cancel',event=>{event.preventDefault();hide();});
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!event.isComposing){event.preventDefault();event.stopPropagation();hide();}});
  modal.addEventListener('keydown',event=>{
    if(event.key!=='Tab'||!modal.open)return;
    const controls=[...modal.querySelectorAll<HTMLElement>('button,a[href],input,select,textarea,summary,[tabindex="0"]')].filter(node=>!node.closest('[hidden]')&&!node.matches(':disabled')&&node.getClientRects().length&&!node.closest('details:not([open]) :not(summary)'));
    if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1)?.focus();}
    else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0]?.focus();}
  });
  function showList(){detail=null;render();}
  const resize=()=>render();window.addEventListener('resize',resize);const appearance=new MutationObserver(resize);appearance.observe(document.documentElement,{attributes:true,attributeFilter:['style','data-zoom','data-theme']});void document.fonts?.ready.then(()=>render());
  return {element:root,body,show,hide,showList,refresh:render,showDetail(node:HTMLElement){detail=node;if(node.parentElement!==body)body.append(node);show();},destroy(){disposed=true;appearance.disconnect();window.removeEventListener('resize',resize);if(modal.open&&modal.close)modal.close();root.remove();}};
}
