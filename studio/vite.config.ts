/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

// Node 25+ defines a built-in global localStorage that is undefined unless
// --localstorage-file is given. It shadows jsdom's storage in tests, so turn it
// off for test workers on Node versions that know the flag.
const nodeProcess = (globalThis as {process?: {allowedNodeEnvironmentFlags?: ReadonlySet<string>}}).process;
const nodeWebStorageFlags = nodeProcess?.allowedNodeEnvironmentFlags?.has('--experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : [];

export default defineConfig({
  clearScreen: false,
  server: { strictPort: true },
  build: { target: 'es2022' },
  test: { poolOptions: { forks: { execArgv: nodeWebStorageFlags }, threads: { execArgv: nodeWebStorageFlags } } },
});
