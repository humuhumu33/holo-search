// The Prism index: every Prism app that verifies, in one content-addressed
// snapshot that every app's address bar and Holo Search read.
//
// Candidates come from two places: registry/apps.json (the seed list, kept by
// hand) and the Prism registry's registrations (each app's deploy pushes its
// holo there and records its live page; bootstrap/register.mjs in the
// template). An app is listed only when, now:
//   - its live page's app.json names the repository it is listed under;
//   - its live app.holo verifies (every content label matches its bytes) and,
//     when its repository registered, is one of the holos it registered (any
//     of them: a deploy registers before its page goes live, so the page may
//     still serve the one before; each registration is the repository's own,
//     proven by its run's OIDC token);
//   - every acceptance example it carries gives its answer in this run.
// Anything else is recorded under "rejected" with the reason, and its last
// good entry is not carried over: the index never shows what does not verify
// now. Star counts come from GitHub's API, with this run's token.
//
// Writes registry/index/<sha256>.json and points registry/index/current.json
// at it, only when the snapshot changed; prints "changed" or "unchanged".
//   GITHUB_TOKEN=... PRISM_REGISTRY=registry.example node bootstrap/index.mjs
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadArchive } from "prism-code";

const out = "registry/index";
const say = (text) => console.error(`index: ${text}`);
const repoOf = (link) => (String(link ?? "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/) ?? [])[1] ?? "";
const slugOf = (name) => name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const githubHeaders = { accept: "application/vnd.github+json", "user-agent": "prism-index", ...(process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) };
const MAX_HOLO = 64 * 1024 * 1024;

async function fetchBytes(url, limit) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > limit) throw new Error(`${url} is larger than ${limit} bytes`);
  return bytes;
}

// -- Candidates ----------------------------------------------------------------
const candidates = new Map();
const add = (candidate) => {
  const repository = candidate.repository.toLowerCase();
  const kept = candidates.get(repository);
  const registrations = [...(kept?.registrations ?? []), ...(candidate.registration ? [candidate.registration] : [])];
  // The newest registration names the live page; a seed only fills in for a
  // repository that never registered.
  const newest = registrations.at(-1);
  candidates.set(repository, {
    repository: candidate.repository,
    live: newest ? new URL(newest.live).href : kept?.live ?? candidate.live,
    registrations,
    source: registrations.length ? "registry" : candidate.source,
  });
};
for (const app of JSON.parse(await readFile("registry/apps.json", "utf8"))) {
  const repository = repoOf(app.repository);
  if (repository && /^https:\/\//.test(app.live ?? "")) add({ repository, live: new URL(app.live).href, registration: null, source: "seed" });
}
const registry = process.env.PRISM_REGISTRY ?? "";
if (registry) {
  try {
    const base = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(registry) ? `http://${registry}` : `https://${registry}`;
    const response = await fetch(`${base}/prism/registrations`);
    if (!response.ok) throw new Error(`answered ${response.status}`);
    const { entries } = await response.json();
    for (const entry of entries ?? []) {
      if (!repoOf(`https://github.com/${entry.repository}`) || !/^https?:\/\//.test(entry.live ?? "")) continue;
      add({ repository: entry.repository, live: entry.live, registration: entry, source: "registry" });
    }
    say(`${entries?.length ?? 0} registration(s) from ${registry}`);
  } catch (error) {
    say(`the registry ${registry} could not be read (${error.message}); indexing the seed list only`);
  }
}

// -- Verification --------------------------------------------------------------
async function verify(candidate) {
  const { repository, live, registrations } = candidate;
  const meta = JSON.parse(new TextDecoder().decode(await fetchBytes(new URL("app.json", live), 1024 * 1024)));
  const claimed = repoOf(meta.repository);
  if (claimed.toLowerCase() !== repository.toLowerCase()) throw new Error(`the live app.json names ${meta.repository || "no repository"}, not github.com/${repository}`);
  if (meta.index === false) throw new Error('the live app.json says "index": false');
  const holo = await fetchBytes(new URL("app.holo", live), MAX_HOLO);
  const app = await loadArchive(holo);
  const { identities } = app;
  if (!identities.verified) throw new Error("the live holo does not verify: a content label differs from its bytes");
  const fingerprint = identities.archiveFingerprint;
  const registration = registrations.findLast((entry) => entry.fingerprint === fingerprint) ?? null;
  if (registrations.length && !registration) throw new Error(`the live holo is ${fingerprint.slice(0, 12)}…, which ${repository} never registered (its latest is ${registrations.at(-1).fingerprint.slice(0, 12)}…)`);
  const result = await app.acceptance();
  if (!result.total) throw new Error("the holo carries no acceptance examples");
  if (result.passed !== result.total) throw new Error(`${result.total - result.passed} of ${result.total} examples gave a wrong answer`);
  const info = await fetch(`https://api.github.com/repos/${claimed}`, { headers: githubHeaders }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const icon = new URL("icons/icon-192.png", live).href;
  const hasIcon = await fetch(icon, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
  return {
    name: String(meta.name),
    address: slugOf(String(meta.name)),
    live,
    repository: `https://github.com/${info?.full_name ?? claimed}`,
    owner: (info?.full_name ?? claimed).split("/")[0],
    purpose: typeof meta.purpose === "string" ? meta.purpose : "",
    proposition: typeof meta.proposition?.plain === "string" ? meta.proposition.plain : null,
    fingerprint,
    holo: { sha256: sha256(holo), bytes: holo.length },
    examples: { passed: result.passed, total: result.total },
    stars: Number.isInteger(info?.stargazers_count) ? info.stargazers_count : null,
    icon: hasIcon ? icon : null,
    registry: registration?.reference ?? null,
  };
}

const apps = [];
const rejected = [];
for (const candidate of candidates.values()) {
  try {
    const entry = await verify(candidate);
    apps.push(entry);
    say(`listed ${entry.name} (${entry.repository}), ${entry.examples.passed}/${entry.examples.total} examples, ${entry.stars ?? "?"} star(s)`);
  } catch (error) {
    rejected.push({ repository: `https://github.com/${candidate.repository}`, live: candidate.live, source: candidate.source, reason: error.message });
    say(`rejected ${candidate.repository}: ${error.message}`);
  }
}

// -- The snapshot -----------------------------------------------------------------
// Ranked: more stars first, then by name; ties are broken by the repository,
// so the same apps always give the same bytes. No timestamps: the file
// changes only when what it says changes.
apps.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name) || a.repository.localeCompare(b.repository));
rejected.sort((a, b) => a.repository.localeCompare(b.repository));
const text = `${JSON.stringify({ spec: "prism/index/1", apps, rejected }, null, 2)}\n`;
const digest = sha256(Buffer.from(text));
const current = await readFile(`${out}/current.json`, "utf8").then(JSON.parse).catch(() => null);
if (current?.sha256 === digest) {
  console.log("unchanged");
} else {
  await mkdir(out, { recursive: true });
  await writeFile(`${out}/${digest}.json`, text);
  await writeFile(`${out}/current.json`, `${JSON.stringify({ spec: "prism/index-pointer/1", sha256: digest, path: `${digest}.json`, apps: apps.length, rejected: rejected.length }, null, 2)}\n`);
  console.log("changed");
}
