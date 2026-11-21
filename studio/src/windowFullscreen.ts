import {getCurrentWindow} from '@tauri-apps/api/window';
import type {FullScreenHost} from './fullScreenControl';
export const windowFullscreen:FullScreenHost={
  isFullscreen:()=>getCurrentWindow().isFullscreen(),
  setFullscreen:value=>getCurrentWindow().setFullscreen(value),
  onChanged:callback=>getCurrentWindow().onResized(callback),
};
