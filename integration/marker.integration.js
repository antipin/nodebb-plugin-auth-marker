'use strict';

// Integration tests against a real NodeBB with the packed plugin installed and activated.
// Start the stack first: npm run test:up (see integration/docker-compose.yml).

const { test, before } = require('node:test');
const assert = require('node:assert/strict');

const BASE_URL = process.env.NODEBB_URL || 'http://localhost:4567';
const USERNAME = process.env.NODEBB_ADMIN_USERNAME || 'admin';
const PASSWORD = process.env.NODEBB_ADMIN_PASSWORD || 'AuthMarker-Test-1';
const SESSION_COOKIE = 'express.sid';
const MARKER = 'nbb_auth';
const SPIDER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

// --- helpers -----------------------------------------------------------------------------

function parseSetCookie(header) {
	const [pair, ...attrs] = header.split(';').map(s => s.trim());
	const eq = pair.indexOf('=');
	const cookie = { name: pair.slice(0, eq), value: decodeURIComponent(pair.slice(eq + 1)), attrs: {} };
	for (const attr of attrs) {
		const i = attr.indexOf('=');
		const key = (i === -1 ? attr : attr.slice(0, i)).toLowerCase();
		cookie.attrs[key] = i === -1 ? true : attr.slice(i + 1);
	}
	return cookie;
}

const setCookies = res => res.headers.getSetCookie().map(parseSetCookie);
const markerCookies = res => setCookies(res).filter(c => c.name === MARKER);

function isExpired(cookie) {
	return cookie.attrs['max-age'] === '0' ||
		(cookie.attrs.expires && new Date(cookie.attrs.expires) <= new Date());
}

// A minimal cookie jar: name -> value, updated from responses.
class Jar {
	constructor(cookies = {}) {
		this.cookies = { ...cookies };
	}

	update(res) {
		for (const c of setCookies(res)) {
			if (isExpired(c)) {
				delete this.cookies[c.name];
			} else {
				this.cookies[c.name] = c.value;
			}
		}
	}

	header() {
		return Object.entries(this.cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('; ');
	}

	without(name) {
		const copy = new Jar(this.cookies);
		delete copy.cookies[name];
		return copy;
	}
}

async function request(path, { jar, method = 'GET', body, headers = {}, ua = BROWSER_UA } = {}) {
	const h = { 'user-agent': ua, ...headers };
	if (jar && Object.keys(jar.cookies).length) {
		h.cookie = jar.header();
	}
	if (body !== undefined) {
		h['content-type'] = 'application/json';
	}
	const res = await fetch(BASE_URL + path, {
		method,
		headers: h,
		body: body === undefined ? undefined : JSON.stringify(body),
		redirect: 'manual',
	});
	await res.arrayBuffer();
	if (jar) {
		jar.update(res);
	}
	return res;
}

async function csrfToken(jar) {
	const res = await fetch(`${BASE_URL}/api/config`, {
		headers: { 'user-agent': BROWSER_UA, cookie: jar.header() },
	});
	const config = await res.json();
	jar.update(res);
	assert.ok(config.csrf_token, 'expected a CSRF token from /api/config');
	return config.csrf_token;
}

async function formLogin(jar = new Jar()) {
	const token = await csrfToken(jar);
	const res = await request('/login', {
		jar,
		method: 'POST',
		body: { username: USERNAME, password: PASSWORD },
		headers: { 'x-csrf-token': token },
	});
	assert.equal(res.status, 200, `form login failed with HTTP ${res.status}`);
	return { jar, res };
}

async function isLoggedIn(jar) {
	const res = await fetch(`${BASE_URL}/api/config`, {
		headers: { 'user-agent': BROWSER_UA, cookie: jar.header() },
	});
	const config = await res.json();
	return config.loggedIn === true;
}

function assertSingleMarker(res, value) {
	const markers = markerCookies(res);
	assert.equal(markers.length, 1, `expected exactly one ${MARKER} Set-Cookie, got ${JSON.stringify(res.headers.getSetCookie())}`);
	assert.equal(markers[0].value, value);
	return markers[0];
}

function assertNoMarker(res) {
	assert.deepEqual(markerCookies(res), [], `expected no ${MARKER} Set-Cookie, got ${JSON.stringify(res.headers.getSetCookie())}`);
}

// --- tests -------------------------------------------------------------------------------

before(async () => {
	const deadline = Date.now() + 60_000;
	for (;;) {
		try {
			const res = await fetch(`${BASE_URL}/api/config`);
			if (res.ok) {
				return;
			}
		} catch {
			// not up yet
		}
		if (Date.now() > deadline) {
			throw new Error(`NodeBB is not reachable at ${BASE_URL}; run npm run test:up`);
		}
		await new Promise(r => setTimeout(r, 1000));
	}
});

test('a new visitor without cookies gets nbb_auth=0', async () => {
	const res = await request('/');
	assert.equal(res.status, 200);
	assertSingleMarker(res, '0');
});

test('the marker cookie has the expected attributes', async () => {
	const marker = assertSingleMarker(await request('/'), '0');
	assert.equal(marker.attrs.httponly, true, 'HttpOnly');
	assert.equal(marker.attrs.path, '/');
	assert.equal(String(marker.attrs.samesite).toLowerCase(), 'lax');
	assert.ok(Number(marker.attrs['max-age']) > 0, 'Max-Age should be the session TTL');
});

test('a known guest with nbb_auth=0 gets no Set-Cookie for the marker', async () => {
	const jar = new Jar();
	await request('/', { jar });
	assert.equal(jar.cookies[MARKER], '0', 'first request should set the marker');
	assertNoMarker(await request('/', { jar }));
});

test('a spider gets nbb_auth=0', async () => {
	assertSingleMarker(await request('/', { ua: SPIDER_UA }), '0');
});

test('form login sets nbb_auth=1 once and keeps the session cookie', async () => {
	const jar = new Jar();
	await request('/', { jar }); // a guest with a marker and a session first
	const { res } = await formLogin(jar);
	assertSingleMarker(res, '1');
	const sids = setCookies(res).filter(c => c.name === SESSION_COOKIE);
	assert.equal(sids.length, 1, 'login should still send the regenerated express.sid');
	assert.ok(await isLoggedIn(jar));
});

test('form login from a visitor with no marker sends exactly one nbb_auth', async () => {
	const { res } = await formLogin(new Jar());
	assertSingleMarker(res, '1');
});

test('API login (/api/v3/utilities/login) sets nbb_auth=1', async () => {
	const jar = new Jar();
	const token = await csrfToken(jar);
	const res = await request('/api/v3/utilities/login', {
		jar,
		method: 'POST',
		body: { username: USERNAME, password: PASSWORD },
		headers: { 'x-csrf-token': token },
	});
	assert.equal(res.status, 200, `API login failed with HTTP ${res.status}`);
	assertSingleMarker(res, '1');
	assert.ok(await isLoggedIn(jar));
});

test('a logged-in user with nbb_auth=1 gets no Set-Cookie for the marker', async () => {
	const { jar } = await formLogin();
	assert.equal(jar.cookies[MARKER], '1');
	assertNoMarker(await request('/', { jar }));
});

test('a session from before the plugin (express.sid, no marker) gets nbb_auth=1', async () => {
	const { jar } = await formLogin();
	const legacy = jar.without(MARKER);
	assert.ok(legacy.cookies[SESSION_COOKIE]);
	assertSingleMarker(await request('/', { jar: legacy }), '1');
});

test('a stale nbb_auth=1 without a valid session is reset to 0, then left alone', async () => {
	const jar = new Jar({ [MARKER]: '1' });
	assertSingleMarker(await request('/', { jar }), '0');
	assert.equal(jar.cookies[MARKER], '0');
	assertNoMarker(await request('/', { jar }));
});

test('logout sets nbb_auth=0', async () => {
	const { jar } = await formLogin();
	const token = await csrfToken(jar);
	const res = await request('/logout', { jar, method: 'POST', headers: { 'x-csrf-token': token } });
	assert.ok(res.status < 400, `logout failed with HTTP ${res.status}`);
	assertSingleMarker(res, '0');
	assert.equal(await isLoggedIn(jar), false);
});
