#!/usr/bin/env node
import fs from 'fs';
import path from 'path';

const root = process.cwd();
const webappDir = path.join(root, 'webapp');
const webappPkg = path.join(webappDir, 'package.json');
const webappModules = path.join(webappDir, 'node_modules');

if (!fs.existsSync(webappPkg) || !fs.existsSync(webappModules)) {
  console.error(
    'Webapp dependencies missing. Run `npm run install:webapp` or `npm run install:all` first.',
  );
  process.exit(1);
}
