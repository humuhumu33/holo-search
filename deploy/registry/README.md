# The Prism registry

One canonical kappa registry indexes every Prism app by its self-verifying
address, at `https://registry.uor.foundation`. An app's bytes stay where its
repository publishes them (its GitHub Pages site); kappa holds its address.
Holo Search and every app's address bar read the index downstream.

kappa itself is the hub's ([kappa-registry](https://github.com/UOR-Foundation/kappa-registry),
`hub-kappa`, in `/root/hub` on the VPS). This folder adds, on the same
Docker network:

- **`gateway/`**, the public face. Anyone reads kappa (`GET /v2/...`); nothing
  writes through it. A GitHub Actions run registers its own app with
  `POST /prism/register`, proving its repository with the OIDC token GitHub
  mints for the run (audience `prism-registry`, no secret to hand out). It
  serves the index at `/index/current.json` (never cached) and
  `/index/<sha256>.json` (immutable).
- **`indexer/`**, kappa's only Prism writer. Candidates compound: every app
  that registered, every Prism app on the Pages sites of `DISCOVER_OWNERS` and
  of every owner that ever registered, found once and checked forever. An app
  is listed only when its live `app.json` names its repository, its live
  `app.holo` verifies, it is a holo the repository registered (when it
  registered any) and every example passes. Then its address card is stored
  in kappa:

  ```
  prism/<owner>/<name>:blake3-<fingerprint>   (and :latest)
  {"spec":"prism/address/1","address":"blake3:…","sha256":"…","bytes":…,
   "name":"…","repository":"https://github.com/…","locations":["…/app.holo"],
   "examples":{"passed":…,"total":…}}
  ```

  An OCI artifact (`application/vnd.prism.address.v1+json`). Anyone holding
  the address resolves it to the card, fetches the bytes from a location and
  checks both digests. The gateway also resolves an address directly:
  `GET /prism/by/<blake3 fingerprint or sha256>[.holo]` answers with a
  redirect to the bytes on GitHub (they never pass through the registry),
  and `GET /index/apps.json` lists every indexed app with both addresses,
  in the shape Holo Search searches. AI artifacts in the hub's registry are listed by
  repository, tag and manifest digest. It re-checks every app every ten
  minutes, a registration at once, and discovers and lists artifacts hourly.

## Run it

On the VPS, beside the hub, with the host's Caddy terminating TLS:

```bash
cd /opt/prism-registry
cp .env.example .env              # REGISTRY_HOST, DISCOVER_OWNERS, optional GITHUB_TOKEN
docker compose up -d --build
```

Add `Caddyfile`'s site block to the host's Caddyfile and reload Caddy, and
point `REGISTRY_HOST`'s A record at the host (DNS only). Data lives in
`./data`: `registrations.jsonl`, `discovered.json`, `stars.json` and `index/`.

## Test it on one machine

`test/issuer.mjs` stands in for GitHub's OIDC issuer and mints tokens for any
repository.

```bash
KAPPA_STORE_ROOT=./kdata KAPPA_LISTEN_ADDR=127.0.0.1:5000 KAPPA_AUTH_REQUIRED=false kappa-server &
node test/issuer.mjs 127.0.0.1:5002 &
GATEWAY_LISTEN=127.0.0.1:5011 KAPPA_URL=http://127.0.0.1:5000 GATEWAY_LOG=./data/registrations.jsonl \
  OIDC_ISSUER=http://127.0.0.1:5002 OIDC_JWKS_URL=http://127.0.0.1:5002/.well-known/jwks \
  node gateway/gateway.mjs &
DATA=./data KAPPA_URL=http://127.0.0.1:5000 DISCOVER_OWNERS=humuhumu33 node indexer/indexer.mjs --once
# In an app's checkout, as that app:
PRISM_REGISTRY=127.0.0.1:5011 PRISM_REGISTRY_TOKEN=$(node test/issuer.mjs 127.0.0.1:5002 --mint owner/name) \
  node bootstrap/register.mjs site
```
