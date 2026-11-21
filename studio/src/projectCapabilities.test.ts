import {expect, it, vi} from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({Channel: class {}, invoke: vi.fn(async () => null), isTauri: () => true}));
import {invoke} from '@tauri-apps/api/core';
import {localCore} from './localCore';
import capability from '../src-tauri/capabilities/repository-browser.json';
import config from '../src-tauri/tauri.conf.json';
import build from '../src-tauri/build.rs?raw';
import main from '../src-tauri/src/main.rs?raw';

it('permits the production new-project bridge through all native command gates in the local main window', async () => {
  expect(config.app.security.capabilities).toContain(capability.identifier);
  expect(capability.windows).toEqual(['main']);
  expect(capability).not.toHaveProperty('remote');
  vi.mocked(invoke).mockClear();
  await localCore.createLocalProject!('My new project');
  expect(vi.mocked(invoke).mock.calls).toEqual([['project_request', {request:{action:'create',name:'My new project'}}]]);
  const declared = [...build.matchAll(/^\s*"(\w+)",?$/gm)].map(match => match[1]);
  const handler = main.split('tauri::generate_handler![')[1].split('])')[0];
  const registered = handler.split(',').map(command => command.trim().split('::').at(-1));
  expect(registered).toContain('project_request');
  expect(declared, 'project creation needs a generated Tauri permission').toContain('project_request');
  expect(capability.permissions, 'project creation needs the local main-window capability').toContain('allow-project-request');
});
