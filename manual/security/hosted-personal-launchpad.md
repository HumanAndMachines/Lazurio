# Hosted personal Launchpad entry

Design under qualification, not an enabled deployment. A personal Launchpad
belongs to exactly one Principal; Organization access and provider service
access are separate authorities. The selected Organizations remain that
Principal's responsibility after their own GitHub login.

## Boundary and selected implementation

Keep the standard OIDC relying party responsible for login, callback state,
nonce, PKCE, cookies and refresh. Launchpad is the resource consumer and checks
current native resource introspection on every personal request. Machines owns
the loopback services, private HTTPS gateway, exact deployment input and secret
custody; it does not become another personal ACL or account store.

One provider-derived consumer projection binds issuer, browser client, exact
resource, HTTPS origin and immutable owner GitHub ID. Launchpad obtains the
server-held access token from the stock RP's loopback auth endpoint using only
the exact RP cookie, then authenticates independently to the issuer's standard
introspection endpoint. The issuer returns the *current* linked identity. The
application never trusts a browser identity header or an ID token as resource
authorization. The introspection credential is server-only and resource-scoped.

This avoids an extra admission daemon and avoids extending the Organization
Workspace pilot exception. The personal profile is explicit; do not label it
as an Organization, strip Origin to pretend the browser is local, or infer
ownership from a mutable GitHub login/email.

## Required integrated proof before activation

- Correct owner over actual Code + PKCE, stock RP, HTTPS gateway and Launchpad.
- Another owner, an Organization administrator without ownership, anonymous
  requests, forged identity headers, foreign audiences, expiry, native logout,
  unlink/relink and issuer outage all fail closed.
- Requests do not cache a previous allow. Mutation origin/Fetch Metadata checks
  survive the gateway; loopback service maintenance is kept separately scoped.
- RP access/refresh tokens and auth response headers never reach the browser or
  application data routes. The token-emitting RP endpoint is loopback-only.
- Existing long connections reauthorize within the resource budget; they cannot
  live indefinitely on an earlier cookie. Admission is point-in-time, not atomic
  with provider changes. Durable T3 and Headscale access have separate lifetimes.
- Synthetic contents only; operational verification does not read another
  Principal's Personalspace. Public `.ai` navigation and private `.io` entry
  remain separate.

Rollback disables the new private web entry and its exact issuer clients,
leaving VM data, owner SSH and other clients intact. Partial configuration or
missing credentials prevents activation. Ownership transfer requires a new
qualified provisioning/data-custody operation, never an incidental config edit.
