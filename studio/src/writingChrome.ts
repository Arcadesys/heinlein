/** Reversible presentation state; no manuscript or window authority. */
export function createWritingChrome(root:HTMLElement,hooks:{focusWriting():void;changed(hidden:boolean):void;canHide():boolean}) {
  const element=document.createElement('div');element.className='writing-chrome-controls';
  const hideButton=document.createElement('button');hideButton.type='button';hideButton.textContent='Hide controls';hideButton.className='hide-writing-controls';hideButton.setAttribute('aria-keyshortcuts','Meta+Shift+H Control+Shift+H');hideButton.title='Slide controls away (Command/Ctrl+Shift+H). Reveal them at the top edge or with the same shortcut.';
  const showButton=document.createElement('button');showButton.type='button';showButton.textContent='Show controls';showButton.className='show-writing-controls';showButton.hidden=true;showButton.setAttribute('aria-keyshortcuts','Meta+Shift+H Control+Shift+H');
  const goal=document.createElement('p');goal.className='focus-word-goal';goal.hidden=true;goal.setAttribute('aria-live','off');element.append(showButton,goal);
  let hidden=false,goalEnabled=false,dead=false;
  const previous=new Map<HTMLElement,{inert:boolean;aria:string|null}>();
  const targets=()=>[...root.querySelectorAll<HTMLElement>('.status-pill,.notice-slot,.typing-chrome,.document-tabs,.document-command-bar,.split-reading-offer,.reference-pane,.standalone-page > h2,.standalone-page > p,.standalone-toolbar,.selection-ask-action,.selection-ask-extras,.cm-gutters')];
  function apply(){
    root.classList.toggle('writing-controls-hidden',hidden);hideButton.setAttribute('aria-expanded',String(!hidden));showButton.hidden=!hidden;goal.hidden=!hidden||!goalEnabled;
    if(hidden){for(const node of targets()){if(!previous.has(node))previous.set(node,{inert:node.inert,aria:node.getAttribute('aria-hidden')});node.inert=true;node.setAttribute('aria-hidden','true');}}
    else{for(const [node,state] of previous){node.inert=state.inert;if(state.aria===null)node.removeAttribute('aria-hidden');else node.setAttribute('aria-hidden',state.aria);}previous.clear();root.classList.remove('writing-controls-peek');}
  }
  function show(focus=false){if(dead||!hidden)return;hidden=false;apply();hooks.changed(false);if(focus)hideButton.focus({preventScroll:true});}
  function unsafe(){return !hooks.canHide()||!!root.querySelector('dialog[open],.goal-card:not([hidden]),.notice-slot .error,.standalone-page > [role="status"].error');}
  function hide(){if(dead||hidden||unsafe())return;hidden=true;apply();hooks.changed(true);hooks.focusWriting();}
  hideButton.addEventListener('click',hide);showButton.addEventListener('click',()=>show(true));
  const key=(event:KeyboardEvent)=>{if(event.isComposing||event.altKey||!event.shiftKey||!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=='h')return;event.preventDefault();event.stopPropagation();if(hidden)show(true);else hide();};
  const pointer=(event:MouseEvent)=>{if(hidden)root.classList.toggle('writing-controls-peek',event.clientY<=64);};
  document.addEventListener('keydown',key,true);document.addEventListener('mousemove',pointer);
  const observer=new MutationObserver(()=>{if(dead||!hidden)return;if(unsafe())show();else apply();});
  observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['open','class']});
  return {element,hideButton,showButton,hide,show,toggle(){if(hidden)show(true);else hide();},setGoalVisible(value:boolean){goalEnabled=value;goal.hidden=!hidden||!goalEnabled;},setGoal(text:string,label:string){goal.textContent=text;goal.setAttribute('aria-label',label);},get hidden(){return hidden;},destroy(){dead=true;observer.disconnect();document.removeEventListener('keydown',key,true);document.removeEventListener('mousemove',pointer);hidden=false;apply();element.remove();}};
}
