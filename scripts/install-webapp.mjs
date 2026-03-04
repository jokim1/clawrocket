#!/usr/bin/env node
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const webappDir = path.join(root, 'webapp');
const webappPkg = path.join(webappDir, 'package.json');

if (!fs.existsSync(webappPkg)) {
  console.warn(
    'Webapp scaffold not found (webapp/package.json is missing). Skipping webapp install for this branch.',
  );
  process.exit(0);
}

const result = spawnSync('npm', ['--prefix', 'webapp', 'install'], {
  stdio: 'inherit',
  cwd: root,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
