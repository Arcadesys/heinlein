import {expect, it, vi} from 'vitest';
vi.mock('@tauri-apps/api/core', () => ({Channel: class {}, invoke: vi.fn(async () => null), isTauri: () => true}));
import {invoke} from '@tauri-apps/api/core';
import {localCore} from './localCore';
import capability from '../src-tauri/capabilities/repository-browser.json';
import config from '../src-tauri/tauri.conf.json';
import build from '../src-tauri/build.rs?raw';
import main from '../src-tauri/src/main.rs?raw';

const declared = [...build.matchAll(/^\s*"(\w+)",?$/gm)].map(match => match[1]);
const handler = main.split('tauri::generate_handler![')[1].split('])')[0];
const registered = handler.split(',').map(command => command.trim().split('::').at(-1));

it('allows the real MCP status, source selection and revocation bridge only in the bundled main window', async () => {
  expect(config.app.security.capabilities).toContain(capability.identifier);
  expect(capability.windows).toEqual(['main']);
  expect(capability).not.toHaveProperty('remote');
  vi.mocked(invoke).mockClear();
  await localCore.mcpRequest!({action: 'status'});
  await localCore.mcpRequest!({action: 'useSource', repositoryId: 'synthetic-repository', path: 'scene.md'});
  await localCore.mcpRequest!({action: 'revoke'});
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['mcp_access_request', {request: {action: 'status'}}],
    ['mcp_access_request', {request: {action: 'useSource', repositoryId: 'synthetic-repository', path: 'scene.md'}}],
    ['mcp_access_request', {request: {action: 'revoke'}}],
  ]);
  for (const command of ['mcp_access_request', 'list_proposals', 'reject_proposal', 'review_proposal', 'review_proposal_revert', 'apply_proposal_review', 'cancel_proposal_review']) {
    expect(registered, `${command} needs a native handler`).toContain(command);
    expect(declared, `${command} needs a generated Tauri permission`).toContain(command);
    expect(capability.permissions, `${command} needs the main window capability`).toContain(`allow-${command.replaceAll('_', '-')}`);
  }
});
