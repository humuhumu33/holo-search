#!/usr/bin/env node
// The Prism registry gateway: the public face of kappa-registry for Prism
// apps. Anyone reads. A GitHub Actions run writes, and only to the
// repository it is building: it proves which repository it is with the
// OIDC token GitHub mints for every run (no secret to distribute), and the
// gateway lets it push to prism/<owner>/<name> and nowhere else.
//
// It speaks the OCI distribution token flow, so `prism-code push`, docker,
// skopeo and crane all work unchanged:
//   1. a write without a token gets 401 and a Bearer challenge naming /token;
//   2. GET /token?scope=repository:prism/o/n:push,pull with Basic auth whose
//      password is the OIDC token returns a short-lived gateway token when
//      the OIDC token's repository claim is o/n;
//   3. writes with that token are forwarded to kappa-registry with the
//      gateway's own registry token; reads are forwarded as they come.
// After a push, POST /prism/register (OIDC again) records the app's live
// page and fingerprint in the registration log the indexer reads:
//   GET /prism/registrations            every registration, newest last
//   GET /prism/registrations?since=<n>  those after sequence n
// kappa-registry itself listens only on localhost; nothing reaches it but
// this gateway. No dependencies: node:http, node:crypto and fetch.
import { createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";

const env = (name, fallback) => process.env[name] ?? fallback ?? (() => { throw new Error(`${name} is not set`); })();
const LISTEN = env("GATEWAY_LISTEN", "127.0.0.1:5001");
const PUBLIC_URL = new URL(env("GATEWAY_PUBLIC_URL", `http://${LISTEN}`));
const REGISTRY = new URL(env("KAPPA_URL", "http://127.0.0.1:5000"));
const REGISTRY_TOKEN = env("KAPPA_WRITE_TOKEN", "");
const SECRET = env("GATEWAY_SECRET", randomBytes(32).toString("hex"));
const ISSUER = env("OIDC_ISSUER", "https://token.actions.githubusercontent.com");
const JWKS_URL = env("OIDC_JWKS_URL", `${ISSUER}/.well-known/jwks`);
const AUDIENCE = env("OIDC_AUDIENCE", "prism-registry");
const PREFIX = env("GATEWAY_PREFIX", "prism");
const LOG = env("GATEWAY_LOG", "./data/registrations.jsonl");
const TOKEN_TTL = 600;
const MAX_BODY = 1024 * 1024;

// -- JSON Web Tokens -----------------------------------------------------
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const fromB64url = (text) => Buffer.from(text, "base64url");

// GitHub's signing keys, cached for ten minutes; a key id not in the cache
// refreshes it once, so a rotation costs one extra fetch.
let jwks = { keys: [], at: 0 };
async function keyFor(kid) {
  const stale = Date.now() - jwks.at > 600e3;
  if (stale || !jwks.keys.some((key) => key.kid === kid)) {
    const response = await fetch(JWKS_URL);
    if (!response.ok) throw new Error(`the issuer's keys could not be read (${response.status})`);
    jwks = { keys: (await response.json()).keys ?? [], at: Date.now() };
  }
  const jwk = jwks.keys.find((key) => key.kid === kid && (key.alg ?? "RS256") === "RS256");
  return jwk ? createPublicKey({ key: jwk, format: "jwk" }) : null;
}

// An OIDC token: RS256, from the issuer, for this audience, in its time, and
// with the claims a GitHub Actions run carries. Returns the claims.
async function verifyOidc(token) {
  const [h, p, s] = String(token).split(".");
  if (!h || !p || !s) throw new Error("not a token");
  const header = JSON.parse(fromB64url(h));
  if (header.alg !== "RS256") throw new Error(`alg ${header.alg} is not RS256`);
  const key = await keyFor(header.kid);
  if (!key) throw new Error("the token's key is not the issuer's");
  if (!verifySignature("sha256", Buffer.from(`${h}.${p}`), key, fromB64url(s))) throw new Error("the signature does not verify");
  const claims = JSON.parse(fromB64url(p));
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error(`issuer ${claims.iss} is not ${ISSUER}`);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(AUDIENCE)) throw new Error(`audience is not ${AUDIENCE}`);
  if (typeof claims.exp !== "number" || claims.exp < now - 30) throw new Error("the token has expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + 30) throw new Error("the token is not valid yet");
  if (!/^[\w.-]+\/[\w.-]+$/.test(claims.repository ?? "")) throw new Error("no repository claim");
  return claims;
}

// The gateway's own tokens: HS256, naming the one repository they may write.
function issueToken(repository, claims) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: PUBLIC_URL.origin, sub: claims.repository, repository, exp: now + TOKEN_TTL, iat: now, run: claims.run_id ?? null, sha: claims.sha ?? null, workflow: claims.job_workflow_ref ?? claims.workflow_ref ?? null };
  const head = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64url(JSON.stringify(payload));
  const signature = createHmac("sha256", SECRET).update(`${head}.${body}`).digest("base64url");
  return { token: `${head}.${body}.${signature}`, expires_in: TOKEN_TTL, issued_at: new Date(now * 1000).toISOString() };
}
function readToken(token) {
  const [h, p, s] = String(token ?? "").split(".");
  if (!h || !p || !s) return null;
  const expected = createHmac("sha256", SECRET).update(`${h}.${p}`).digest();
  const given = fromB64url(s);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const payload = JSON.parse(fromB64url(p));
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// -- The registry's names --------------------------------------------------
// A GitHub repository owner/name as its OCI repository: lower case, under the prefix.
const repositoryOf = (claimed) => `${PREFIX}/${claimed.toLowerCase()}`;
// kappa-registry hands out upload sessions at /v2/_uploads/<id>, outside the
// repository's path; the gateway remembers which repository each session it
// started belongs to, so every chunk of an upload is checked like its start.
const uploads = new Map();
// The OCI repository a /v2/ path names, and whether the request writes.
function target(method, pathname) {
  const session = pathname.match(/^\/v2\/_uploads\/([^/?]+)/)?.[1];
  const match = pathname.match(/^\/v2\/(.+?)\/(blobs|manifests|tags|referrers)(\/|$)/);
  const repository = session ? uploads.get(session)?.repository ?? null : match?.[1] ?? null;
  const writes = !["GET", "HEAD", "OPTIONS"].includes(method);
  return { repository, writes, session };
}

// -- Registrations -----------------------------------------------------------
let sequence = 0;
async function loadLog() {
  const text = await readFile(LOG, "utf8").catch(() => "");
  const lines = text.split("\n").filter(Boolean);
  sequence = lines.length;
  return lines.map((line) => JSON.parse(line));
}
async function record(entry) {
  await mkdir(dirname(LOG), { recursive: true });
  sequence += 1;
  const line = { sequence, at: new Date().toISOString(), ...entry };
  await appendFile(LOG, `${JSON.stringify(line)}\n`);
  return line;
}

// -- HTTP ------------------------------------------------------------------
const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), "access-control-allow-origin": "*", ...headers });
  res.end(text);
};
const challenge = (res, scope) => json(res, 401, { errors: [{ code: "UNAUTHORIZED", message: "authentication required" }] }, { "www-authenticate": `Bearer realm="${PUBLIC_URL.origin}/token",service="${PUBLIC_URL.host}"${scope ? `,scope="${scope}"` : ""}` });
const bearer = (req) => req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ?? null;
const basicPassword = (req) => {
  const raw = req.headers.authorization?.match(/^Basic (.+)$/i)?.[1];
  if (!raw) return null;
  const text = Buffer.from(raw, "base64").toString("utf8");
  return text.slice(text.indexOf(":") + 1);
};
async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Forward a request to kappa-registry, with the gateway's token when it writes.
async function forward(req, res, writes, repository = null) {
  const url = new URL(req.url, REGISTRY);
  const headers = { ...req.headers, host: REGISTRY.host };
  delete headers.connection;
  if (writes) headers.authorization = `Bearer ${REGISTRY_TOKEN}`;
  else delete headers.authorization;
  const upstream = await fetch(url, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : req, duplex: "half", redirect: "manual" });
  const out = Object.fromEntries(upstream.headers.entries());
  delete out["transfer-encoding"];
  out["access-control-allow-origin"] = "*";
  // A Location the registry wrote for itself is rewritten to this gateway.
  if (out.location) out.location = out.location.replace(REGISTRY.origin, PUBLIC_URL.origin);
  // An upload session this request opened belongs to its repository, for an hour.
  const session = out.location?.match(/\/v2\/_uploads\/([^/?]+)/)?.[1];
  if (writes && repository && session) {
    uploads.set(session, { repository, until: Date.now() + 3600e3 });
    for (const [id, kept] of uploads) if (kept.until < Date.now()) uploads.delete(id);
  }
  res.writeHead(upstream.status, out);
  if (req.method === "HEAD" || !upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

async function handle(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  if (req.method === "OPTIONS") return json(res, 204, {}, { "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, HEAD, OPTIONS" });

  if (url.pathname === "/token" && req.method === "GET") {
    const scope = url.searchParams.get("scope") ?? "";
    const wanted = scope.match(/^repository:([^:]+):([a-z,]+)$/);
    const oidc = basicPassword(req) ?? bearer(req);
    if (!oidc) return challenge(res, scope);
    let claims;
    try {
      claims = await verifyOidc(oidc);
    } catch (error) {
      return json(res, 401, { errors: [{ code: "DENIED", message: `the OIDC token was refused: ${error.message}` }] });
    }
    const allowed = repositoryOf(claims.repository);
    if (wanted && wanted[1] !== allowed) return json(res, 403, { errors: [{ code: "DENIED", message: `${claims.repository} may push to ${allowed} only` }] });
    return json(res, 200, issueToken(allowed, claims));
  }

  if (url.pathname === "/prism/register" && req.method === "POST") {
    const oidc = bearer(req);
    if (!oidc) return challenge(res);
    let claims;
    try {
      claims = await verifyOidc(oidc);
    } catch (error) {
      return json(res, 401, { errors: [{ code: "DENIED", message: `the OIDC token was refused: ${error.message}` }] });
    }
    let card;
    try {
      card = JSON.parse((await body(req)).toString("utf8"));
    } catch {
      return json(res, 400, { errors: [{ code: "INVALID", message: "the body is not JSON" }] });
    }
    const fingerprint = String(card.fingerprint ?? "");
    const live = String(card.live ?? "");
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) return json(res, 400, { errors: [{ code: "INVALID", message: "fingerprint is not a blake3 hex digest" }] });
    if (!/^https:\/\/[^\s]+\/$/.test(live) && !(PUBLIC_URL.protocol === "http:" && /^http:\/\/[^\s]+\/$/.test(live))) return json(res, 400, { errors: [{ code: "INVALID", message: "live is not an https URL ending in /" }] });
    const repository = repositoryOf(claims.repository);
    // The holo must be in the registry under this repository, by its fingerprint tag.
    const probe = await fetch(new URL(`/v2/${repository}/manifests/blake3-${fingerprint}`, REGISTRY), { method: "HEAD", headers: { accept: "application/vnd.oci.image.manifest.v1+json" } });
    if (!probe.ok) return json(res, 409, { errors: [{ code: "NOT_PUSHED", message: `no holo with fingerprint ${fingerprint} is pushed to ${repository}` }] });
    const entry = await record({
      repository: claims.repository,
      reference: `${PUBLIC_URL.host}/${repository}@blake3:${fingerprint}`,
      fingerprint,
      digest: probe.headers.get("docker-content-digest"),
      live,
      name: typeof card.name === "string" ? card.name.slice(0, 120) : null,
      run: claims.run_id ?? null,
      sha: claims.sha ?? null,
      workflow: claims.job_workflow_ref ?? claims.workflow_ref ?? null,
    });
    return json(res, 201, entry);
  }

  if (url.pathname === "/prism/registrations" && req.method === "GET") {
    const since = Number(url.searchParams.get("since") ?? 0);
    const entries = await loadLog();
    return json(res, 200, { spec: "prism/registrations/1", sequence, entries: entries.filter((e) => e.sequence > since) });
  }

  if (url.pathname.startsWith("/v2/") || url.pathname === "/v2") {
    const { repository, writes } = target(req.method, url.pathname);
    if (!writes) return forward(req, res, false);
    const scope = repository ? `repository:${repository}:push,pull` : "";
    const granted = readToken(bearer(req));
    if (!granted) return challenge(res, scope);
    if (!repository || granted.repository !== repository) return json(res, 403, { errors: [{ code: "DENIED", message: `this token writes ${granted.repository} only` }] });
    return forward(req, res, true, repository);
  }

  if (url.pathname === "/" || url.pathname === "/healthz") return json(res, 200, { ok: true, registry: "kappa-registry", prefix: PREFIX, issuer: ISSUER, audience: AUDIENCE });
  json(res, 404, { errors: [{ code: "NOT_FOUND", message: "no such path" }] });
}

const [host, port] = LISTEN.split(":");
await loadLog();
http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(`${req.method} ${req.url}: ${error.message}`);
    if (!res.headersSent) json(res, 502, { errors: [{ code: "UPSTREAM", message: error.message }] });
    else res.end();
  });
}).listen(Number(port), host, () => console.log(`prism registry gateway on ${LISTEN}, public ${PUBLIC_URL.origin}, registry ${REGISTRY.origin}, log ${LOG}`));
