export interface FullScreenHost {
  isFullscreen(): Promise<boolean>;
  setFullscreen(value: boolean): Promise<void>;
  onChanged(callback: () => void): Promise<() => void>;
}
/** Native window state stays authoritative, including changes made with macOS controls. */
export function createFullScreenControl(host: FullScreenHost, hooks: {entered(): void; exited(): void; focusWriting(): void; report(error: unknown): void}) {
  const button = document.createElement('button');button.type='button';button.className='fullscreen-toggle';button.setAttribute('aria-keyshortcuts','Control+Meta+F F11');
  let revision=0;let active=false,busy=false,disposed=false,unlisten:(()=>void)|undefined;
  const compact=window.matchMedia?.('(max-width:760px)');
  function render(){button.setAttribute('aria-label',(active?'Exit full screen':'Full screen')+(compact?.matches?' focus':''));button.textContent=compact?.matches?(active?'Exit focus':'Focus'):active?'Exit full screen':'Full screen';button.setAttribute('aria-pressed',String(active));button.title=active?'Exit full screen (Escape)':'Full screen focus mode (Control+Command+F or F11)';button.disabled=busy;}
  function update(value:boolean){if(value===active)return;active=value;render();if(active)hooks.entered();else hooks.exited();}
  async function refresh(){const current=revision;try{const value=await host.isFullscreen();if(!disposed&&!busy&&current===revision)update(value);}catch(error){if(!disposed)hooks.report(error);}}
  async function toggle(){
    if(disposed||busy)return;revision++;busy=true;render();
    try{const value=await host.isFullscreen();await host.setFullscreen(!value);if(!disposed){update(!value);hooks.focusWriting();}}
    catch(error){if(!disposed)hooks.report(error);}
    finally{revision++;busy=false;if(!disposed){render();}}
  }
  compact?.addEventListener?.('change',render);
  button.addEventListener('click',()=>void toggle());render();
  void host.onChanged(()=>void refresh()).then(stop=>{if(disposed)stop();else unlisten=stop;}).catch(error=>{if(!disposed)hooks.report(error);});
  void refresh();
  return {button,toggle,get active(){return active;},destroy(){disposed=true;unlisten?.();compact?.removeEventListener?.('change',render);}};
}
