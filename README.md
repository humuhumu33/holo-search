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
| Calculator v2 image | `a33570ee424e9bd0cc958fb906f0c846a7dc1eae2adf8408f7cd14784dd5b6b9` |
| Calculator v1 by IPFS CID | `bafkreigzj3mabizjepm3vb43yfva5cyhe7q3jxv62y7oixrnwrdgeaugoi` |
| Calculator holo by IPFS CID | `bafkr4ieebdqisvls7kyj46b7pkw3cko4js4w2c3cqufbn465xzco2ybbxi` |
| Holo Search itself | `691e1854681cc1b5d94549348c1eb604e01e8ca7c9ada83e444984cce905c489` |
| A tampered Calculator (refused on purpose: 3 of 22 vectors fail) | `fe055fd1483baa959c2570b3a1abe752325e9b41e332fadbc937a5617238f678` |

## What is here

- [`src/HoloSearch.lex.tex`](src/HoloSearch.lex.tex): Holo Search's own model in
  LexLean 1.2 (sha256 `691e1854…`). It declares its screen (the
  `prism-screen/1` contract); its address grammar (sha256 and BLAKE3 digests
  and prefixes, links, and IPFS CIDs, decoded in the model); resolution,
  search and the verification gate; 22 acceptance vectors; and 7 theorems
  checked by Lean (`lexlean verify`, attestation `931478d3…`), among them: the
  gate is ready exactly when the address, the check and the vectors all pass,
  and a mismatched address is always the reason given first.
- The page runs that model as a Prism image, pinned by digest
  (`20b0406e…`): every layer is hashed and every program checked before the
  model is asked anything. What you typed means, which app it names, and
  whether that app may open are all the model's answers, not the page's.
- [`registry/`](registry/): models, holos, images and their layers stored
  under their digest, plus `index.json` for search. Served raw, this folder is
  the public mirror. It also holds the compiler an image names, so the page's
  Rebuild step can rebuild an image from its source and compare.
- [`index.html`](index.html): the page, its runtime and these models in one
  file.

## Status

A working prototype. Lean proofs are verified
locally; no proof attestation is published yet, so the page says so. This
repository was created from the UOR project template, which is not yet bound
to a PrismPM SDK release, so its `just vv` gate cannot run yet.

Licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE).
