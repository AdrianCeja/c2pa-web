# C2PA Web Inspector

Inspect **C2PA / Content Credentials** in images and video, entirely in the browser.
Drop a file and see who generated it, CAI versions, whether it is AI-generated (and with
which model), the signing certificate, the validation state, and the raw manifest JSON.

It is the web sibling of the desktop [C2PA Inspector](https://github.com/AdrianCeja/c2pa-inspector):
same UI and parser, but instead of shelling out to `c2patool.exe`, it reads manifests with
**[@contentauth/c2pa-web](https://github.com/contentauth/c2pa-js)** (WebAssembly bindings for
`c2pa-rs`). No backend, no upload: the file never leaves the browser.

## Run locally

```bash
npm install
npm run dev      # http://localhost:5173
```

Drop any image that carries Content Credentials (for example one exported from Adobe Firefly
or Photoshop, or a sample from https://contentcredentials.org/verify). Images without a
manifest show "No Content Credentials", which is the expected result.

## Build & preview

```bash
npm run build    # outputs to dist/
npm run preview  # serves dist/ at http://localhost:4173
```

## Deploy (Netlify)

It is a fully static site. Point Netlify at this folder:

- Build command: `npm run build`
- Publish directory: `dist`

`netlify.toml` and `public/_headers` set `Content-Type: application/wasm` for the WASM binary.

We deliberately do **not** set COOP/COEP cross-origin isolation headers: c2pa-web does not use
`SharedArrayBuffer`, and `Cross-Origin-Embedder-Policy: require-corp` would block `c2pa-rs`
from fetching **remote manifests** (assets that reference their credentials by URL instead of
embedding them). GitHub Pages works too.

### Remote manifests

Some assets store their credentials in a **remote manifest** referenced by URL instead of
embedding it. c2pa-web fetches it directly from the browser, subject to the manifest host's
**CORS** policy and to network reachability. If the host blocks cross-origin reads, or the
manifest lives on a private network you are not connected to (some assets need the right VPN),
the file shows "Remote manifest could not be fetched". That is expected; there is nothing to
fix on our side.

## How it is wired

- `src/main.js` — app logic. Initializes c2pa-web once (`createC2pa({ wasmSrc })`), reads each
  dropped `File` with `c2pa.reader.fromBlob(mime, file)` → `reader.manifestStore()`, then hands
  the store to the parser and renders cards + raw JSON.
- `src/parser.js` — turns the manifest store into the small view model the UI renders.
  Copied from the desktop Inspector (the store shape is identical, since both come from `c2pa-rs`).
- `src/app.css` — the Inspector's macOS-style theme, plus a small web-only override block.

## What it does not do

Reading/verification only. Writing or **signing** manifests needs the engine on a server
(`c2pa-node` or the `c2patool` binary), which this static build intentionally avoids.
