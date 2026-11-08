'use strict';

// Builds runnable nginx and Varnish configs from the code blocks in README.md, so the
// proxy tests check exactly what users copy. Writes to .test/proxy/.
//
// Test-only additions, kept outside the README text:
// - nginx: an `upstream nodebb {}` (pointed at NodeBB, or at the header-echo server),
//   a cache path under /tmp and a `listen` line.
// - Varnish: a backend, and a vcl_deliver that adds X-Cache-Status (HIT/MISS) on the
//   cached path only, like the nginx config does.

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const out = path.join(root, '.test', 'proxy');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

const blocks = [...readme.matchAll(/```(nginx|vcl)\n([\s\S]*?)```/g)].map(m => ({ lang: m[1], body: m[2] }));
const firstLine = b => b.body.split('\n')[0];

const nginx = blocks.filter(b => b.lang === 'nginx');
const snippet = nginx.filter(b => firstLine(b).includes('snippets/nodebb-proxy.conf'));
const server = nginx.filter(b => firstLine(b).includes('server {} context'));
const http = nginx.filter(b => firstLine(b).includes('http {} context'));
const vcl = blocks.filter(b => b.lang === 'vcl');

function expectOne(list, what) {
	if (list.length !== 1) {
		throw new Error(`README.md: expected one ${what} block, found ${list.length}`);
	}
	return list[0].body;
}
if (!http.length) {
	throw new Error('README.md: no "# http {} context" nginx block found');
}

function nginxConf(upstream) {
	return [
		'events {}',
		'http {',
		`upstream nodebb { server ${upstream}; }`,
		...http.map(b => b.body.replace(/proxy_cache_path \S+/, 'proxy_cache_path /tmp/nodebb-cache')),
		'server {',
		'listen 8080;',
		expectOne(server, '"# server {} context" nginx'),
		'}',
		'}',
		'',
	].join('\n');
}

function varnishVcl(host, port) {
	const body = expectOne(vcl, 'vcl')
		// mark passes so the test-only vcl_deliver can leave X-Cache-Status off them
		.replaceAll('return (pass);', 'set req.http.X-Test-Pass = "1"; return (pass);');
	return [
		'vcl 4.1;',
		`backend default { .host = "${host}"; .port = "${port}"; }`,
		'sub vcl_deliver {',
		'    if (!req.http.X-Test-Pass) {',
		'        if (obj.hits > 0) { set resp.http.X-Cache-Status = "HIT"; }',
		'        else { set resp.http.X-Cache-Status = "MISS"; }',
		'    }',
		'}',
		body,
	].join('\n');
}

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'nodebb-proxy.conf'), expectOne(snippet, 'nginx snippet'));
fs.writeFileSync(path.join(out, 'nginx.conf'), nginxConf('nodebb:4567'));
fs.writeFileSync(path.join(out, 'nginx-echo.conf'), nginxConf('echo:8000'));
fs.writeFileSync(path.join(out, 'default.vcl'), varnishVcl('nodebb', '4567'));
fs.writeFileSync(path.join(out, 'echo.vcl'), varnishVcl('echo', '8000'));
console.log('proxy configs from README.md -> .test/proxy/');
