#!/usr/bin/env node
// The Prism index, kept by the canonical kappa registry itself.
//
// One kappa registry indexes every Prism app and AI artifact by its content
// address; every other service (Holo Search, every app's address bar) reads
// it downstream. A Prism app's bytes stay where its repository publishes them
// (its GitHub Pages site); kappa holds its self-verifying address. The
// indexer runs beside kappa, is its only Prism writer, and keeps it current
// with no one's help:
//   - Candidates compound. Every app that registered from its own deploy
//     (the gateway's log), every Prism app found on the Pages sites of the
//     owners in DISCOVER_OWNERS and of every owner that ever registered, and
//     the seeds. An app found once is checked again forever.
//   - An app is listed only when, now, its live app.json names its
//     repository, its live app.holo verifies, it is one of the holos the
//     repository registered (when it registered any), and every acceptance
//     example passes. Anything else is listed under "rejected" with why.
//   - Every listed app's address is stored in kappa as an address card
//     (prism/address/1: the holo's BLAKE3 fingerprint, SHA-256 and size, and
//     where its bytes are), an OCI artifact at prism/<owner>/<name>, tagged
//     blake3-<fingerprint> and latest. Anyone holding the address resolves
//     it to the card, fetches the bytes and checks them against both digests.
//   - AI artifacts (the hub's models and buckets) are listed by repository,
//     tag and manifest digest; their bytes move into kappa later.
// It writes content-addressed snapshots, <sha256>.json, into $DATA/index and
// points current.json at them; the gateway serves them at /index/.
//   apps:      a registration, at once; every app, every ten minutes
//   discovery: every hour; AI artifacts: every hour
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadArchive } from "prism-code";
import { createRegistryClient } from "prism-code/node";

const env = (name, fallback) => process.env[name] ?? fallback;
const DATA = env("DATA", "./data");
const OUT = join(DATA, "index");
const LOG = env("GATEWAY_LOG", join(DATA, "registrations.jsonl"));
const KAPPA = new URL(env("KAPPA_URL", "http://127.0.0.1:5000"));
const PUBLIC_HOST = env("PUBLIC_HOST", KAPPA.host);
const PREFIX = env("GATEWAY_PREFIX", "prism");
const ARTIFACTS = env("ARTIFACTS_URL", "") ? new URL(env("ARTIFACTS_URL")) : null;
const ARTIFACTS_HOST = env("ARTIFACTS_HOST", ARTIFACTS?.host ?? "");
const OWNERS = env("DISCOVER_OWNERS", "").split(",").map((o) => o.trim()).filter(Boolean);
const SEEDS = env("SEEDS", "");
const GITHUB_TOKEN = env("GITHUB_TOKEN", "");
const APPS_EVERY = Number(env("APPS_EVERY_S", 600)) * 1e3;
const WIDE_EVERY = Number(env("WIDE_EVERY_S", 3600)) * 1e3;
const STARS_TTL = (GITHUB_TOKEN ? 600 : 3600) * 1e3;
const MAX_HOLO = 64 * 1024 * 1024;

const say = (text) => console.log(`${new Date().toISOString()} index: ${text}`);
const repoOf = (link) => (String(link ?? "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/) ?? [])[1] ?? "";
const slugOf = (name) => name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const github = (path) => fetch(`https://api.github.com${path}`, { headers: { accept: "application/vnd.github+json", "user-agent": "prism-index", ...(GITHUB_TOKEN ? { authorization: `Bearer ${GITHUB_TOKEN}` } : {}) } });
const readJson = (path, fallback) => readFile(path, "utf8").then(JSON.parse).catch(() => fallback);
async function writeAtomic(path, text) {
  await writeFile(`${path}.tmp`, text);
  await rename(`${path}.tmp`, path);
}
async function fetchBytes(url, limit) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30e3) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url} is larger than ${limit} bytes`);
  return bytes;
}
// Run at most `width` at once, in order.
async function pool(items, width, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await work(items[at]);
    }
  }));
  return out;
}

// -- Candidates ------------------------------------------------------------------
// discovered.json keeps every app ever found: { "owner/name": live }.
const DISCOVERED = join(DATA, "discovered.json");
async function registrations() {
  const text = await readFile(LOG, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
}
async function candidates() {
  const found = new Map();
  const add = (repository, live, registration, source) => {
    const key = repository.toLowerCase();
    const kept = found.get(key) ?? { repository, live, registrations: [], source };
    if (registration) {
      kept.registrations.push(registration);
      kept.live = new URL(registration.live).href;
      kept.source = "registered";
    }
    found.set(key, kept);
  };
  for (const [repository, live] of Object.entries(await readJson(DISCOVERED, {}))) add(repository, live, null, "discovered");
  for (const seed of SEEDS ? await readJson(SEEDS, []) : []) {
    const repository = repoOf(seed.repository);
    if (repository && /^https:\/\//.test(seed.live ?? "")) add(repository, new URL(seed.live).href, null, "seed");
  }
  for (const entry of await registrations()) add(entry.repository, entry.live, entry, "registered");
  return [...found.values()];
}

// Every public repository of each owner with a Pages site that serves a
// Prism app: app.json naming that repository, beside an app.holo.
async function discover() {
  const owners = new Set([...OWNERS, ...(await registrations()).map((e) => e.repository.split("/")[0])]);
  const discovered = await readJson(DISCOVERED, {});
  let added = 0;
  for (const owner of owners) {
    const repos = [];
    for (let page = 1; page < 20; page++) {
      const response = await github(`/users/${owner}/repos?per_page=100&page=${page}&type=owner`);
      if (!response.ok) {
        say(`discovery: ${owner} answered ${response.status}`);
        break;
      }
      const batch = await response.json();
      repos.push(...batch);
      if (batch.length < 100) break;
    }
    await pool(repos.filter((r) => r.has_pages && !r.archived && !r.private), 8, async (r) => {
      const base = r.name.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${owner.toLowerCase()}.github.io/` : `https://${owner.toLowerCase()}.github.io/${r.name}/`;
      try {
        const meta = await (await fetch(new URL("app.json", base), { signal: AbortSignal.timeout(15e3) })).json();
        if (repoOf(meta.repository).toLowerCase() !== r.full_name.toLowerCase()) return;
        const holo = await fetch(new URL("app.holo", base), { method: "HEAD", signal: AbortSignal.timeout(15e3) });
        if (!holo.ok) return;
        if (!discovered[r.full_name]) added++;
        discovered[r.full_name] = new URL(meta.live ?? base).href;
      } catch {}
    });
  }
  await writeAtomic(DISCOVERED, `${JSON.stringify(discovered, null, 2)}\n`);
  say(`discovery: ${owners.size} owner(s), ${Object.keys(discovered).length} app(s) known, ${added} new`);
}

// -- Stars, cached per repository ---------------------------------------------------
const STARS = join(DATA, "stars.json");
let stars = null;
async function starsOf(repository) {
  stars ??= await readJson(STARS, {});
  const kept = stars[repository.toLowerCase()];
  if (kept && Date.now() - kept.at < STARS_TTL) return kept;
  const response = await github(`/repos/${repository}`).catch(() => null);
  if (!response?.ok) return kept ?? { count: null, name: repository };
  const info = await response.json();
  stars[repository.toLowerCase()] = { count: info.stargazers_count, name: info.full_name, at: Date.now() };
  return stars[repository.toLowerCase()];
}

// -- Address cards in kappa ------------------------------------------------------------
// The card holds only what the holo's bytes decide, so the same holo always
// gives the same card and the same manifest digest: storing it again is a no-op.
const MANIFEST = "application/vnd.oci.image.manifest.v1+json";
const CARD = "application/vnd.prism.address.v1+json";
const EMPTY = { mediaType: "application/vnd.oci.empty.v1+json", digest: `sha256:${sha256(Buffer.from("{}"))}`, size: 2 };
const json = (value) => Buffer.from(`${JSON.stringify(value)}
`);
async function headManifest(repository, reference) {
  const response = await fetch(new URL(`/v2/${repository}/manifests/${reference}`, KAPPA), { method: "HEAD", headers: { accept: MANIFEST } });
  return response.ok ? response.headers.get("docker-content-digest") : null;
}
async function storeAddress(repository, card) {
  const cardBytes = json(card);
  const layer = { mediaType: CARD, digest: `sha256:${sha256(cardBytes)}`, size: cardBytes.length };
  const manifest = json({ schemaVersion: 2, mediaType: MANIFEST, artifactType: CARD, config: EMPTY, layers: [layer], annotations: { "org.opencontainers.image.source": card.repository, "org.opencontainers.image.title": card.name } });
  const digest = `sha256:${sha256(manifest)}`;
  const tag = `blake3-${card.address.slice("blake3:".length)}`;
  const [atTag, atLatest] = await Promise.all([headManifest(repository, tag), headManifest(repository, "latest")]);
  if (atTag === digest && atLatest === digest) return { digest, stored: false };
  const client = createRegistryClient({ registry: KAPPA.host, repository }, { plainHttp: KAPPA.protocol === "http:", resolveCredentials: () => null });
  if (!(await client.hasBlob(EMPTY.digest))) await client.putBlob(EMPTY.digest, Buffer.from("{}"));
  if (!(await client.hasBlob(layer.digest))) await client.putBlob(layer.digest, cardBytes);
  if (atTag !== digest) await client.putManifest(tag, manifest, MANIFEST);
  if (atLatest !== digest) await client.putManifest("latest", manifest, MANIFEST);
  return { digest, stored: true };
}

// -- Verification ------------------------------------------------------------------------
async function verify(candidate) {
  const { repository, live, registrations: registered } = candidate;
  const meta = JSON.parse(new TextDecoder().decode(await fetchBytes(new URL("app.json", live), 1024 * 1024)));
  const claimed = repoOf(meta.repository);
  if (claimed.toLowerCase() !== repository.toLowerCase()) throw new Error(`the live app.json names ${meta.repository || "no repository"}, not github.com/${repository}`);
  if (meta.index === false) throw new Error('the live app.json says "index": false');
  const holo = await fetchBytes(new URL("app.holo", live), MAX_HOLO);
  const app = await loadArchive(holo);
  if (!app.identities.verified) throw new Error("the live holo does not verify: a content label differs from its bytes");
  const fingerprint = app.identities.archiveFingerprint;
  // A deploy registers before its page goes live, so the page may still
  // serve an earlier holo the repository registered: any of them counts.
  if (registered.length && !registered.some((entry) => entry.fingerprint === fingerprint)) throw new Error(`the live holo is ${fingerprint.slice(0, 12)}…, which ${repository} never registered (its latest is ${registered.at(-1).fingerprint.slice(0, 12)}…)`);
  const result = await app.acceptance();
  if (!result.total) throw new Error("the holo carries no acceptance examples");
  if (result.passed !== result.total) throw new Error(`${result.total - result.passed} of ${result.total} examples gave a wrong answer`);
  // Its address, in kappa; its bytes stay at its live page.
  const name = `${PREFIX}/${repository.toLowerCase()}`;
  const holoUrl = new URL("app.holo", live).href;
  const card = { spec: "prism/address/1", address: `blake3:${fingerprint}`, sha256: sha256(holo), bytes: holo.length, name: String(meta.name), repository: `https://github.com/${claimed}`, locations: [holoUrl], examples: { passed: result.passed, total: result.total } };
  const { digest, stored } = await storeAddress(name, card);
  if (stored) say(`addressed ${repository}: ${PUBLIC_HOST}/${name}:blake3-${fingerprint.slice(0, 12)}… (${digest.slice(0, 19)}…)`);
  const star = await starsOf(claimed);
  const icon = new URL("icons/icon-192.png", live).href;
  const hasIcon = await fetch(icon, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  return {
    name: String(meta.name),
    address: slugOf(String(meta.name)),
    live,
    repository: `https://github.com/${star.name ?? claimed}`,
    owner: (star.name ?? claimed).split("/")[0],
    purpose: typeof meta.purpose === "string" ? meta.purpose : "",
    proposition: typeof meta.proposition?.plain === "string" ? meta.proposition.plain : null,
    fingerprint,
    address: `blake3:${fingerprint}`,
    card: `${PUBLIC_HOST}/${name}@${digest}`,
    holo: { url: holoUrl, sha256: card.sha256, bytes: card.bytes },
    examples: { passed: result.passed, total: result.total },
    stars: Number.isInteger(star.count) ? star.count : null,
    icon: hasIcon ? icon : null,
    registered: registered.length > 0,
  };
}

// -- AI artifacts -------------------------------------------------------------------
const ARTIFACT_INDEX = join(DATA, "artifacts.json");
async function artifacts() {
  if (!ARTIFACTS) return;
  const names = [];
  for (let last = "", page = 0; page < 100; page++) {
    const response = await fetch(new URL(`/v2/_catalog?n=1000${last ? `&last=${encodeURIComponent(last)}` : ""}`, ARTIFACTS));
    if (!response.ok) throw new Error(`the artifact catalog answered ${response.status}`);
    const batch = (await response.json()).repositories ?? [];
    names.push(...batch);
    if (batch.length < 1000) break;
    last = batch.at(-1);
  }
  const accept = "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json";
  const rows = (await pool(names, 8, async (repository) => {
    try {
      const tags = (await (await fetch(new URL(`/v2/${repository}/tags/list`, ARTIFACTS))).json()).tags ?? [];
      return await pool(tags.slice(0, 50), 4, async (tag) => {
        const head = await fetch(new URL(`/v2/${repository}/manifests/${encodeURIComponent(tag)}`, ARTIFACTS), { method: "HEAD", headers: { accept } });
        if (!head.ok) return null;
        const digest = head.headers.get("docker-content-digest");
        return { repository, tag, digest, mediaType: head.headers.get("content-type"), reference: `${ARTIFACTS_HOST}/${repository}@${digest}` };
      });
    } catch {
      return [];
    }
  })).flat().filter(Boolean);
  rows.sort((a, b) => a.repository.localeCompare(b.repository) || a.tag.localeCompare(b.tag));
  await writeAtomic(ARTIFACT_INDEX, `${JSON.stringify(rows)}\n`);
  say(`artifacts: ${names.length} repositories, ${rows.length} tagged manifest(s)`);
}

// -- The snapshot ---------------------------------------------------------------------
// Named by its SHA-256; no timestamps, so it changes only when what it says
// does. current.json names the apps snapshot and the artifacts snapshot.
async function snapshot(body) {
  const text = `${JSON.stringify(body, null, 2)}\n`;
  const digest = sha256(Buffer.from(text));
  const path = join(OUT, `${digest}.json`);
  await stat(path).catch(() => writeAtomic(path, text));
  return digest;
}
async function indexApps() {
  const apps = [];
  const rejected = [];
  for (const candidate of await candidates()) {
    try {
      const entry = await verify(candidate);
      apps.push(entry);
    } catch (error) {
      rejected.push({ repository: `https://github.com/${candidate.repository}`, live: candidate.live, source: candidate.source, reason: error.message });
    }
  }
  if (stars) await writeAtomic(STARS, `${JSON.stringify(stars)}\n`);
  apps.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name) || a.repository.localeCompare(b.repository));
  rejected.sort((a, b) => a.repository.localeCompare(b.repository));
  await mkdir(OUT, { recursive: true });
  const appsSha = await snapshot({ spec: "prism/index/1", registry: PUBLIC_HOST, apps, rejected });
  const rows = await readJson(ARTIFACT_INDEX, []);
  const artifactsSha = await snapshot({ spec: "prism/artifacts/1", registry: ARTIFACTS_HOST, artifacts: rows });
  const pointer = { spec: "prism/index-pointer/2", registry: PUBLIC_HOST, sha256: appsSha, path: `${appsSha}.json`, apps: apps.length, rejected: rejected.length, artifacts: { sha256: artifactsSha, path: `${artifactsSha}.json`, count: rows.length } };
  const before = await readJson(join(OUT, "current.json"), null);
  if (before?.sha256 !== appsSha || before?.artifacts?.sha256 !== artifactsSha) {
    await writeAtomic(join(OUT, "current.json"), `${JSON.stringify(pointer, null, 2)}\n`);
    say(`${apps.length} app(s) listed, ${rejected.length} rejected, ${rows.length} artifact(s); now ${appsSha.slice(0, 12)}…`);
  }
  // Snapshots no longer named are dropped after a day, so a page that read
  // the pointer just before it moved still finds what it named.
  for (const file of await readdir(OUT)) {
    if (!/^[0-9a-f]{64}\.json$/.test(file) || file === `${appsSha}.json` || file === `${artifactsSha}.json`) continue;
    const { mtimeMs } = await stat(join(OUT, file));
    if (Date.now() - mtimeMs > 86400e3) await unlink(join(OUT, file)).catch(() => {});
  }
}

// -- The loop ---------------------------------------------------------------------------
let appsAt = 0;
let wideAt = 0;
let logSize = -1;
async function tick() {
  const size = await stat(LOG).then((s) => s.size).catch(() => 0);
  const now = Date.now();
  if (now - wideAt >= WIDE_EVERY) {
    wideAt = now;
    await discover().catch((error) => say(`discovery failed: ${error.message}`));
    await artifacts().catch((error) => say(`artifacts failed: ${error.message}`));
    appsAt = 0;
  }
  if (size !== logSize || now - appsAt >= APPS_EVERY) {
    logSize = size;
    appsAt = now;
    await indexApps().catch((error) => say(`indexing failed: ${error.message}`));
  }
}
await mkdir(OUT, { recursive: true });
if (process.argv.includes("--once")) {
  await tick();
} else {
  say(`kappa ${KAPPA.origin} as ${PUBLIC_HOST}; owners ${OWNERS.join(", ") || "none"}; artifacts ${ARTIFACTS?.origin ?? "none"}`);
  for (;;) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, 15e3));
  }
}
