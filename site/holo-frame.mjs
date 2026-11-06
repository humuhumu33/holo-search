// Holo Search's wiring of the canonical frame. bootstrap/holo-page.mjs
// appends this after the template's frame loader (frame, verdict, chip, and
// the $, describe and data they use), cut unchanged from its site/app.mjs.
//
// The top bar is the template's <prism-frame>, loaded live. Holo Search only
// tells it what is showing, through the element's attributes (the
// prism/frame/1 contract): the open app's name, holo:// address, shareable
// link and purpose, and the verdict its own verification gate reached.
//
// The verified runtime (the module before this one, unchanged) decides
// everything: what an address means, which app it names, whether that app
// may open. This file reads its answers from the elements it writes
// (#status, #app-page, #app-status, the document title and the URL it
// pushes) and shows them in the frame and the Identity card. The frame's
// address bar sends what is typed to this page's ?r=, where the runtime
// resolves and verifies it.

const holo = data.holo;
const element = $("frame");

// Holo Search is its own home: the frame's home icon and address bar resolve
// through this page, so a copy served elsewhere (or from disk) stays itself.
element.setAttribute("home", new URL(".", location.href).href);

// The app's name as its holo:// address, as bootstrap/page.mjs makes it.
const slug = (name) =>
  name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";

// An attribute set, or removed when there is no value. The frame redraws
// only when a value changes.
const set = (name, value) => (value ? element.setAttribute(name, value) : element.removeAttribute(name));

// What the runtime is doing, read from what it writes.
const state = { gate: "wait", opening: null, refused: null };

function readStatus() {
  const text = $("status").textContent;
  // The runtime names a model by its sha256 prefix alone and a holo with blake3:.
  const named = (address) => (address.includes(":") ? address : `sha256:${address}`);
  let found;
  if ((found = text.match(/^Opening (.+) · (\S+)$/))) {
    state.opening = { name: found[1], address: named(found[2]) };
    state.refused = null;
  } else if ((found = text.match(/^Refused · (.+) · (\S+)$/))) {
    state.refused = { name: found[1], address: named(found[2]) };
    state.opening = null;
  } else if (/verified gate ready$/.test(text)) {
    state.gate = "good";
    state.opening = state.refused = null;
  } else if (/^Holo Search could not start/.test(text)) {
    state.gate = "bad";
    state.opening = null;
  }
}

// A holo is named by its fingerprint until it has opened and said its name.
const titled = ({ name, address }) =>
  name === "holo" ? { title: address, host: address } : { title: name, host: slug(name) };

function paint() {
  const appOpen = !$("app-page").hidden;
  const phase = state.opening ? "opening" : appOpen ? "open" : state.refused ? "refused" : "home";
  const address = new URLSearchParams(location.search).get("r") ?? "";
  const full = address.startsWith("blake3:") ? address : address && `sha256:${address}`;
  let title = holo.name;
  let host = slug(holo.name);
  let lede = holo.purpose;
  let shown = `sha256:${holo.model}`;
  // The frame's attributes: what it shows, and what its share panel shares.
  let frame = { live: holo.live, repo: holo.repo, purpose: holo.purpose, card: new URL("og.png", holo.live).href };

  if (phase === "home") {
    const words = {
      good: "Holo Search's verified gate is ready in this browser",
      wait: "Verifying Holo Search in this browser",
      bad: "Holo Search could not start its verified gate",
    }[state.gate];
    set("fingerprint", "");
    verdict(state.gate, state.gate === "good" ? `${words}, image sha256:${holo.image}` : words);
    chip($("verified"), { good: "verified", wait: "verifying", bad: "failed to start" }[state.gate], state.gate);
  } else if (phase === "opening") {
    ({ title, host } = titled(state.opening));
    lede = "Fetching it and checking it against its address in this browser. It opens only if every check passes.";
    shown = `${state.opening.address}…`;
    frame = { ...frame, repo: "" };
    set("fingerprint", "");
    verdict("wait", `Verifying ${title} in this browser`);
    chip($("verified"), "verifying", "wait");
  } else if (phase === "open") {
    title = document.title.replace(/ · Holo Search$/, "");
    host = slug(title);
    lede = "Verified in this browser before it opened: its bytes match its address and every acceptance vector it declares passed.";
    shown = full;
    // The link that opens this app, verified, in any browser. Its source
    // repository is not known here, so the frame hides GitHub.
    frame = { live: `${holo.live}?r=${address}`, repo: "", purpose: "Verified in your browser by Holo Search.", card: frame.card };
    // The frame matches a holo's fingerprint against the registry's blake3;
    // a model's sha256 goes in the words instead.
    set("fingerprint", address.startsWith("blake3:") ? address.slice(7) : "");
    verdict("good", address.startsWith("blake3:") ? "Verified in this browser" : `Verified in this browser, ${full}`);
    chip($("verified"), "verified", "good");
  } else {
    ({ title, host } = titled(state.refused));
    lede = "Refused in this browser, so it did not open. The proof shows which check failed.";
    shown = `${state.refused.address}…`;
    frame = { ...frame, repo: "" };
    set("fingerprint", "");
    verdict("bad", `Refused: ${title} is NOT verified, ${shown}`);
    chip($("verified"), "NOT verified", "bad");
  }

  set("name", title);
  set("address", host);
  for (const [name, value] of Object.entries(frame)) set(name, value);
  // The stand-in shown until the frame arrives, or if it cannot.
  const fallback = element.querySelector(".frame-fallback");
  if (fallback) fallback.lastChild.textContent = host;

  $("name-text").textContent = title;
  $("purpose").textContent = lede;
  $("address-label").textContent = phase === "home" ? "Model" : "Address";
  $("address-full").textContent = shown;
  $("status").hidden = phase === "open";
  $("model-link").hidden = phase === "opening" || phase === "refused";
  if (phase === "home") $("model-link").href = holo.modelUrl;
  $("proof-open-2").hidden = phase === "home";
}

// Only what the runtime writes is watched; paint() never writes it, so
// painting cannot wake the observer again.
function watch() {
  const status = $("status");
  const appStatus = $("app-status");
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (status.contains(record.target)) readStatus();
      // The runtime writes the app's status line once it has opened it.
      else if (appStatus.contains(record.target) && !$("app-page").hidden) state.opening = state.refused = null;
    }
    paint();
  });
  const text = { subtree: true, childList: true, characterData: true };
  observer.observe(status, text);
  observer.observe(appStatus, text);
  observer.observe($("app-page"), { attributes: true, attributeFilter: ["hidden"] });
  readStatus();
  paint();
}

watch();
frame();
