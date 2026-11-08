'use strict';

// Header-echo upstream for the proxy tests: answers like a NodeBB page
// (Cache-Control: private, no-cache, plus a Set-Cookie) with the request headers it got.
const http = require('node:http');

http.createServer((req, res) => {
	res.setHeader('Content-Type', 'application/json');
	res.setHeader('Cache-Control', 'private, no-cache');
	res.setHeader('Set-Cookie', 'echo=1; Path=/; HttpOnly');
	res.end(JSON.stringify({ url: req.url, headers: req.headers }));
}).listen(8000);
