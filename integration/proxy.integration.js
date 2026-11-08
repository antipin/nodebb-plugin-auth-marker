'use strict';

// The nginx and Varnish configs from README.md, run in front of the test NodeBB.
// integration/proxy/extract.js builds them; npm run test:up starts them:
//   nginx   :8080 -> NodeBB      nginx-echo   :8082 -> header echo
//   Varnish :8081 -> NodeBB      varnish-echo :8083 -> header echo

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const NODEBB = process.env.NODEBB_URL || 'http://127.0.0.1:4567';
const USERNAME = process.env.NODEBB_ADMIN_USERNAME || 'admin';
const PASSWORD = process.env.NODEBB_ADMIN_PASSWORD || 'AuthMarker-Test-1';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const PROXIES = [
	{ name: 'nginx', url: 'http://127.0.0.1:8080', echo: 'http://127.0.0.1:8082' },
	{ name: 'Varnish', url: 'http://127.0.0.1:8081', echo: 'http://127.0.0.1:8083' },
];

// --- helpers -----------------------------------------------------------------------------

// node:http rather than fetch, so tests can set Host.
function request(base, path, { method = 'GET', cookies = {}, headers = {}, body } = {}) {
	const url = new URL(path, base);
	const h = { 'user-agent': UA, ...headers };
	const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
	if (cookie) {
		h.cookie = cookie;
	}
	const payload = body === undefined ? undefined : JSON.stringify(body);
	if (payload) {
		h['content-type'] = 'application/json';
		h['content-length'] = Buffer.byteLength(payload);
	}
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method, headers: h }, (res) => {
			const chunks = [];
			res.on('data', c => chunks.push(c));
			res.on('end', () => {
				const setCookie = (res.headers['set-cookie'] || []).map((s) => {
					const [pair] = s.split(';');
					const i = pair.indexOf('=');
					return { name: pair.slice(0, i), value: pair.slice(i + 1) };
				});
				resolve({
					status: res.statusCode,
					headers: res.headers,
					cache: res.headers['x-cache-status'],
					setCookie,
					body: Buffer.concat(chunks).toString('utf8'),
				});
			});
		});
		req.on('error', reject);
		req.end(payload);
	});
}

const cookieNames = res => res.setCookie.map(c => c.name);
const marker = res => res.setCookie.filter(c => c.name === 'nbb_auth').map(c => c.value);
const htmlLang = res => (res.body.match(/<html[^>]*\slang="([^"]+)"/) || [])[1];
const loggedIn = res => /"loggedIn":\s*true/.test(res.body);
const unique = path => `${path}${path.includes('?') ? '&' : '?'}t=${randomUUID()}`;

function keep(jar, res) {
	for (const { name, value } of res.setCookie) {
		if (value) {
			jar[name] = value;
		} else {
			delete jar[name];
		}
	}
	return jar;
}

async function login(base) {
	const jar = {};
	const cfg = await request(base, '/api/config', { cookies: jar });
	keep(jar, cfg);
	const res = await request(base, '/login', {
		method: 'POST',
		cookies: jar,
		headers: { 'x-csrf-token': JSON.parse(cfg.body).csrf_token },
		body: { username: USERNAME, password: PASSWORD },
	});
	assert.equal(res.status, 200, `login through ${base} failed with HTTP ${res.status}`);
	return { jar: keep(jar, res), res };
}

async function setNodebbConfig(key, value) {
	const { jar } = await login(NODEBB);
	const cfg = await request(NODEBB, '/api/config', { cookies: jar });
	const res = await request(NODEBB, `/api/v3/admin/settings/${key}`, {
		method: 'PUT',
		cookies: jar,
		headers: { 'x-csrf-token': JSON.parse(cfg.body).csrf_token },
		body: { value },
	});
	assert.equal(res.status, 200, `setting ${key} failed with HTTP ${res.status}`);
}

// Two requests to the same fresh URL: the first fills the cache, the second is the one to check.
async function twice(base, path, options) {
	const url = unique(path);
	const first = await request(base, url, options);
	const second = await request(base, url, options);
	return { first, second };
}

before(async () => {
	for (const base of [NODEBB, ...PROXIES.flatMap(p => [p.url, p.echo])]) {
		const deadline = Date.now() + 60_000;
		for (;;) {
			try {
				if ((await request(base, '/robots.txt')).status < 500) {
					break;
				}
			} catch {
				// not up yet
			}
			if (Date.now() > deadline) {
				throw new Error(`${base} is not reachable; run npm run test:up`);
			}
			await new Promise(r => setTimeout(r, 1000));
		}
	}
});

// --- tests -------------------------------------------------------------------------------

for (const proxy of PROXIES) {
	describe(`${proxy.name} (README config)`, () => {
		test('a visitor without cookies is served from the cache, with no Set-Cookie', async () => {
			const { first, second } = await twice(proxy.url, '/recent');
			assert.equal(first.status, 200);
			assert.equal(first.cache, 'MISS');
			assert.equal(second.cache, 'HIT');
			assert.deepEqual(cookieNames(first), [], 'cached path must not hand out cookies');
			assert.deepEqual(cookieNames(second), []);
			assert.equal(loggedIn(second), false);
		});

		test('a known guest (nbb_auth=0 and a session) gets the cached page', async () => {
			const guest = keep({}, await request(NODEBB, '/recent'));
			assert.equal(guest['nbb_auth'], '0');
			assert.ok(guest['express.sid']);
			const { second } = await twice(proxy.url, '/recent', { cookies: guest });
			assert.equal(second.cache, 'HIT');
			assert.deepEqual(cookieNames(second), []);
		});

		test('never-cache routes pass through with their cookies', async () => {
			for (const path of ['/api/config', '/login']) {
				const res = await request(proxy.url, path);
				assert.equal(res.cache, undefined, `${path} must not take the cached path`);
				assert.ok(cookieNames(res).includes('express.sid'), `${path} should set express.sid`);
			}
		});

		test('login through the proxy sets nbb_auth=1, and the user then bypasses the cache', async () => {
			const { jar, res } = await login(proxy.url);
			assert.deepEqual(marker(res), ['1']);
			const page = await request(proxy.url, unique('/recent'), { cookies: jar });
			assert.equal(page.cache, undefined, 'logged-in requests must bypass the cache');
			assert.equal(loggedIn(page), true);
			assert.deepEqual(marker(page), []);
		});

		test('a session from before the plugin bypasses the cache and gets nbb_auth=1', async () => {
			const { jar } = await login(NODEBB);
			delete jar['nbb_auth'];
			const page = await request(proxy.url, unique('/recent'), { cookies: jar });
			assert.equal(page.cache, undefined);
			assert.equal(loggedIn(page), true);
			assert.deepEqual(marker(page), ['1']);
		});

		test('a stale nbb_auth=1 without a session bypasses the cache and gets nbb_auth=0', async () => {
			const page = await request(proxy.url, unique('/recent'), { cookies: { nbb_auth: '1' } });
			assert.equal(page.cache, undefined);
			assert.deepEqual(marker(page), ['0']);
		});

		test('assets keep NodeBB\'s public max-age and are cached', async () => {
			for (const path of ['/assets/nodebb.min.js', '/assets/uploads/files/probe.txt']) {
				const { second } = await twice(proxy.url, path);
				assert.equal(second.status, 200, path);
				assert.equal(second.headers['cache-control'], 'public, max-age=5184000', path);
				assert.equal(second.cache, 'HIT', path);
			}
		});

		test('a 200 without Cache-Control (robots.txt) is cached and gets none added', async () => {
			// nginx stores it for proxy_cache_valid (1m); Varnish for its default_ttl (120s).
			const { first, second } = await twice(proxy.url, '/robots.txt');
			assert.equal(first.headers['cache-control'], undefined);
			assert.equal(second.cache, 'HIT');
			assert.equal(second.headers['cache-control'], undefined);
		});

		test('cached pages keep NodeBB\'s "revalidate" instruction to browsers, if it sent one', async () => {
			// NodeBB 4.16.7 sends "private, no-cache" on pages; 4.0.0 sends no Cache-Control.
			const direct = (await request(NODEBB, unique('/recent'))).headers['cache-control'];
			const { second } = await twice(proxy.url, '/recent');
			assert.equal(second.cache, 'HIT');
			if (/private|no-cache|no-store/.test(direct || '')) {
				assert.match(second.headers['cache-control'], /no-cache/);
			} else {
				assert.equal(second.headers['cache-control'], direct, 'nothing should be added');
			}
		});
	});

	describe(`${proxy.name} (README config) headers reaching the upstream`, () => {
		test('cached path: Host and X-Forwarded-For are kept, request cookies dropped, Set-Cookie stripped', async () => {
			const res = await request(proxy.echo, unique('/recent'), {
				headers: { host: 'forum.example.test' },
				cookies: { nbb_auth: '0', 'express.sid': 'guest-session' },
			});
			assert.equal(res.cache, 'MISS', 'should take the cached path');
			const { headers } = JSON.parse(res.body);
			assert.equal(headers.host, 'forum.example.test');
			assert.ok(headers['x-forwarded-for'], 'X-Forwarded-For should reach the upstream');
			if (proxy.name === 'nginx') {
				assert.equal(headers['x-forwarded-proto'], 'http');
				assert.ok(headers['x-real-ip']);
			}
			assert.equal(headers.cookie, undefined, 'request cookies must not reach the upstream');
			assert.deepEqual(cookieNames(res), [], 'Set-Cookie must be stripped');
		});

		test('bypass path: cookies go through both ways', async () => {
			const res = await request(proxy.echo, unique('/recent'), {
				headers: { host: 'forum.example.test' },
				cookies: { nbb_auth: '1', 'express.sid': 'user-session' },
			});
			assert.equal(res.cache, undefined, 'should bypass the cache');
			const { headers } = JSON.parse(res.body);
			assert.equal(headers.host, 'forum.example.test');
			assert.match(headers.cookie, /express\.sid=user-session/);
			assert.deepEqual(cookieNames(res), ['echo']);
		});
	});
}

describe('guest language (README: "Before you turn the cache on")', () => {
	after(() => setNodebbConfig('autoDetectLang', 1));

	test('with NodeBB\'s default auto-detection, the first guest\'s language is served to others', async () => {
		await setNodebbConfig('autoDetectLang', 1);
		for (const proxy of PROXIES) {
			const url = unique('/popular');
			const ru = await request(proxy.url, url, { headers: { 'accept-language': 'ru' } });
			const en = await request(proxy.url, url, { headers: { 'accept-language': 'en-US' } });
			assert.equal(htmlLang(ru), 'ru', proxy.name);
			assert.equal(en.cache, 'HIT', proxy.name);
			assert.equal(htmlLang(en), 'ru', `${proxy.name}: this is the leak the README warns about`);
		}
	});

	test('with auto-detection off, guests get the default language and ?lang= still works', async () => {
		await setNodebbConfig('autoDetectLang', 0);
		for (const proxy of PROXIES) {
			const url = unique('/popular');
			const ru = await request(proxy.url, url, { headers: { 'accept-language': 'ru' } });
			const en = await request(proxy.url, url, { headers: { 'accept-language': 'en-US' } });
			assert.equal(htmlLang(ru), 'en-GB', proxy.name);
			assert.equal(htmlLang(en), 'en-GB', proxy.name);

			const explicit = unique('/popular?lang=ru');
			await request(proxy.url, explicit, { headers: { 'accept-language': 'en-US' } });
			const again = await request(proxy.url, explicit, { headers: { 'accept-language': 'en-US' } });
			assert.equal(again.cache, 'HIT', proxy.name);
			assert.equal(htmlLang(again), 'ru', proxy.name);
		}
	});
});
