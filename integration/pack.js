'use strict';

// Packs the plugin the way npm publishes it, to .test/plugin.tgz, for the test container.
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', '.test');
fs.mkdirSync(dir, { recursive: true });
const [{ filename }] = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', dir], {
	cwd: path.join(__dirname, '..'),
	encoding: 'utf8',
}));
fs.renameSync(path.join(dir, filename), path.join(dir, 'plugin.tgz'));
console.log(`packed ${filename} -> .test/plugin.tgz`);
