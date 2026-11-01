/** Presentation only: existing command nodes keep their handlers and guard state. */
export function actionMenu(label:string,nodes:HTMLElement[],root:HTMLElement,context?:()=>string,closed?:()=>void){
 const button=document.createElement('button');button.type='button';button.textContent=label;button.setAttribute('aria-haspopup','dialog');button.setAttribute('aria-expanded','false');
 const storage=document.createElement('div');storage.hidden=true;storage.className='action-storage';storage.append(...nodes);
 let current:HTMLDialogElement|null=null;
 button.addEventListener('click',()=>{
  if(current)return;const dialog=document.createElement('dialog');current=dialog;dialog.className='appearance-dialog workspace-actions-dialog';dialog.setAttribute('aria-label',label);
  const title=document.createElement('h2');title.textContent=label;const close=document.createElement('button');close.type='button';close.textContent='Return to writing';
  const body=document.createElement('div');body.className='workspace-action-controls';if(button.closest('.editor-toolbar')?.classList.contains('document-reading'))body.classList.add('document-reading');body.append(...storage.children);
  const finish=()=>{if(!current)return;dialog.dispatchEvent(new Event('dismiss-menus'));if(dialog.open&&typeof dialog.close==='function')dialog.close();storage.append(...body.children);dialog.remove();current=null;button.setAttribute('aria-expanded','false');closed?.();if(button.isConnected)button.focus({preventScroll:true});};
  close.addEventListener('click',finish);dialog.addEventListener('cancel',e=>{e.preventDefault();finish();});
  body.addEventListener('click',e=>{const command=(e.target as Element).closest('button');if(command&&command.getAttribute('aria-haspopup')!=='menu')finish();},true);
  dialog.append(title,close);const note=context?.();if(note){const p=document.createElement('p');p.textContent=note;dialog.append(p);}dialog.append(body);root.append(dialog);button.setAttribute('aria-expanded','true');if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');close.focus();
 });
 return {button,storage,isOpen:()=>!!current,destroy(){if(current){const close=current.querySelector<HTMLButtonElement>('button');close?.click();}}};
}
