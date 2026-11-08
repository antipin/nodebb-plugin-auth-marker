# nodebb-plugin-auth-marker: design notes

Status (2026-11-08): research done, draft code below, nothing built or tested yet.

## Goal

A NodeBB plugin that sets an `nbb_auth` cookie (`1` = logged in, `0` = guest), so a
reverse proxy (nginx, Varnish, Traefik) can cache guest pages and bypass the cache for
logged-in users.

First target: forum.hiv.plus (NodeBB 4.16.7, Express 4.22.3, MongoDB). Its edge is Traefik
today. See issue #30 in `antipin/forum.hiv.plus` ("Varnish guest cache with stateless
guests", design only).

## Prior art: none

- NodeBB issue [#5418](https://github.com/NodeBB/NodeBB/issues/5418) (2017) asked for a
  "loggedin" cookie for nginx. A maintainer closed it the next day ("NodeBB is fast
  enough"). It was never built.
- npm search ("nodebb cache", "nodebb cookie", "nodebb varnish", "logged in cookie"):
  only auto-login and session-sharing plugins, which solve a different problem.
- The NodeBB docs' Varnish VCL only covers websockets.

## Why existing cookies don't work

- `express.sid` goes to guests too. `src/webserver.js` uses `saveUninitialized: false`,
  but csrf-sync (`src/middleware/csrf.js`) writes the CSRF token into the session on every
  page render, so guest sessions get saved anyway (forum.hiv.plus has ~1.34M guest and
  crawler sessions).
- The `io` cookie goes to everyone.

## Facts from the NodeBB 4.16.7 source

- `src/routes/authentication.js`: `Auth.initialize` calls `app.use(passport.initialize())`
  and `app.use(passport.session())`, then `app.use(Auth.setAuthVars)`:
  - `req.loggedIn = !req.isSpider() && !!req.user`
  - `req.uid` is the user's uid, `-1` for spiders, `0` for guests

  This runs in `setupExpressApp`, before the plugins are initialised.
- `src/webserver.js` `initializeNodeBB`: `plugins.init` → `static:assets.prepare` →
  `static:app.preload({ app, middleware })` → `routes(app)`. So `app.use()` in
  `static:app.preload` runs after the auth vars are set and before every route.
  (`static:app.load` fires later, inside routes, from `plugins.reloadRoutes` with
  `{ app, router, middleware, controllers }`.)
- `src/controllers/authentication.js`:
  - `action:user.loggedIn({ uid, req })` fires in `onSuccessfulLogin` (~line 412).
  - `static:user.loggedOut({ req, res, uid, sessionID })` fires on logout (~line 498).
  - Logout clears the session cookie with
    `res.clearCookie(nconf.get('sessionKey'), meta.configs.cookie.get())`.
- `src/meta/configs.js` `Configs.cookie.get()` returns `{ domain, secure, path, sameSite }`:
  `domain` only if `cookieDomain` is set, `secure` only if nconf `secure` is set, `path`
  only if `relative_path` isn't empty, and `sameSite: 'Lax'` always.
- The session cookie's `maxAge` is `meta.getSessionTTLSeconds() * 1000` (`setupCookie` in
  `src/webserver.js`).
- Express 4: don't pass `maxAge` to `res.clearCookie`.

## Design: a three-state cookie

Problem: with a plain "cookie present = logged in" marker, users who logged in before the
plugin existed have no cookie. Once the cache is on, the proxy serves them the cached guest
page, and the request never reaches NodeBB to set the cookie. So the plugin marks guests
too, and the proxy caches only known guests.

| Request has                         | Proxy  | Why                                                                     |
|-------------------------------------|--------|-------------------------------------------------------------------------|
| no cookies at all                   | cache  | new visitor or a crawler that drops cookies                             |
| `nbb_auth=0`                        | cache  | known guest                                                             |
| `nbb_auth=1`                        | bypass | logged in                                                               |
| `express.sid` but no `nbb_auth`     | bypass | unknown (sessions from before the plugin, expired marker); NodeBB sets 0/1 |

- Cost: one uncached request per existing session.
- A session expires or is revoked while the cookie says `1`: the proxy bypasses the cache
  and NodeBB resets the cookie to `0`.
- The login POST is never cached; `action:user.loggedIn` sets `1` right away.
- A forged cookie only skips the cache. Access is still decided by `express.sid`.
- The cookie is `httpOnly`, since only the proxy reads it.
- `Set-Cookie` is sent only when the value changes.

## Draft code (untested)

`package.json`

```json
{
  "name": "nodebb-plugin-auth-marker",
  "version": "0.1.0",
  "description": "Sets a cookie for logged-in users so a reverse proxy can bypass its guest cache",
  "main": "library.js",
  "nbbpm": { "compatibility": "^4.0.0" }
}
```

`plugin.json`

```json
{
  "id": "nodebb-plugin-auth-marker",
  "library": "./library.js",
  "hooks": [
    { "hook": "static:app.preload",    "method": "preload" },
    { "hook": "action:user.loggedIn",  "method": "onLogin" },
    { "hook": "static:user.loggedOut", "method": "onLogout" }
  ]
}
```

`library.js`

```js
'use strict';

const meta = require.main.require('./src/meta');

const COOKIE = 'nbb_auth';
const plugin = {};

// Same domain / path / secure / SameSite=Lax as NodeBB's own express.sid
function baseOptions() {
	return { ...meta.configs.cookie.get(), httpOnly: true };
}

function setMarker(res, v) {
	res.cookie(COOKIE, v, { ...baseOptions(), maxAge: meta.getSessionTTLSeconds() * 1000 });
}

const value = req => (req.loggedIn ? '1' : '0');

// Keep the marker in sync with the session; Set-Cookie only when it changes
plugin.preload = async ({ app }) => {
	app.use((req, res, next) => {
		const want = value(req);
		if (req.cookies?.[COOKIE] !== want) {
			setMarker(res, want);
		}
		next();
	});
};

// On the login POST itself, the middleware above still saw a guest
plugin.onLogin = ({ req }) => req?.res && setMarker(req.res, '1');

// On the logout request, the middleware still saw a logged-in user
plugin.onLogout = async ({ res }) => res && setMarker(res, '0');

module.exports = plugin;
```

## Proxy side (for the README)

nginx can't read `$cookie_express.sid` because of the dot, so it matches the raw `Cookie`
header with a regex:

```nginx
map $http_cookie $nbb_has_sid {
    default                    0;
    "~(^|;\s*)express\.sid="   1;
}
map "$cookie_nbb_auth:$nbb_has_sid" $nbb_skip_cache {
    "0:1"   0;   # known guest
    "0:0"   0;   # guest marker, no session
    ":0"    0;   # no cookies at all
    default 1;   # logged in, or unknown -> let NodeBB decide
}

proxy_cache_bypass $nbb_skip_cache;
proxy_no_cache     $nbb_skip_cache;
```

- Never cache `/api`, `/socket.io`, `/login`, `/register` or `/reset`.
- If `sessionKey` has been changed from the default, the regex must match the new name.
- Varnish or Traefik: same rule, cache only when the table above says so.

## Out of scope (still open for guest caching, see forum.hiv.plus #30)

1. A guest's first page carries `Set-Cookie: express.sid`, so the proxy must ignore and
   hide `Set-Cookie` on cached guest responses.
2. The page HTML embeds the session's CSRF token (`config.csrf_token`). A cached page shares
   one token across guests, so guest form POSTs (login, register) would fail the CSRF
   check. Keep those routes uncached, or make guests stateless.

## Next steps

1. Scaffold the repo with the files above, plus a README with the table and the proxy
   configs.
2. Write an integration test against a NodeBB 4.x container. It should check:
   - a guest gets `0`
   - login sets `1`
   - logout sets `0`
   - a session from before the plugin, without the marker, gets fixed
   - a spider user agent gets `0`
   - an unchanged state sends no `Set-Cookie`
3. Install it into the forum.hiv.plus image as a local plugin (a separate PR there).

## Notes

- The `forum-nginx-cache` session may be working on the proxy side; coordinate with it.
- Owner preferences: no "Generated with Claude Code" footers in PRs, issues or commits.
  Side tasks go into GitHub issues.
