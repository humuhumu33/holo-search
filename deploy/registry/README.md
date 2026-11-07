# The Prism registry

The registry every Prism app registers with on deploy, and the source of the
Prism index. [kappa-registry](https://github.com/UOR-Foundation/kappa-registry)
stores the holos (OCI, content-addressed, attestations as referrers). In front
of it, the gateway in `gateway/` decides who may write.

- **Anyone reads.** `prism-code pull <host>/prism/<owner>/<name>@blake3:<fingerprint>`
  fetches a holo and verifies it before writing it.
- **Only a repository's own deploy writes its name.** A GitHub Actions run
  proves which repository it is with the OIDC token GitHub mints for it. The
  gateway then lets it push to `prism/<owner>/<name>` and nowhere else. There
  is no secret to hand out, so every new app can register on its first deploy.
- **The registration log.** After a push, `bootstrap/register.mjs` (in the
  template's page files) records the app's live page against the holo's
  fingerprint: `POST /prism/register`. Holo Search's index workflow reads
  `GET /prism/registrations`. It lists an app only when its live page serves
  a holo the app registered, and that holo verifies with every example passing.

## Run it

On a machine with Docker, and a DNS name pointing at it:

```bash
cd deploy/registry
cp .env.example .env    # REGISTRY_HOST, and two secrets: openssl rand -hex 32
docker compose up -d --build
curl https://$REGISTRY_HOST/healthz
```

Caddy gets a Let's Encrypt certificate for `REGISTRY_HOST`. kappa-registry
and the gateway are reachable only inside the compose network. Data lives in
named volumes; back up `kappa-data` (blobs, `state.redb`, `keys/`) and
`gateway-data` (`registrations.jsonl`).

## Switch it on

1. In Holo Search: set the repository variable `PRISM_REGISTRY` to the host.
   The index workflow then reads registrations as well as `registry/apps.json`.
2. In the template: set `DEFAULT_REGISTRY` in `bootstrap/register.mjs` to the
   host and run `frame-sync --lock`. Every app that pins the template's page
   files from then on registers on each deploy.

## Test it on one machine

`test/issuer.mjs` is a stand-in for GitHub's OIDC issuer: it mints tokens shaped
like an Actions run's, for any repository.

```bash
KAPPA_STORE_ROOT=./data KAPPA_LISTEN_ADDR=127.0.0.1:5000 KAPPA_AUTH_TOKENS=t=prism-gateway kappa-server &
node test/issuer.mjs 127.0.0.1:5002 &
GATEWAY_LISTEN=127.0.0.1:5011 KAPPA_URL=http://127.0.0.1:5000 KAPPA_WRITE_TOKEN=t \
  OIDC_ISSUER=http://127.0.0.1:5002 OIDC_JWKS_URL=http://127.0.0.1:5002/.well-known/jwks \
  node gateway/gateway.mjs &
# In an app's checkout, as that app:
PRISM_REGISTRY=127.0.0.1:5011 PRISM_REGISTRY_TOKEN=$(node test/issuer.mjs 127.0.0.1:5002 --mint owner/name) \
  node bootstrap/register.mjs site
```
