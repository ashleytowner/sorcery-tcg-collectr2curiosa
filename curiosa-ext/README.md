# curiosa-ext

A Chrome extension that bulk-imports a Sorcery collection CSV into
[curiosa.io](https://curiosa.io/collection?tab=view) by driving the Quick
Search panel one row at a time.

It also ships with a **Record mode** that captures DOM events, mutations, and
network calls while you manually add a card. That trace is what lets the
Replay flow be tuned for the real Curiosa DOM without anyone but you needing
to log in.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and pick the `curiosa-ext/` folder.
4. Pin the extension so the popup is one click away.

## Workflow

### 1. Record (run this once)

1. Open `https://curiosa.io/collection?tab=view` and log in.
2. Click the extension icon → **Record** tab → **Start recording**.
3. In the Curiosa UI, manually add two cards:
   - one **Normal** card (e.g. `Accursed Desert`) with quantity ≥ 2
   - one **Foil** card (e.g. `Abyssal Assault (Foil)`) with quantity ≥ 2
4. Click **Stop**, then **Download curiosa-trace.json**.
5. Send the trace file back so the selectors and step machine in
   [content.js](content.js) can be locked to Curiosa's actual DOM/network
   shape.

The recorder captures, with throttled persistence into
`chrome.storage.session`:

- Capture-phase `click`, `input`, `change`, `keydown` on `document`
- `MutationObserver` records scoped to the Quick Search container at
  `//*[@id="__next"]/main/div/div/div[2]/div/div[2]/div/div/div/div/div/div`
  (falls back to `<body>` if the XPath does not resolve)
- All `fetch` and `XMLHttpRequest` traffic (method, URL, status, request
  body, response body — each truncated to 4 KB), via a page-world shim
  injected from [inject.js](inject.js)

### 2. Replay

1. Open `https://curiosa.io/collection?tab=view` and log in.
2. Click the extension icon → **Replay** tab.
3. Pick your CSV (e.g. `export.csv`).
4. Optional: tweak the delay slider (default `800 ms`).
5. Click **Start**.

The popup parses these columns from the CSV: `Product Name`, `Set`,
`Variance`, `Quantity`, `Notes`. Rows where `Variance == Foil` have the
trailing `" (Foil)"` stripped before the API search.

For each row, the replayer:

1. `GET /api/trpc/search.variants?…&input={"0":{"json":{"query":"<name>"}}}`
2. Picks the variant whose `data.card.name` matches the row name, whose
   `data.variant.finish` matches `Standard` / `Foil`, and whose
   `data.variant.setCard.set.name` matches the CSV `Set`.
3. `POST /api/trpc/collection.updatePickle` with
   `{cardId, variantId, quantity, notes}` — `quantity` is the **target
   total**, not an increment, which mirrors Curiosa's own UI behaviour.

Fetches run from the content script so your Curiosa session cookies travel
with the request — no token handling needed on the extension side. Progress
is shown live; any row that the replayer cannot match is logged and can be
exported via **Download report.csv**. Successful rows are tagged with the
matched variant slug (e.g. `[got-swap-b-s]`) so you can spot mismatches.

## File map

| File | What it does |
| ---- | ------------ |
| [manifest.json](manifest.json) | MV3 manifest, host-restricted to `curiosa.io` |
| [popup.html](popup.html) / [popup.css](popup.css) / [popup.js](popup.js) | Two-tab UI, CSV parser, replay controller, recorder stats |
| [content.js](content.js) | Isolated-world script: recorder, replayer, message router. All selectors live in the top `SELECTORS` block |
| [inject.js](inject.js) | Page-world shim that monkey-patches `fetch` and `XMLHttpRequest` |
| [background.js](background.js) | Service worker, stores recorder buffer in `chrome.storage.session` |
| [icons/](icons/) | Placeholder PNGs — swap in your own anytime |

## Troubleshooting

- **"No Curiosa tab open."** — open `https://curiosa.io/collection?tab=view`
  first, then click the extension icon.
- **`search HTTP 401` or `updatePickle HTTP 401`** — your Curiosa session
  expired. Reload the page, log in again, then retry.
- **Lots of `MISS … no Standard/Foil variant in set "…"`** — the CSV `Set`
  value does not match Curiosa's set name exactly (case-insensitive). Check
  the matched slug on successful rows to see what naming Curiosa uses.
- **`tRPC error: …`** — the API rejected the payload. The error message
  comes straight from Curiosa; if it changes, re-record and send a new
  trace.
