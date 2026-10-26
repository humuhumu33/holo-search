# Holo Search

Search and run self-verifying Prism apps by their address.

**Live:** https://humuhumu33.github.io/holo-search/

Type an app's name, or paste its address: a `sha256` digest (or an 8+ digit
prefix), a `blake3:` holo fingerprint, an IPFS CID, or a shared link. Holo
Search fetches the app from any source (this site, IPFS gateways, the GitHub
mirror), hashes the bytes in your browser and refuses them unless they match
the address, compiles the model with LexLean's runtime compiled to
WebAssembly, runs every acceptance vector the app declares, and only then
opens it. No server is trusted; any host can serve the bytes.

The whole page is one file, [`index.html`](index.html): it runs from this
site, from disk, offline, or as a message attachment.

## Try

| App | Address |
|---|---|
| Calculator v2 (declares its own UI) | `5374374814d6c7f590b33011fe88ca544ad14d3980b0cc27f7e70ae2e64706ad` |
| Calculator v1 | `d94ed800a32923d9ba879bc16a0e8b0727e1b4debed63ee45e2db44662028672` |
| Calculator holo | `blake3:8408e0895572fab09e783f7aadb129dc4cb96d0b62850a16f3ddbe44ed6021ba` |
| Holo Search itself | `9a7f058c1e1b211e9f5f035deaeb82f386d72298b49019217855fea17e8528b3` |
| A tampered Calculator (refused on purpose: 3 of 22 vectors fail) | `fe055fd1483baa959c2570b3a1abe752325e9b41e332fadbc937a5617238f678` |

## What is here

- [`src/HoloSearch.lex.tex`](src/HoloSearch.lex.tex): Holo Search's own model in
  LexLean 1.2. It declares its screen (the `prism-screen/1` contract), its
  address classification, resolution, search and verification gate, 14
  acceptance vectors, and 8 theorems checked by Lean (`lexlean verify`,
  attestation `aa98d8b0…`), among them: the gate is ready exactly when the
  address, the check and the vectors all pass.
- [`registry/`](registry/): models and holos stored under their digest, plus
  `index.json` for search. Served raw, this folder is the public mirror.
- [`index.html`](index.html): the page, its runtime and these models in one
  file.

## Status

A working prototype. The page's decisions still run in JavaScript beside the
verified model; moving them onto the model is next. Lean proofs are verified
locally; no proof attestation is published yet, so the page says so. This
repository was created from the UOR project template, which is not yet bound
to a PrismPM SDK release, so its `just vv` gate cannot run yet.

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
