// Writes registry/stars.json: the GitHub star count of every repository
// registry/apps.json lists, so every Prism app's bar and address bar show
// current counts without a visitor's browser ever calling GitHub. The
// workflow .github/workflows/stars.yml runs this every ten minutes, when
// someone stars Holo Search, and when the list of apps changes, and commits
// the file only when a count changed: Holo Search's Pages site then serves
// it, and the frame reads it on every page load.
//   GITHUB_TOKEN=... node bootstrap/stars.mjs     prints "changed" or "unchanged"
import { readFile, writeFile } from "node:fs/promises";

const path = "registry/stars.json";
const repoOf = (link) => (String(link ?? "").match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/) ?? [])[1] ?? "";
const apps = JSON.parse(await readFile("registry/apps.json", "utf8"));
const repos = [...new Set(apps.map((app) => repoOf(app.repository)).filter(Boolean))].sort();

const headers = { accept: "application/vnd.github+json", "user-agent": "holo-search-stars" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
const stars = {};
for (const repo of repos) {
  const response = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!response.ok) throw new Error(`${repo}: GitHub answered ${response.status}`);
  const count = (await response.json()).stargazers_count;
  if (!Number.isInteger(count)) throw new Error(`${repo}: no star count`);
  stars[repo] = count;
}

// No timestamp: the file changes only when a count does, so a commit means a
// count changed.
const text = `${JSON.stringify({ spec: "prism/stars/1", stars }, null, 2)}\n`;
const before = await readFile(path, "utf8").catch(() => "");
if (before === text) {
  console.log("unchanged");
} else {
  await writeFile(path, text);
  console.log("changed");
  for (const [repo, count] of Object.entries(stars)) console.error(`stars: ${repo} ${count}`);
}
