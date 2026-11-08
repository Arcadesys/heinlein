// @vitest-environment jsdom
import {expect,it,vi} from 'vitest';
import {createFullScreenControl,type FullScreenHost} from './fullScreenControl';
const tick=()=>new Promise(r=>setTimeout(r,0));
function setup(initial=false){let active=initial;let change=()=>{};const stop=vi.fn();const host:FullScreenHost={isFullscreen:vi.fn(async()=>active),setFullscreen:vi.fn(async value=>{active=value;}),onChanged:vi.fn(async callback=>{change=callback;return stop;})};const hooks={entered:vi.fn(),exited:vi.fn(),focusWriting:vi.fn(),report:vi.fn()};const control=createFullScreenControl(host,hooks);return{host,hooks,control,stop,external(value:boolean){active=value;change();}};}
it('offers a labeled toggle and follows native changes made outside the button',async()=>{
 const f=setup();await tick();expect(f.control.button.textContent).toBe('Full screen');expect(f.control.button.getAttribute('aria-pressed')).toBe('false');await f.control.toggle();expect(f.host.setFullscreen).toHaveBeenCalledWith(true);expect(f.control.button.textContent).toBe('Exit full screen');expect(f.hooks.focusWriting).toHaveBeenCalledOnce();f.external(false);await tick();expect(f.control.button.textContent).toBe('Full screen');expect(f.hooks.exited).toHaveBeenCalledOnce();f.control.destroy();expect(f.stop).toHaveBeenCalledOnce();
});
it('keeps an obvious exit when already full screen and reports failures without lying about state',async()=>{
 const f=setup(true);await tick();expect(f.control.button.textContent).toBe('Exit full screen');vi.mocked(f.host.setFullscreen).mockRejectedValueOnce(Error('Denied'));await f.control.toggle();expect(f.hooks.report).toHaveBeenCalledOnce();expect(f.control.button.textContent).toBe('Exit full screen');expect(f.control.button.disabled).toBe(false);f.control.destroy();
});
it('ignores repeated toggles while a native change is pending',async()=>{
 const f=setup();await tick();let resolve!:()=>void;vi.mocked(f.host.setFullscreen).mockImplementationOnce(()=>new Promise<void>(r=>{resolve=r;}));const first=f.control.toggle();await tick();await f.control.toggle();expect(f.host.setFullscreen).toHaveBeenCalledOnce();resolve();await first;f.control.destroy();
});
