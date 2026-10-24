# Sorcery Collection Importer

A Chrome extension that imports a Sorcery: Contested Realm collection from a
Collectr or Kurio CSV into [sorcerytcg.com](https://sorcerytcg.com/collection).

The extension uses Sorcery's public card catalogue to resolve each CSV row to
an exact printing, then updates that printing through the collection API using
your existing signed-in browser session. It does not read or store login
credentials.

## Install (unpacked)

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select the `sorcerytcg-ext/` folder.
4. Pin the extension so the importer is easy to open.

After updating an existing checkout, remove the old unpacked extension and
load `sorcerytcg-ext/`, since the folder was previously named `curiosa-ext/`.

## Import a collection

1. Open `https://sorcerytcg.com/collection` and sign in.
2. Click the extension icon. The importer opens in a persistent browser tab so
   Chrome's file chooser cannot close it.
3. Select the **Replay** tab.
4. Choose the CSV exported by Collectr or Kurio.
5. Optionally adjust the delay between updates (the default is `800 ms`).
6. Click **Start**.

For a Collectr export, the importer reads these CSV columns:

- `Product Name` (required)
- `Quantity` (required)
- `Set`
- `Variance`
- `Notes`

Kurio exports are detected by their `Card Name` column. The importer uses
`Card Slug`, `Set Name`, `Product`, `Finish`, and `Printed At` to resolve the
exact printing, plus `Quantity` and `Notes` for the collection update.

Rows with an empty name or a quantity of zero are ignored. `Normal` maps to a
Sorcery `Standard` printing, while `Foil` maps to `Foil`. Printing suffixes in
Collectr names are also understood, including `(Foil)`, `(Box Topper)`, and a
combination such as `(Foil) (Box Topper)`.

For each row, the extension:

1. Loads `GET https://api.sorcerytcg.com/api/cards` once and caches it for the
   current page.
2. Matches a Kurio row by slug, set, product, finish, and printing date. For a
   Collectr row it matches the normalized card name, set, finish, and optional
   product. Name matching ignores accents, so `Mazuj Ifrit` matches Sorcery's
   `Màzuj Ifrit`.
3. Calls `POST /api/trpc/inventory.updateCard` with
   `{printingId, quantity, notes?}`. `quantity` is the desired total, not an
   increment.

When an unqualified row has several products, the regular Booster printing is
preferred. The extension reports a row instead of guessing if the result is
still ambiguous. Failed rows can be saved with **Download report.csv**.

## Record mode

The **Record** tab is a diagnostic tool for API changes:

1. Open a signed-in `sorcerytcg.com` page.
2. Click **Start recording**.
3. Manually change a card quantity or note.
4. Click **Stop**, then **Download sorcerytcg-trace.json**.

The trace includes page events, DOM mutations, and truncated fetch/XHR request
and response bodies. Review it before sharing because it can contain card
notes or other information visible in your session. Session cookies and
request headers are not recorded.

## File map

| File | Purpose |
| ---- | ------- |
| `manifest.json` | Manifest V3 definition and Sorcery host permissions |
| `popup.html`, `popup.css`, `popup.js` | Persistent importer page, CSV parser, controls, and logs |
| `content.js` | Catalogue matching, collection updates, and recording |
| `inject.js` | Page-world fetch/XHR recorder |
| `background.js` | Recorder state stored in `chrome.storage.session` |

## Troubleshooting

- **No sorcerytcg.com tab open** — open `https://sorcerytcg.com/collection`
  before starting the import.
- **Unsupported CSV** — export from Collectr or Kurio and keep the original
  column headers. The error names the required columns.
- **Not signed in to sorcerytcg.com** — sign in, reload the collection page,
  and retry. Successfully processed earlier rows already contain their target
  totals, so replaying them is safe.
- **Catalogue HTTP error** — check access to `https://api.sorcerytcg.com` and
  retry. A failed catalogue request is not cached.
- **No printing in set** — verify the Collectr set and variance. Box toppers
  must include `(Box Topper)` in the product name.
- **Ambiguous printing** — download the report and resolve that printing
  manually rather than allowing the importer to guess.
