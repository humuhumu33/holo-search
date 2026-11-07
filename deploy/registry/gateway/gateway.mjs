#!/usr/bin/env node
// The Prism registry gateway: the public face of the canonical kappa
// registry for Prism apps, at https://registry.uor.foundation.
//
// kappa indexes every Prism app by its self-verifying address; the app's
// bytes stay where its repository publishes them. Through this gateway:
//   - Anyone reads kappa: GET/HEAD /v2/... (an app's address card is
//     prism/<owner>/<name>:blake3-<fingerprint>). Nothing writes through it;
//     the indexer beside kappa is its only Prism writer.
//   - A GitHub Actions run registers its own app: POST /prism/register with
//     the OIDC token GitHub mints for the run (no secret to hand out) and
//     {fingerprint, live, name}. The token's repository claim is the app's
//     repository. The indexer then checks that the live page serves that holo,
//     that it verifies and that every example passes, and only then writes its
//     address card into kappa and lists it.
//       GET /prism/registrations            every registration, newest last
//       GET /prism/registrations?since=<n>  those after sequence n
//   - Every downstream client reads the index the indexer keeps:
//       GET /index/current.json     the pointer, never cached
//       GET /index/<sha256>.json    a snapshot, immutable
//       GET /index/apps.json        the listed apps as a search index (a JSON
//                                   list of {sha256, blake3, module, bytes,
//                                   kind, live, repository}), never cached
//   - Anything by its self-verifying address:
//       GET /prism/by/<digest>[.holo|.json]
//     A listed app's BLAKE3 fingerprint, or its holo's SHA-256, redirects to
//     where its repository publishes the bytes (the bytes never pass through
//     here, and the client checks them against the address); a snapshot's
//     SHA-256 serves the snapshot.
// kappa's other endpoints stay inside. No dependencies: node:http,
// node:crypto and fetch.
import { createPublicKey, verify as verifySignature } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import http from "node:http";
import { dirname, join } from "node:path";

const env = (name, fallback) => process.env[name] ?? fallback;
const LISTEN = env("GATEWAY_LISTEN", "127.0.0.1:5001");
const PUBLIC_URL = new URL(env("GATEWAY_PUBLIC_URL", `http://${LISTEN}`));
const REGISTRY = new URL(env("KAPPA_URL", "http://127.0.0.1:5000"));
const ISSUER = env("OIDC_ISSUER", "https://token.actions.githubusercontent.com");
const JWKS_URL = env("OIDC_JWKS_URL", `${ISSUER}/.well-known/jwks`);
const AUDIENCE = env("OIDC_AUDIENCE", "prism-registry");
const PREFIX = env("GATEWAY_PREFIX", "prism");
const LOG = env("GATEWAY_LOG", "./data/registrations.jsonl");
const INDEX = env("INDEX_DIR", join(dirname(LOG), "index"));
const MAX_BODY = 64 * 1024;

// -- OIDC ----------------------------------------------------------------------
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

// -- Registrations ---------------------------------------------------------------
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

// -- The index, as clients read it -----------------------------------------------------
let listed = { sha256: null, apps: [], byDigest: new Map() };
async function currentApps() {
  const pointer = JSON.parse(await readFile(join(INDEX, "current.json"), "utf8"));
  if (pointer.sha256 === listed.sha256) return listed;
  const snapshot = JSON.parse(await readFile(join(INDEX, `${pointer.sha256}.json`), "utf8"));
  const apps = (snapshot.apps ?? []).filter((app) => /^[0-9a-f]{64}$/.test(app.fingerprint ?? "") && /^[0-9a-f]{64}$/.test(app.holo?.sha256 ?? "") && /^https:\/\//.test(app.holo?.url ?? ""));
  const byDigest = new Map();
  for (const app of apps) {
    byDigest.set(app.fingerprint, app);
    byDigest.set(app.holo.sha256, app);
  }
  listed = { sha256: pointer.sha256, apps, byDigest };
  return listed;
}

// -- HTTP --------------------------------------------------------------------------
const json = (res, status, body, headers = {}) => {
  const text = status === 204 ? "" : JSON.stringify(body);
  res.writeHead(status, { ...(text ? { "content-type": "application/json", "content-length": Buffer.byteLength(text) } : {}), "access-control-allow-origin": "*", ...headers });
  res.end(text);
};
const refuse = (res, status, code, message) => json(res, status, { errors: [{ code, message }] });
const bearer = (req) => req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1] ?? null;
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

// A read, forwarded to kappa as an anonymous one.
async function forward(req, res) {
  const headers = { ...req.headers, host: REGISTRY.host };
  for (const name of ["connection", "authorization", "cookie"]) delete headers[name];
  const upstream = await fetch(new URL(req.url, REGISTRY), { method: req.method, headers, redirect: "manual" });
  const out = Object.fromEntries(upstream.headers.entries());
  delete out["transfer-encoding"];
  out["access-control-allow-origin"] = "*";
  out["access-control-expose-headers"] = "docker-content-digest, content-type, content-length";
  if (out.location) out.location = out.location.replace(REGISTRY.origin, PUBLIC_URL.origin);
  res.writeHead(upstream.status, out);
  if (req.method === "HEAD" || !upstream.body) return res.end();
  for await (const chunk of upstream.body) res.write(chunk);
  res.end();
}

async function handle(req, res) {
  const url = new URL(req.url, PUBLIC_URL);
  if (req.method === "OPTIONS") return json(res, 204, null, { "access-control-allow-headers": "authorization, content-type, accept", "access-control-allow-methods": "GET, HEAD, POST, OPTIONS", "access-control-max-age": "86400" });

  if (url.pathname === "/prism/register" && req.method === "POST") {
    const oidc = bearer(req);
    if (!oidc) return refuse(res, 401, "UNAUTHORIZED", "a GitHub Actions OIDC token for the audience prism-registry is required");
    let claims;
    try {
      claims = await verifyOidc(oidc);
    } catch (error) {
      return refuse(res, 401, "DENIED", `the OIDC token was refused: ${error.message}`);
    }
    let card;
    try {
      card = JSON.parse((await body(req)).toString("utf8"));
    } catch {
      return refuse(res, 400, "INVALID", "the body is not JSON");
    }
    const fingerprint = String(card.fingerprint ?? "").replace(/^blake3:/, "");
    const live = String(card.live ?? "");
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) return refuse(res, 400, "INVALID", "fingerprint is not a BLAKE3 hex digest");
    if (!/^https:\/\/[^\s]+\/$/.test(live) && !(PUBLIC_URL.protocol === "http:" && /^http:\/\/[^\s]+\/$/.test(live))) return refuse(res, 400, "INVALID", "live is not an https URL ending in /");
    const repository = `${PREFIX}/${claims.repository.toLowerCase()}`;
    const entry = await record({
      repository: claims.repository,
      address: `${PUBLIC_URL.host}/${repository}:blake3-${fingerprint}`,
      fingerprint,
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

  const indexFile = url.pathname.match(/^\/index\/(current|[0-9a-f]{64})\.json$/)?.[1];
  if (indexFile && ["GET", "HEAD"].includes(req.method)) {
    const bytes = await readFile(join(INDEX, `${indexFile}.json`)).catch(() => null);
    if (!bytes) return refuse(res, 404, "NOT_FOUND", "no such index file");
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": bytes.length,
      "access-control-allow-origin": "*",
      "cache-control": indexFile === "current" ? "no-cache" : "public, max-age=31536000, immutable",
    });
    return res.end(req.method === "HEAD" ? undefined : bytes);
  }

  if (url.pathname === "/index/apps.json" && ["GET", "HEAD"].includes(req.method)) {
    const { apps } = await currentApps();
    const list = apps.map((app) => ({ sha256: app.holo.sha256, blake3: app.fingerprint, module: app.name, bytes: app.holo.bytes, kind: "holo", live: app.live, repository: app.repository }));
    return json(res, 200, list, { "cache-control": "no-cache" });
  }

  const byAddress = url.pathname.match(/^\/prism\/by\/([0-9a-f]{64})(\.holo|\.json)?$/);
  if (byAddress && ["GET", "HEAD"].includes(req.method)) {
    const [, digest, ext = ""] = byAddress;
    const snapshot = ext !== ".holo" ? await readFile(join(INDEX, `${digest}.json`)).catch(() => null) : null;
    if (snapshot) {
      res.writeHead(200, { "content-type": "application/json", "content-length": snapshot.length, "access-control-allow-origin": "*", "cache-control": "public, max-age=31536000, immutable" });
      return res.end(req.method === "HEAD" ? undefined : snapshot);
    }
    const app = ext !== ".json" ? (await currentApps()).byDigest.get(digest) : null;
    if (!app) return refuse(res, 404, "NOT_FOUND", `no listed app or snapshot has the address ${digest}`);
    res.writeHead(302, { location: app.holo.url, "access-control-allow-origin": "*", "cache-control": "no-cache" });
    return res.end();
  }

  if (url.pathname.startsWith("/v2/") || url.pathname === "/v2") {
    if (!["GET", "HEAD"].includes(req.method)) return json(res, 405, { errors: [{ code: "UNSUPPORTED", message: "read-only: an app registers its address with POST /prism/register" }] }, { allow: "GET, HEAD" });
    return forward(req, res);
  }

  if (url.pathname === "/" || url.pathname === "/healthz") return json(res, 200, { ok: true, registry: "kappa-registry", prefix: PREFIX, issuer: ISSUER, audience: AUDIENCE, index: "/index/current.json" });
  refuse(res, 404, "NOT_FOUND", "no such path");
}

const [host, port] = LISTEN.split(":");
await loadLog();
http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    console.error(`${req.method} ${req.url}: ${error.message}`);
    if (!res.headersSent) refuse(res, 502, "UPSTREAM", error.message);
    else res.end();
  });
}).listen(Number(port), host, () => console.log(`prism registry gateway on ${LISTEN}, public ${PUBLIC_URL.origin}, kappa ${REGISTRY.origin}, log ${LOG}`));
