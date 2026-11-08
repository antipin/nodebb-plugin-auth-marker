# nodebb-plugin-auth-marker: design notes

Status (2026-11-08): design agreed in review. The hook-based draft from the first research
pass was dropped; see "Implementation" for why.

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
  and NodeBB resets the cookie to `0`. The next request (`nbb_auth=0`) is cacheable and
  gets no `Set-Cookie`, so there is no bypass loop.
- The marker can expire before `express.sid`, because it is only re-sent when its value
  changes. The next request then has `express.sid` and no marker, so it bypasses the cache
  and NodeBB sets the marker again: one uncached request per expiry, per browser. The
  marker's `maxAge` is the session TTL, so this happens about as often as the session
  itself would expire.
- Login and logout responses carry the new value (see "Implementation"). Those routes are
  never cached.
- A forged cookie only skips the cache. Access is still decided by `express.sid`.
- The cookie is `httpOnly`, since only the proxy reads it.
- `Set-Cookie` is sent only when the value changes.

## Implementation

The marker is decided when the response headers are written, not when the request
arrives:

- `static:app.preload({ app })` registers one `app.use()` middleware. It runs after
  `Auth.setAuthVars` and before every route.
- The middleware registers an [`on-headers`](https://www.npmjs.com/package/on-headers)
  listener (the same mechanism `express-session` uses for its own cookie). When the
  headers go out, it computes `want = (!!req.user && !req.isSpider()) ? '1' : '0'`. If
  `req.cookies.nbb_auth !== want`, it adds one `nbb_auth` cookie to the existing
  `Set-Cookie` header list (append, never replace, so `express.sid` is kept).
- passport's `req.login()` / `req.logout()` change `req.user` during the request, so
  whatever response the login or logout happens on (form `POST /login`, an SSO
  `/auth/*/callback` redirect, `POST /api/v3/utilities/login`, logout) carries the right
  value. This doesn't depend on `action:user.loggedIn` or `static:user.loggedOut` firing on
  every login path, and there is at most one `nbb_auth` `Set-Cookie` per response.
- Cookie options: `meta.configs.cookie.get()` (same domain, path, secure and SameSite as
  `express.sid`), plus `httpOnly: true` and `maxAge: meta.getSessionTTLSeconds() * 1000`.
- The listener never throws. Errors are caught and logged with winston, because an
  exception inside `on-headers` would break the response.

Why the first draft (an `app.use()` check at request time, plus `action:user.loggedIn`
and `static:user.loggedOut` hooks) was dropped:

1. A wrong `nbb_auth=0` on a logged-in user is never corrected, because "`0` +
   `express.sid`" is cached and the request never reaches NodeBB. Correctness would depend
   on the login hook firing on every login path, including SSO plugins and API login.
2. On a login POST from a visitor with no marker, the response would carry two
   `nbb_auth` cookies (`0` from the middleware, then `1` from the hook).

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

- Hard rule: never cache `/login`, `/register`, `/reset`, `/logout`, `/auth/*`, `/api/*`
  or `/socket.io/*`. Logins happen on these routes, and their responses carry the new
  marker value.
- If `sessionKey` has been changed from the default, the regex must match the new name.
- Varnish or Traefik: same rule, cache only when the table above says so.

## Out of scope (still open for guest caching, see forum.hiv.plus #30)

1. A guest's first page carries `Set-Cookie: express.sid`, so the proxy must ignore and
   hide `Set-Cookie` on cached guest responses.
2. The page HTML embeds the session's CSRF token (`config.csrf_token`). A cached page shares
   one token across guests, so guest form POSTs (login, register) would fail the CSRF
   check. Keep those routes uncached, or make guests stateless.

## Next steps

Development happens in iterations, each on a local branch reviewed before it is merged:

1. Tooling: commitlint, semantic-release, CI.
2. Integration tests against a NodeBB 4.x container. These must fail against the skeleton
   plugin first. They cover: guest gets `0`; form login sets `1` (exactly one `nbb_auth`
   cookie, `express.sid` kept); API login sets `1`; logout sets `0`; a session from before
   the plugin (no marker) gets `1`; a stale `1` without a valid session gets `0` and then
   no further `Set-Cookie`; a spider user agent gets `0`; unchanged state sends no
   `Set-Cookie`.
3. The implementation above.
4. README with the table and proxy configs.
5. Install it into the forum.hiv.plus image as a local plugin (a separate PR there).

## Notes

- The `forum-nginx-cache` session may be working on the proxy side; coordinate with it.
- Owner preferences: no "Generated with Claude Code" footers in PRs, issues or commits.
  Side tasks go into GitHub issues.
