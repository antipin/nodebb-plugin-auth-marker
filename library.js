'use strict';

const onHeaders = require('on-headers');

const winston = require.main.require('winston');
const meta = require.main.require('./src/meta');

const COOKIE = 'nbb_auth';

const plugin = {};

// 1 = logged in, 0 = guest (spiders count as guests, like req.loggedIn in NodeBB).
// Read when the headers are written, so a login or logout during this request counts.
function markerValue(req) {
	const spider = typeof req.isSpider === 'function' && req.isSpider();
	return req.user && !spider ? '1' : '0';
}

function cookieOptions() {
	return {
		// Same domain, path, secure and SameSite as NodeBB's own session cookie
		...meta.configs.cookie.get(),
		httpOnly: true,
		maxAge: meta.getSessionTTLSeconds() * 1000,
	};
}

function setMarker(req, res) {
	try {
		const value = markerValue(req);
		if (req.cookies?.[COOKIE] !== value) {
			// res.cookie appends to Set-Cookie, so express.sid and others are kept
			res.cookie(COOKIE, value, cookieOptions());
		}
	} catch (err) {
		// Never break the response over the marker
		winston.error(`[plugin/auth-marker] could not set the ${COOKIE} cookie: ${err.stack || err.message}`);
	}
}

plugin.preload = async ({ app }) => {
	app.use((req, res, next) => {
		onHeaders(res, () => setMarker(req, res));
		next();
	});
};

module.exports = plugin;
