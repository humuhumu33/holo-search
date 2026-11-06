// Holo Search's wiring of the Prism frame. bootstrap/holo-page.mjs appends
// this after the frame's own top bar code, taken from the pinned
// site/app.mjs (chip, trust, share, omnibox, spectrum, theme), so $, data,
// here and those functions are in scope here.
//
// The verified runtime (the module before this one, unchanged) decides
// everything: what an address means, which app it names, whether that app
// may open. This file only shows its answers in the frame. It reads the
// runtime's state from the elements it writes (#status, #app-page,
// #app-status, the document title and the URL it pushes), and hands it what
// the omnibox chose through its own search form, so the model decides.

// The runtime bound its share handler to the hidden #share (first in the
// document); from here on the id, and the share button, are the frame's.
document.querySelector("#engine #share")?.removeAttribute("id");

// Set by the patched omnibox() and share(): point the bar at an address,
// and re-read data.share.
let point = () => {};
let reshare = () => {};

const live = new URL(data.share.url);
// Registry suggestions come from this page's own copy (the bundle serves it,
// from disk or offline too); the runtime still verifies whatever is chosen.
data.search = new URL(".", location.href).href;

// The app's name as the bar's holo:// address, as bootstrap/page.mjs makes it.
const slug = (name) =>
  name.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";

// The omnibox hands its choice to the runtime's search form: the model
// classifies it, resolves it and runs the gate before anything opens.
function open(target) {
  state.refused = null;
  paint();
  $("q").value = target;
  $("bar").requestSubmit();
}

// The share panel follows what is open: its link opens that app, verified,
// in any browser; with nothing open it shares Holo Search.
function retarget(url, title, text) {
  data.share = { url, title, text };
  reshare();
  const query = (params) => new URLSearchParams(params).toString();
  const link = new URL(url);
  const [x, linkedin, facebook, email] = document.querySelectorAll("#share-panel a.share-target");
  $("share-title").textContent = `Share ${title}`;
  document.querySelector("#share-panel .share-url").textContent = link.search
    ? link.host + link.pathname + link.search
    : (link.host + link.pathname).replace(/\/$/, "");
  x.href = `https://x.com/intent/post?${query({ text, url })}`;
  linkedin.href = `https://www.linkedin.com/sharing/share-offsite/?${query({ url })}`;
  facebook.href = `https://www.facebook.com/sharer/sharer.php?${query({ u: url })}`;
  email.href = `mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(`${text}\n\n${url}`)}`;
}

// What the runtime is doing, read from what it writes.
const state = { gate: "wait", opening: null, refused: null };

function readStatus() {
  const text = $("status").textContent;
  let found;
  // The runtime names a model by its sha256 prefix alone and a holo with blake3:.
  const named = (address) => (address.includes(":") ? address : `sha256:${address}`);
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
  const gate = `sha256:${data.holo.image}`;
  let title = "Holo Search";
  let host = "holo-search";
  let purpose = data.holo.purpose;
  let shown = `sha256:${data.holo.model}`;
  here.fingerprint = "";

  if (phase === "home") {
    const words = { good: "Holo Search's verified gate is ready in this browser", wait: "Verifying Holo Search in this browser", bad: "Holo Search could not start its verified gate" }[state.gate];
    trust(words, state.gate, state.gate === "good" ? gate : "");
    chip($("verified"), { good: "verified", wait: "verifying", bad: "failed to start" }[state.gate], state.gate);
  } else if (phase === "opening") {
    ({ title, host } = titled(state.opening));
    purpose = "Fetching it and checking it against its address in this browser. It opens only if every check passes.";
    shown = `${state.opening.address}…`;
    trust(`Verifying ${title} in this browser`, "wait");
    chip($("verified"), "verifying", "wait");
  } else if (phase === "open") {
    title = document.title.replace(/ · Holo Search$/, "");
    host = slug(title);
    purpose = "Verified in this browser before it opened: its bytes match its address and every acceptance vector it declares passed.";
    shown = full;
    if (address.startsWith("blake3:")) here.fingerprint = address.slice(7);
    trust("Verified in this browser", "good", full);
    chip($("verified"), "verified", "good");
  } else {
    ({ title, host } = titled(state.refused));
    purpose = "Refused in this browser, so it did not open. The proof shows which check failed.";
    shown = `${state.refused.address}…`;
    trust(`Refused: ${title} is NOT verified`, "bad", shown);
    chip($("verified"), "NOT verified", "bad");
  }

  point(title, host);
  $("name-text").textContent = title;
  $("purpose").textContent = purpose;
  $("address-label").textContent = phase === "home" ? "Model" : "Address";
  $("address-full").textContent = shown;
  $("status").hidden = phase === "open";
  $("model-link").hidden = phase === "opening" || phase === "refused";
  if (phase === "home") $("model-link").href = data.holo.modelUrl;
  $("proof-open-2").hidden = phase === "home";

  if (phase === "open") {
    retarget(`${live.href}?r=${address}`, title, `${title}, verified in your browser by Holo Search`);
  } else if (data.share.url !== live.href) {
    retarget(live.href, "Holo Search", data.holo.shareText);
  }
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

// Home is the runtime's own home: a plain click returns to search without
// reloading the page; any other click follows the link.
$("home").addEventListener("click", (event) => {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  $("home-link").click();
});

theme();
share();
omnibox();
spectrum();
watch();
