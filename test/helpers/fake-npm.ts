/**
 * Fake NPM Helpers
 *
 * Create a mock npm command for testing variant installation
 * without actually downloading packages.
 */

import path from 'node:path';
import { makeTempDir, writeExecutable, cleanup } from './fs-helpers.js';

/**
 * Create a fake npm script that creates a dummy CLI
 */
export const createFakeNpm = (dir: string) => {
  const npmPath = path.join(dir, 'npm');
  const script = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
let prefix = '';
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--prefix' && args[i + 1]) {
    prefix = args[i + 1];
  }
}
if (!prefix) process.exit(1);
const pkgSpec = args[args.length - 1] || '@anthropic-ai/claude-code';
const atIndex = pkgSpec.lastIndexOf('@');
const pkgName = atIndex > 0 ? pkgSpec.slice(0, atIndex) : pkgSpec;
const cliPath = path.join(prefix, 'node_modules', ...pkgName.split('/'), 'cli.js');
fs.mkdirSync(path.dirname(cliPath), { recursive: true });
const payload = process.env.CC_MIRROR_FAKE_NPM_PAYLOAD || 'claude dummy';
// Include team mode function for testing - disabled by default (can be patched)
const teamModeFunc = 'function sU(){return!1}';
fs.writeFileSync(cliPath, '#!/usr/bin/env node\\n' + teamModeFunc + '\\n' + 'console.log(' + JSON.stringify(payload) + ');\\n');
fs.chmodSync(cliPath, 0o755);
`;
  writeExecutable(npmPath, script);
  return npmPath;
};

/**
 * Execute a function with fake npm in PATH
 */
export const withFakeNpm = (fn: () => void) => {
  const binDir = makeTempDir();
  const homeDir = makeTempDir();
  createFakeNpm(binDir);
  const previousPath = process.env.PATH || '';
  const previousHome = process.env.HOME;
  const previousShell = process.env.SHELL;
  process.env.PATH = `${binDir}:${previousPath}`;
  process.env.HOME = homeDir;
  process.env.SHELL = '/bin/bash';
  try {
    fn();
  } finally {
    process.env.PATH = previousPath;
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = previousShell;
    }
    delete process.env.CC_MIRROR_FAKE_NPM_PAYLOAD;
    cleanup(binDir);
    cleanup(homeDir);
  }
};
