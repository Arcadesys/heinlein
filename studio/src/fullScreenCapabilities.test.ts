import {expect,it,vi} from 'vitest';
vi.mock('@tauri-apps/api/window',()=>({getCurrentWindow:()=>({isFullscreen:vi.fn(async()=>false),setFullscreen:vi.fn(async()=>{}),onResized:vi.fn(async()=>()=>{})})}));
import {windowFullscreen} from './windowFullscreen';
import capability from '../src-tauri/capabilities/repository-browser.json';
import config from '../src-tauri/tauri.conf.json';
it('grants native full screen operations only to the bundled local main window',async()=>{
 expect(config.app.security.capabilities).toContain(capability.identifier);expect(capability.windows).toEqual(['main']);expect(capability).not.toHaveProperty('remote');
 expect(capability.permissions).toContain('core:window:allow-is-fullscreen');expect(capability.permissions).toContain('core:window:allow-set-fullscreen');expect(capability.permissions).toContain('core:event:allow-listen');
 expect(await windowFullscreen.isFullscreen()).toBe(false);await windowFullscreen.setFullscreen(true);const stop=await windowFullscreen.onChanged(()=>{});stop();
});
