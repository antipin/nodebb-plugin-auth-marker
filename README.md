# nodebb-plugin-auth-marker

A NodeBB plugin that sets an `nbb_auth` cookie (`1` = logged in, `0` = guest) so a reverse
proxy like nginx, Varnish or Traefik can tell guests from logged-in users and cache guest
pages safely. Sessions it hasn't marked yet go to NodeBB, so users logged in before the
plugin are never served the guest page.

NodeBB's own cookies can't do this: `express.sid` is sent to guests too (NodeBB saves a
session for every visitor that renders a page, to hold its CSRF token), and `io` goes to
everyone.

Compatible with NodeBB 4.x (CI runs 4.0.0 and 4.16.7) and Node.js 22 or later.

## Install

```sh
npm install nodebb-plugin-auth-marker
./nodebb activate nodebb-plugin-auth-marker
./nodebb build && ./nodebb restart
```

Or install and activate it from the ACP (Extend → Plugins). There is nothing to configure.

Until the first release is on npm, install from a checkout instead:
`npm install /path/to/nodebb-plugin-auth-marker`.

## What it does

On every response, when the headers are written, the plugin works out the marker value:

- `1` if the request has a logged-in user
- `0` for guests and for spiders (NodeBB treats spiders as guests)

If the request doesn't already carry that value, the plugin sends
`Set-Cookie: nbb_auth=<value>`. Otherwise it sends nothing.

The value is computed at the end of the request, so the response that logs a user in or out
carries the new value. This works the same for every login path: the login form, SSO
callbacks and `POST /api/v3/utilities/login`. Each response carries at most one `nbb_auth`
cookie, and other `Set-Cookie` headers such as `express.sid` are left alone.

The cookie uses the same domain, path, `Secure` and `SameSite=Lax` settings as NodeBB's
session cookie. It is `HttpOnly`, because only the proxy reads it, and `Max-Age` is the
session lifetime (ACP → Settings → Advanced → "Days to remember user login sessions").

## Proxy rules

Cache a request only when it is known to come from a guest:

| Request has                       | Proxy  | Why                                                                         |
|-----------------------------------|--------|-----------------------------------------------------------------------------|
| no cookies at all                 | cache  | new visitor or a crawler that drops cookies                                 |
| `nbb_auth=0`                      | cache  | known guest                                                                 |
| `nbb_auth=1`                      | bypass | logged in                                                                   |
| `express.sid` but no `nbb_auth`   | bypass | not known yet (a session from before the plugin, or an expired marker); NodeBB sets the marker on this response |

Never cache these routes, whatever the cookies say. Logins happen on them, and their
responses carry the new marker value:

`/login`, `/register`, `/reset`, `/logout`, `/auth/*`, `/api/*`, `/socket.io/*`

If NodeBB runs under a subpath (`relative_path`), put the prefix in front of these paths.

API clients that send a Bearer token get `nbb_auth=1`, because NodeBB treats them as logged
in. That's harmless, since `/api` is never cached.

### On the cached path, drop cookies both ways

The marker is a `Set-Cookie` like any other. It goes out on whatever response first sees a
changed state: a page, a redirect, a static asset, or every response to a crawler that
drops cookies. NodeBB also sends a guest `Set-Cookie: express.sid=…` on the first page it
renders. So on the requests the proxy caches:

- **Strip `Set-Cookie` from the response before it is stored and served.** Otherwise one
  visitor's session cookie is handed to every guest who gets the cached copy. And nginx by
  default doesn't store responses that carry `Set-Cookie`, so the cache would never fill.
- **Don't send the request's cookies to NodeBB.** The page is then rendered for an
  anonymous guest, the same for everyone.
- **Ignore NodeBB's `Cache-Control: private, no-cache`.** Recent NodeBB releases (4.16.7,
  for example) send it on every page, and both nginx and Varnish refuse to store such
  responses by default. (NodeBB 4.0.0 sends no `Cache-Control` on pages; the configs below
  work with both.)

Do this only on the cached path. Bypassed requests must keep both, or logins break.

Some guest responses have no `Cache-Control` at all (`/robots.txt`, `/sitemap.xml`, RSS
feeds). The configs below store those for `proxy_cache_valid` (nginx, 1 minute) or
Varnish's `default_ttl` (120 seconds by default).

### nginx

nginx can't read `$cookie_express.sid` because of the dot, so the session cookie is matched
in the raw `Cookie` header. Cacheable requests are sent to a named location that strips the
cookies. Everything else goes straight to NodeBB, untouched:

```nginx
# http {} context
proxy_cache_path /var/cache/nginx/nodebb keys_zone=nodebb:10m max_size=1g inactive=10m;

map $http_cookie $nbb_has_sid {
    default                   0;
    "~(^|;\s*)express\.sid="  1;
}

map "$cookie_nbb_auth:$nbb_has_sid" $nbb_guest {
    "0:1"    1;  # known guest with a session
    "0:0"    1;  # known guest, no session
    ":0"     1;  # no cookies at all
    default  0;  # logged in, or not known yet: let NodeBB decide
}

map $uri $nbb_cacheable_uri {
    default                                    1;
    "~^/(login|register|reset|logout)(/|$)"    0;
    "~^/(auth|api|socket\.io)/"                0;
}

map "$request_method:$nbb_guest:$nbb_cacheable_uri" $nbb_use_cache {
    default    0;
    "GET:1:1"  1;
    "HEAD:1:1" 1;
}
```

Both locations include the same proxy headers from one snippet. That's needed: nginx only
inherits `proxy_set_header` from the outer level when a block defines none of its own, so the
`proxy_set_header Cookie ""` below would otherwise drop `Host`, `X-Forwarded-For` and the
rest on the cached path.

```nginx
# /etc/nginx/snippets/nodebb-proxy.conf
proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header Upgrade           $http_upgrade;
proxy_set_header Connection        $connection_upgrade;
```

```nginx
# http {} context, for the Connection header above
map $http_upgrade $connection_upgrade {
    default  upgrade;
    ""       "";
}
```

```nginx
# server {} context
location / {
    error_page 418 = @nodebb_cached;
    if ($nbb_use_cache) { return 418; }

    include snippets/nodebb-proxy.conf;
    proxy_pass http://nodebb;      # logged in, unknown, POSTs, never-cache routes
}

location @nodebb_cached {
    include snippets/nodebb-proxy.conf;    # see above: not inherited here
    proxy_pass http://nodebb;
    proxy_set_header Cookie "";            # render for an anonymous guest
    proxy_ignore_headers Set-Cookie Cache-Control Expires;  # store it anyway
    proxy_hide_header Set-Cookie;          # and never hand out its cookies
    proxy_cache nodebb;
    proxy_cache_key $scheme$host$request_uri;
    proxy_cache_valid 200 301 302 1m;
    add_header X-Cache-Status $upstream_cache_status always;
}
```

If you changed `sessionKey` in NodeBB's `config.json`, use that name in the first map.

### Varnish

```vcl
sub vcl_recv {
    if (req.method != "GET" && req.method != "HEAD") {
        return (pass);
    }
    if (req.url ~ "^/(login|register|reset|logout)(/|\?|$)" ||
        req.url ~ "^/(auth|api|socket\.io)/") {
        return (pass);  # never cached
    }
    if (req.http.Cookie ~ "(^|;\s*)nbb_auth=1(;|$)") {
        return (pass);  # logged in
    }
    if (req.http.Cookie ~ "(^|;\s*)express\.sid=" &&
        req.http.Cookie !~ "(^|;\s*)nbb_auth=0(;|$)") {
        return (pass);  # not known yet: NodeBB sets the marker
    }
    # Known guest or no cookies: render for an anonymous guest, cache it
    unset req.http.Cookie;
    return (hash);
}

sub vcl_backend_response {
    if (bereq.uncacheable) {
        return (deliver);  # bypassed: pass everything through untouched
    }
    unset beresp.http.Set-Cookie;  # cached path only
    if (beresp.status == 200 || beresp.status == 301 || beresp.status == 302) {
        if (beresp.http.Cache-Control ~ "private|no-cache|no-store") {
            # Pages: recent NodeBB sends "private, no-cache". Let Varnish store them for a
            # minute, and keep browsers revalidating.
            set beresp.http.Cache-Control = "no-cache";
            set beresp.ttl = 1m;
        }
        # Assets keep NodeBB's own public max-age, for browsers and for Varnish.
    } else {
        set beresp.ttl = 0s;
        set beresp.uncacheable = true;
    }
    return (deliver);
}
```

### Traefik

Traefik (open source) has no HTTP cache, so it can't do this by itself. Put Varnish or
nginx between Traefik and NodeBB (Traefik → cache → NodeBB) with one of the configs above,
or use a CDN in front. Any other cache or CDN follows the same rule: cache only when the
table above says so, and on that path drop the request cookies, the response `Set-Cookie`
and NodeBB's `Cache-Control: private`.

## Before you turn the cache on

This plugin only tells the proxy who is logged in. Two more things need handling, and both
are outside this plugin:

1. **Guest language.** By default NodeBB picks each guest's language from their
   `Accept-Language` header ("Auto Detect Language Setting for Guests", on by default) and
   sends no `Vary: Accept-Language`. The configs above don't key the cache on language, so
   the first guest's language would be served to every guest until the entry expires.
   Turn the setting off in ACP → Settings → General, under the language settings, so every
   guest gets the default language. A `?lang=` link still works, because it is part of the
   URL and therefore of the cache key. (Keying the cache on a normalized language would
   also work, but it needs a map that mirrors NodeBB's language list. Keying on the raw
   `Accept-Language` header would ruin the hit ratio. Neither is covered here.)
2. **CSRF tokens in the HTML.** NodeBB puts a CSRF token in every page
   (`config.csrf_token`). On a cached page every guest gets the same token, and it doesn't
   match their own session, so a guest form POST made from a cached page fails the CSRF
   check. The login and register pages themselves are never cached (see the routes above),
   so their forms work. If guests can do anything else (post, vote, flag), test it, or keep
   those pages off the cache.

## Costs

- A session from before the plugin goes to NodeBB once, and that response sets the marker.
- The marker is only sent when its value changes, so it can expire before `express.sid`.
  The next request then has a session and no marker, so it goes to NodeBB once and gets the
  marker again. Because the marker lasts as long as a session, this happens about as often
  as a session would expire anyway.
- A session that expires or is revoked while the cookie says `1` goes to NodeBB once, and
  that response resets the cookie to `0`. The next request is cacheable again.

## Security

The cookie is only a caching hint. A forged `nbb_auth` can only make the proxy skip the
cache (`1`), or serve the cached guest page (`0`) that anyone can see anyway. Access is still
decided by NodeBB's session cookie.

## Development

```sh
npm ci
npm test                    # unit tests, no Docker needed
npm run test:up             # MongoDB + NodeBB with the packed plugin, in Docker
npm run test:integration    # the integration suite against http://localhost:4567
npm run test:down
```

`test:up` also starts nginx (port 8080) and Varnish (port 8081) in front of the forum,
built from the configs in this README by `integration/proxy/extract.js`, plus copies of
both in front of a header-echo server (8082, 8083). The integration suite checks the
README configs as well as the plugin, so a change to either is tested.

`NODEBB_VERSION=4.0.0 npm run test:up` picks another NodeBB image. `npm run test:logs`
shows the forum's log.

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (a commit-msg
hook checks them). Releases to npm and GitHub are made by semantic-release from `main`:
`fix:` makes a patch release, `feat:` a minor one, and a `BREAKING CHANGE:` footer a
major one.

See [docs/DESIGN.md](docs/DESIGN.md) for the design notes.

## License

MIT
