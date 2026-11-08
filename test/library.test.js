'use strict';

// Unit tests for library.js without NodeBB: meta and winston are stubbed through
// require.main.require, and the middleware is driven through plugin.preload().

const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const stubs = {
	winston: { error: mock.fn() },
	'./src/meta': {
		configs: { cookie: { get: () => ({ sameSite: 'Lax' }) } },
		getSessionTTLSeconds: () => 1209600,
	},
};
const realCookieGet = stubs['./src/meta'].configs.cookie.get;

// Under node --test, this file is require.main, so keep its own requires working.
const originalRequire = require.main.require.bind(require.main);
require.main.require = id => (id in stubs ? stubs[id] : originalRequire(id));

const plugin = require('../library');

let middleware;
plugin.preload({ app: { use: (fn) => { middleware = fn; } } });

// Runs one request through the middleware and writes the headers.
function run(req) {
	const res = {
		cookie: mock.fn(),
		writeHead() {},
	};
	const next = mock.fn();
	middleware(req, res, next);
	assert.equal(next.mock.callCount(), 1, 'middleware should call next()');
	res.writeHead(200);
	return res;
}

const markerValues = res => res.cookie.mock.calls.map(c => c.arguments[1]);

beforeEach(() => {
	stubs.winston.error.mock.resetCalls();
	stubs['./src/meta'].configs.cookie.get = realCookieGet;
});

test('preload registers exactly one middleware', () => {
	assert.equal(typeof middleware, 'function');
});

test('no user -> 0', () => {
	assert.deepEqual(markerValues(run({ cookies: {}, isSpider: () => false })), ['0']);
});

test('user -> 1', () => {
	assert.deepEqual(markerValues(run({ cookies: {}, user: { uid: 1 }, isSpider: () => false })), ['1']);
});

test('user that is a spider -> 0', () => {
	assert.deepEqual(markerValues(run({ cookies: {}, user: { uid: 1 }, isSpider: () => true })), ['0']);
});

test('missing req.isSpider does not throw', () => {
	assert.deepEqual(markerValues(run({ cookies: {}, user: { uid: 1 } })), ['1']);
	assert.deepEqual(markerValues(run({})), ['0']);
	assert.equal(stubs.winston.error.mock.callCount(), 0);
});

test('no res.cookie call when the request already carries the value', () => {
	assert.equal(run({ cookies: { nbb_auth: '0' }, isSpider: () => false }).cookie.mock.callCount(), 0);
	assert.equal(run({ cookies: { nbb_auth: '1' }, user: { uid: 1 }, isSpider: () => false }).cookie.mock.callCount(), 0);
});

test('a changed value is set again', () => {
	assert.deepEqual(markerValues(run({ cookies: { nbb_auth: '1' }, isSpider: () => false })), ['0']);
	assert.deepEqual(markerValues(run({ cookies: { nbb_auth: '0' }, user: { uid: 1 }, isSpider: () => false })), ['1']);
});

test('the user is read when the headers are written, not when the request arrives', () => {
	const req = { cookies: {}, isSpider: () => false };
	const res = { cookie: mock.fn(), writeHead() {} };
	middleware(req, res, () => {});
	req.user = { uid: 1 }; // e.g. req.login() during the route
	res.writeHead(200);
	assert.deepEqual(markerValues(res), ['1']);
});

test('cookie options: NodeBB cookie settings plus httpOnly and the session TTL', () => {
	const [[name, value, options]] = run({ cookies: {} }).cookie.mock.calls.map(c => c.arguments);
	assert.equal(name, 'nbb_auth');
	assert.equal(value, '0');
	assert.deepEqual(options, { sameSite: 'Lax', httpOnly: true, maxAge: 1209600 * 1000 });
});

test('if meta.configs.cookie.get() throws, the response is not broken and winston logs it', () => {
	stubs['./src/meta'].configs.cookie.get = () => {
		throw new Error('boom');
	};
	const writeHead = mock.fn();
	const res = { cookie: mock.fn(), writeHead };
	middleware({ cookies: {} }, res, () => {});
	assert.doesNotThrow(() => res.writeHead(200));
	assert.equal(writeHead.mock.callCount(), 1, 'the original writeHead still runs');
	assert.equal(stubs.winston.error.mock.callCount(), 1);
	assert.match(stubs.winston.error.mock.calls[0].arguments[0], /boom/);
});

test('if res.cookie throws, the response is not broken and winston logs it', () => {
	const writeHead = mock.fn();
	const res = {
		cookie: () => {
			throw new Error('cookie failed');
		},
		writeHead,
	};
	middleware({ cookies: {} }, res, () => {});
	assert.doesNotThrow(() => res.writeHead(200));
	assert.equal(writeHead.mock.callCount(), 1, 'the original writeHead still runs');
	assert.equal(stubs.winston.error.mock.callCount(), 1);
	assert.match(stubs.winston.error.mock.calls[0].arguments[0], /cookie failed/);
});
