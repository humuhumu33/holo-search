#!/usr/bin/env node
// Renders index.html: Holo Search inside the Prism frame, still one file.
//
//   node bootstrap/holo-page.mjs           rewrite index.html (and og.png) in place
//   node bootstrap/holo-page.mjs --check   fail unless index.html and og.png are what this would write
//
// The page has three parts, and this script owns only how they are put
// together:
//
//   The frame. The top bar is the canonical <prism-frame>, which the page
//   loads live from the template's Pages site and checks against its
//   SHA-256 before running it; nothing of the bar is copied here. What is
//   copied comes from the files frame.lock and brand.lock pin, at the
//   template commit frame.lock names, and frame-sync and brand-sync must pass
//   before anything is written: the <prism-frame> element and its stand-in,
//   cut from site/page.template.html and filled as bootstrap/page.mjs fills
//   them; the page's body styles and the brand, inlined as page.mjs inlines
//   them; and the loader (frame, verdict, chip), cut unchanged from
//   site/app.mjs.
//
//   The runtime. Holo Search's verified runtime (the gate, the model, the
//   WebAssembly runtime, the registry copy and the workers) is carried over
//   from the current index.html byte for byte: every block's sha256 is the
//   same before and after, and this script refuses to write a page where it
//   is not.
//
//   Holo Search's own part. site/holo-search.template.html (the page body),
//   site/holo-search.css (its styles) and site/holo-frame.mjs (which shows
//   the runtime's answers in the frame).
//
// Plain Node, no dependencies.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const read = (path, encoding = "utf8") => readFile(join(root, path), encoding);
const sha = (text) => createHash("sha256").update(text).digest("hex");
const check = process.argv[2] === "--check";

function fail(message) {
  console.error(`holo-page: ${message}`);
  process.exit(1);
}

// The frame and the brand are the pinned ones, or nothing is written.
for (const gate of ["frame-sync.mjs", "brand-sync.mjs"]) {
  const run = spawnSync(process.execPath, [join(root, "bootstrap", gate), "--check"], { encoding: "utf8" });
  process.stdout.write(run.stdout);
  if (run.status !== 0) fail(`${gate} --check failed:\n${run.stderr}`);
}
const lock = JSON.parse(await read("frame.lock"));

// Every <script> in the current page, as written.
function scripts(html) {
  const found = [];
  let at = 0;
  for (;;) {
    const open = html.indexOf("<script", at);
    if (open < 0) return found;
    const tagEnd = html.indexOf(">", open);
    const close = html.indexOf("</script>", tagEnd);
    found.push({ attrs: html.slice(open + 7, tagEnd).trim(), body: html.slice(tagEnd + 1, close) });
    at = close + 9;
  }
}

// The runtime blocks, by what they are. A page this script wrote marks the
// runtime module data-holo="engine"; the page before it had one module.
function runtime(html) {
  const all = scripts(html);
  const one = (what, test) => {
    const hits = all.filter(test);
    if (hits.length !== 1) fail(`expected one ${what} in index.html, found ${hits.length}`);
    return hits[0];
  };
  const modules = all.filter((s) => /type="module"/.test(s.attrs));
  return {
    files: one("registry copy", (s) => s.attrs.includes('id="holo-files"')),
    prelude: one("worker prelude", (s) => s.attrs.includes('id="holo-worker-prelude"')),
    engineWorker: one("engine worker", (s) => s.attrs.includes('data-worker="engine-worker.js"')),
    runtimeWorker: one("runtime worker", (s) => s.attrs.includes('data-worker="runtime-worker.js"')),
    loader: one("loader", (s) => s.attrs === "" && s.body.includes('text("holo-files")')),
    engine: one("runtime module", (s) =>
      s.attrs.includes('data-holo="engine"') || (modules.length === 1 && s.attrs === 'type="module"')),
  };
}
const RUNTIME = ["files", "prelude", "engineWorker", "runtimeWorker", "loader", "engine"];

const before = runtime(await read("index.html"));
const tag = {
  files: '<script type="application/json" id="holo-files">',
  prelude: '<script type="text/plain" id="holo-worker-prelude">',
  engineWorker: '<script type="text/plain" data-worker="engine-worker.js">',
  runtimeWorker: '<script type="text/plain" data-worker="runtime-worker.js">',
  loader: "<script>",
  engine: '<script type="module" data-holo="engine">',
};
const runtimeHtml = RUNTIME.map((key) => `    ${tag[key]}${before[key].body}</script>`).join("\n");

// Holo Search's own identity, from this repository: its model is
// src/HoloSearch.lex.tex, and the runtime runs that model's image, which the
// registry index lists and the runtime module pins.
const meta = JSON.parse(await read("site/app.json"));
const model = sha(await read("src/HoloSearch.lex.tex", null));
const index = JSON.parse(await read("registry/index.json"));
const image = index.find((entry) => entry.module === "HoloSearch" && entry.kind === "image" && before.engine.body.includes(entry.sha256));
if (!image) fail("the runtime module pins no HoloSearch image that registry/index.json lists");
if (!index.some((entry) => entry.sha256 === model)) fail(`registry/index.json does not list the model src/HoloSearch.lex.tex (${model})`);

// The values the template's page fills, made as bootstrap/page.mjs makes them.
const escape = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const live = new URL(meta.live);
const holoSearch = new URL("https://humuhumu33.github.io/holo-search/");
// The canonical frame: the template's Pages site publishes it on every push
// to main. HOLO_FRAME_HOST points a local build at a frame published with
// frame/publish.mjs, for a test; --check rejects a page built that way.
const frameHost = new URL(process.env.HOLO_FRAME_HOST ?? meta.frame ?? "https://uor-foundation.github.io/template/frame/");
const shareText = `${meta.name}: ${meta.purpose.split(/(?<=\.)\s/)[0]}`;
const frameFill = {
  NAME: escape(meta.name),
  HOLO_NAME: escape(meta.name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app"),
  LIVE: escape(live.href),
  REPO: escape(meta.repository),
  HOLO_SEARCH: escape(holoSearch.href),
  PURPOSE: escape(meta.purpose),
  OG_IMAGE: escape(new URL("og.png", live).href),
};
const fill = (text, values) => {
  for (const [key, value] of Object.entries(values)) text = text.split(`{{${key}}}`).join(value);
  return text;
};

// The header: the template's own <prism-frame> element and its stand-in,
// cut from its page and filled. The frame itself is not here: the page
// loads it live (the frame() loader below).
const page = await read("site/page.template.html");
const frameStart = page.indexOf("    <prism-frame ");
const frameEnd = page.indexOf("    </prism-frame>\n", frameStart) + "    </prism-frame>\n".length;
if (frameStart < 0 || frameEnd < frameStart) fail("site/page.template.html has no <prism-frame>");
const header = fill(page.slice(frameStart, frameEnd), frameFill).trimEnd();
if (/\{\{[A-Z_]+\}\}/.test(header)) fail(`the frame element has an unfilled value: ${header.match(/\{\{[A-Z_]+\}\}/)[0]}`);

// The styles, inlined as page.mjs inlines them; the fonts go in as data, so
// the page stays one file.
const minify = (text) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]+/gm, "").replace(/\n{2,}/g, "\n").trim();
let fonts = await read("site/brand/fonts.css");
for (const [, file] of fonts.matchAll(/url\("\.\.\/fonts\/([^"]+\.woff2)"\)/g)) {
  const data = (await read(`site/fonts/${file}`, null)).toString("base64");
  fonts = fonts.split(`url("../fonts/${file}")`).join(`url("data:font/woff2;base64,${data}")`);
}
const css = minify([await read("site/brand/hologram-warm.css"), fonts, await read("site/prism-page.css"), await read("site/holo-search.css")].join("\n"));
const theme = (await read("site/theme.js")).trim();

// The template's frame loader and its helpers, cut unchanged from
// site/app.mjs: each function from its leading comment to its closing brace.
const app = await read("site/app.mjs");
function cut(name) {
  const start = app.search(new RegExp(`^(async )?function ${name}\\(`, "m"));
  if (start < 0) fail(`site/app.mjs has no function ${name}`);
  const end = app.indexOf("\n}\n", start) + 3;
  const lines = app.slice(0, start).split("\n");
  lines.pop();
  let comment = "";
  while (lines.length && lines.at(-1).startsWith("//")) comment = `${lines.pop()}\n${comment}`;
  return comment + app.slice(start, end);
}
function line(prefix) {
  const found = app.split("\n").filter((text) => text.startsWith(prefix));
  if (found.length !== 1) fail(`site/app.mjs has ${found.length} lines starting ${prefix}`);
  return `${found[0]}\n`;
}
const frameScript = [
  `// From UOR-Foundation/template@${lock.source.commit} site/app.mjs`,
  `// (sha256 ${lock.files.find((file) => file.path === "site/app.mjs").sha256}), cut unchanged by`,
  "// bootstrap/holo-page.mjs: the frame loader and its helpers. Then Holo Search's wiring.",
  line("const $ = "),
  line("const describe = "),
  line("const data = "),
  cut("chip"),
  cut("frame"),
  cut("verdict"),
  await read("site/holo-frame.mjs"),
].join("\n");
if (frameScript.includes("</script")) fail("the frame script contains </script");

const appData = {
  frame: frameHost.href,
  holo: {
    model,
    image: image.sha256,
    modelUrl: `${meta.repository}/blob/main/src/HoloSearch.lex.tex`,
    name: meta.name,
    purpose: meta.purpose,
    live: live.href,
    repo: meta.repository,
  },
};

let html = fill(await read("site/holo-search.template.html"), {
  TITLE: escape(meta.name),
  DESCRIPTION: escape(meta.purpose),
  LIVE: escape(live.href),
  OG_IMAGE: escape(new URL("og.png", live).href),
  OG_ALT: escape(`${meta.name}: ${meta.purpose}`),
  NAME: escape(meta.name),
  PURPOSE: escape(meta.purpose),
  MODEL_SHA: model,
  MODEL_URL: escape(appData.holo.modelUrl),
  IMAGE_SHA: image.sha256,
  GATE_URL: escape(`${meta.repository}#what-is-here`),
  REPO: escape(meta.repository),
  REPORT: escape(meta.report),
  INLINE_CSS: css,
  INLINE_THEME: theme,
  APP_DATA: JSON.stringify(appData).replace(/</g, "\u003c"),
  FRAME: header,
  RUNTIME: runtimeHtml,
  FRAME_SCRIPT: `    <script type="module" id="holo-frame">\n${frameScript}</script>`,
});
const left = html.match(/\{\{[A-Z_]+\}\}/g);
if (left) fail(`unfilled: ${left.join(", ")}`);

// The runtime is the same bytes it was.
const after = runtime(html);
for (const key of RUNTIME) {
  if (sha(after[key].body) !== sha(before[key].body)) fail(`the runtime's ${key} changed`);
  console.log(`holo-page: runtime ${key} unchanged, sha256 ${sha(before[key].body)}`);
}

const ogFrame = await read("site/og.png", null);
if (check) {
  const current = await read("index.html");
  const og = await read("og.png", null).catch(() => null);
  if (current !== html) fail("index.html is not what bootstrap/holo-page.mjs renders; run it");
  if (!og || !og.equals(ogFrame)) fail("og.png is not site/og.png; run bootstrap/holo-page.mjs");
  console.log("holo-page: index.html and og.png are current");
} else {
  await writeFile(join(root, "index.html"), html);
  await writeFile(join(root, "og.png"), ogFrame);
  console.log(`holo-page: index.html rendered, ${Buffer.byteLength(html)} bytes, frame from ${lock.source.repository}@${lock.source.commit.slice(0, 12)}`);
}
