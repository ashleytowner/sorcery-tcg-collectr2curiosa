#!/usr/bin/env python3

import argparse
import csv
import hashlib
import io
import json
import urllib.request
from collections import defaultdict
from datetime import datetime
from pathlib import Path

CARDS_URL = "https://raw.githubusercontent.com/JollyGrin/sorcery-tcg-playtest/refs/heads/main/public/card-data/cards.json"
IMAGE_URL = "https://card.cards.army/cards/{slug}.webp"
SCRIPT_DIR = Path(__file__).parent
CARDS_FILE = SCRIPT_DIR / "cards.json"
EXPORT_FILE = SCRIPT_DIR / "export.csv"
CACHE_DIR = SCRIPT_DIR / ".image_cache"

# Print layout
CARD_W, CARD_H = 200, 280
COLS = 6
PRINT_ALL_WIDTH = 1920
PADDING = 8
BADGE_R = 22

PLAYSET = {
    "ordinary": 4,
    "exceptional": 3,
    "elite": 2,
    "unique": 1,
    "avatar": 1,
}


# ---------------------------------------------------------------------------
# Sync
# ---------------------------------------------------------------------------

def file_md5(path: Path) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def sync_cards():
    print("Checking cards.json...", end=" ", flush=True)
    with urllib.request.urlopen(CARDS_URL) as resp:
        remote_data = resp.read()
    remote_md5 = hashlib.md5(remote_data).hexdigest()

    if CARDS_FILE.exists() and file_md5(CARDS_FILE) == remote_md5:
        print("up to date.")
        return

    CARDS_FILE.write_bytes(remote_data)
    print("updated.")


# ---------------------------------------------------------------------------
# Load cards.json
# ---------------------------------------------------------------------------

def _to_filter_set(value):
    """Normalise a filter arg (None, str, or iterable of str) to a lowercase set
    of values, or None if empty."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        return {value.lower()}
    out = {v.lower() for v in value if v}
    return out or None


def load_cards(set_filter=None, rarity_filter=None, type_filter=None, one_of=False):
    """Returns {(set_name, card_name): {rarity, type, playset, slug, ...}}

    `rarity_filter` and `type_filter` may each be a string, an iterable of
    strings, or None.
    """
    with open(CARDS_FILE) as f:
        raw = json.load(f)

    rarity_set = _to_filter_set(rarity_filter)
    type_set = _to_filter_set(type_filter)

    result = {}
    for card in raw:
        guardian = card.get("guardian") or {}
        card_type = (guardian.get("type") or "").lower()
        rarity = (guardian.get("rarity") or "").lower()
        if card_type == "avatar":
            rarity = "avatar"

        if rarity_set and rarity not in rarity_set:
            continue
        if type_set and card_type not in type_set:
            continue

        for s in card.get("sets", []):
            set_name = s["name"]
            if set_filter and set_filter.lower() not in set_name.lower():
                continue
            key = (set_name, card["name"])
            result[key] = {
                "name": card["name"],
                "set": set_name,
                "rarity": rarity,
                "type": card_type,
                "playset": 1 if one_of else PLAYSET.get(rarity, 1),
                "slug": card.get("slug", ""),
                # Detail fields used by the text-only PDF proxy.
                "cost": guardian.get("cost"),
                "attack": guardian.get("attack"),
                "defence": guardian.get("defence"),
                "life": guardian.get("life"),
                "rules_text": (guardian.get("rulesText") or "").strip(),
                "thresholds": guardian.get("thresholds") or {},
                "sub_types": (card.get("subTypes") or "").strip(),
                "elements": (card.get("elements") or "").strip(),
            }
    return result


# ---------------------------------------------------------------------------
# Load export CSV
# ---------------------------------------------------------------------------

def load_collection(set_filter=None):
    """Returns {(set_name, card_name): {normal, foil}}"""
    collection = defaultdict(lambda: {"normal": 0, "foil": 0})
    with open(EXPORT_FILE, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            set_name = row["Set"].strip()
            if set_filter and set_filter.lower() not in set_name.lower():
                continue
            name = row["Product Name"].strip()
            if name.endswith(" (Foil)"):
                name = name[:-7]
            variance = row["Variance"].strip().lower()
            qty = int(row["Quantity"] or 0)
            key = (set_name, name)
            if variance == "foil":
                collection[key]["foil"] += qty
            else:
                collection[key]["normal"] += qty
    return dict(collection)


# ---------------------------------------------------------------------------
# Table printer
# ---------------------------------------------------------------------------

def print_table(headers, rows):
    widths = [len(str(h)) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))

    sep = "+-" + "-+-".join("-" * w for w in widths) + "-+"
    fmt = "| " + " | ".join("{:<" + str(w) + "}" for w in widths) + " |"

    print(sep)
    print(fmt.format(*[str(h) for h in headers]))
    print(sep)
    for row in rows:
        print(fmt.format(*[str(c) for c in row]))
    print(sep)


# ---------------------------------------------------------------------------
# Sorting
# ---------------------------------------------------------------------------

RARITY_ORDER = {"ordinary": 0, "exceptional": 1, "elite": 2, "unique": 3, "avatar": 4}


def _sort_key(item, sort_by):
    if sort_by == "rarity":
        return (RARITY_ORDER.get(item["rarity"], 99), item["name"])
    if sort_by == "missing":
        return (item["missing"], item["name"])
    return item["name"]  # default: name


def apply_sort(items, sort_by, reverse):
    return sorted(items, key=lambda i: _sort_key(i, sort_by), reverse=reverse)


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_unique(cards, collection, sort_by="name", reverse=False):
    by_set = defaultdict(list)
    for (set_name, card_name), info in cards.items():
        owned = collection.get((set_name, card_name), {"normal": 0, "foil": 0})
        total = owned["normal"] + owned["foil"]
        by_set[set_name].append({
            "name": card_name,
            "rarity": info["rarity"],
            "type": info.get("type", ""),
            "missing": info["playset"] - total,
            "normal": owned["normal"],
            "foil": owned["foil"],
            "total": total,
            "playset": info["playset"],
        })

    for set_name, items in sorted(by_set.items()):
        items = apply_sort(items, sort_by, reverse)
        rows = [(i["name"], i["rarity"].capitalize(), i["type"].capitalize(),
                 i["normal"], i["foil"], i["total"], i["playset"]) for i in items]
        print(f"\n=== {set_name} ===")
        print_table(["Card", "Rarity", "Type", "Normal", "Foil", "Total", "Playset"], rows)


def cmd_missing(cards, collection, sort_by="name", reverse=False, show_all=False):
    by_set = defaultdict(list)
    for (set_name, card_name), info in cards.items():
        owned = collection.get((set_name, card_name), {"normal": 0, "foil": 0})
        total = owned["normal"] + owned["foil"]
        missing = info["playset"] - total
        if missing > 0 or show_all:
            by_set[set_name].append({
                "name": card_name,
                "rarity": info["rarity"],
                "type": info.get("type", ""),
                "missing": max(missing, 0),
                "owned": f"{total}/{info['playset']}",
            })

    for set_name, items in sorted(by_set.items()):
        items = apply_sort(items, sort_by, reverse)
        rows = [(i["name"], i["rarity"].capitalize(), i["type"].capitalize(),
                 i["owned"], i["missing"]) for i in items]
        print(f"\n=== {set_name} ===")
        print_table(["Card", "Rarity", "Type", "Have/Need", "Missing"], rows)
        missing_cards = [i for i in items if i["missing"] > 0]
        total_missing = sum(i["missing"] for i in missing_cards)
        print(f"  {len(missing_cards)}/{len(items)} cards missing, {total_missing} copies needed\n")


def _missing_items(cards, collection, sort_by="name", reverse=False, show_all=False):
    items = []
    for (set_name, card_name), info in cards.items():
        owned = collection.get((set_name, card_name), {"normal": 0, "foil": 0})
        total = owned["normal"] + owned["foil"]
        missing = info["playset"] - total
        if (missing > 0 or show_all) and info.get("slug"):
            items.append({
                "name": card_name,
                "set": set_name,
                "slug": info["slug"],
                "missing": max(missing, 0),
                "rarity": info["rarity"],
                "type": info.get("type", ""),
            })
    return apply_sort(items, sort_by, reverse)


def _fetch_card_image(slug, set_name):
    """Download card image into set subfolder cache, return PIL Image or None."""
    from PIL import Image

    set_dir = CACHE_DIR / set_name
    set_dir.mkdir(parents=True, exist_ok=True)
    cache_path = set_dir / f"{slug}.webp"

    if not cache_path.exists():
        url = IMAGE_URL.format(slug=slug)
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                              "AppleWebKit/537.36 (KHTML, like Gecko) "
                              "Chrome/120.0.0.0 Safari/537.36"
            })
            with urllib.request.urlopen(req, timeout=10) as resp:
                cache_path.write_bytes(resp.read())
        except Exception as e:
            print(f"\n  [warn] {slug}: {e}")
            return None

    try:
        return Image.open(cache_path).convert("RGBA")
    except Exception:
        return None


RARITY_COLOR = {
    "ordinary":   (120, 120, 120),
    "exceptional": (60, 140, 60),
    "elite":      (60,  90, 180),
    "unique":     (160,  60, 160),
    "avatar":     (180, 120,  30),
}


def cmd_print(cards, collection, set_filter=None, limit=None, sort_by="name", reverse=False,
              show_all=False, one_of=False):
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        print("Pillow required: pip install Pillow")
        return

    # all items for summary stats, then optionally slice for display
    all_items = _missing_items(cards, collection, sort_by=sort_by, reverse=reverse, show_all=True)
    items = _missing_items(cards, collection, sort_by=sort_by, reverse=reverse, show_all=show_all)
    if limit:
        items = items[:limit]
    if not items:
        print("No cards to display.")
        return

    # layout constants
    NAME_H   = 18
    RARITY_H = 16
    HEADER_H = 50
    total    = len(items)
    cell_w   = CARD_W + PADDING
    cell_h   = NAME_H + CARD_H + RARITY_H + PADDING

    if show_all:
        cols     = (PRINT_ALL_WIDTH - PADDING) // cell_w
        canvas_w = PRINT_ALL_WIDTH
    else:
        cols     = COLS
        canvas_w = cols * cell_w + PADDING

    grid_rows = (total + cols - 1) // cols
    canvas_h  = HEADER_H + grid_rows * cell_h + PADDING

    canvas = Image.new("RGB", (canvas_w, canvas_h), (30, 30, 30))
    draw   = ImageDraw.Draw(canvas)

    try:
        font_sm     = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
        font_name   = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 12)
        font_rarity = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 11)
        font_badge  = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 22)
        font_header = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 16)
    except Exception:
        font_sm = font_name = font_rarity = font_badge = font_header = ImageFont.load_default()

    # --- Summary header ---
    total_cards   = len(all_items)
    complete      = sum(1 for i in all_items if i["missing"] == 0)
    missing_count = sum(i["missing"] for i in all_items if i["missing"] > 0)
    set_label_txt = set_filter or "All sets"

    generated = datetime.now().strftime("%Y-%m-%d %H:%M")
    if one_of:
        owned_any = sum(1 for i in all_items if i["missing"] == 0)
        summary = (f"{set_label_txt}  |  owned (≥1): {owned_any}/{total_cards}"
                   f"  |  missing: {total_cards - owned_any} cards  |  {generated}")
    else:
        summary = (f"{set_label_txt}  |  complete playset: {complete}/{total_cards}"
                   f"  |  copies still needed: {missing_count}  |  {generated}")

    draw.rectangle([0, 0, canvas_w, HEADER_H], fill=(20, 20, 20))
    draw.text((PADDING, HEADER_H // 2 - 10), summary, fill=(220, 220, 220), font=font_header)

    # --- Cards ---
    print(f"Fetching {total} card images (cached in .image_cache/)...")
    for idx, item in enumerate(items):
        col   = idx % cols
        row   = idx // cols
        cell_x = PADDING + col * cell_w
        cell_y = HEADER_H + PADDING + row * cell_h

        name_y   = cell_y
        img_y    = cell_y + NAME_H
        rarity_y = img_y + CARD_H + 2

        print(f"  [{idx+1}/{total}] {item['name']}", end="\r", flush=True)
        img = _fetch_card_image(item["slug"], item["set"])

        if img:
            img = img.resize((CARD_W, CARD_H), Image.LANCZOS).convert("RGB")
        else:
            img = Image.new("RGB", (CARD_W, CARD_H), (50, 50, 50))
            d = ImageDraw.Draw(img)
            d.text((10, CARD_H // 2 - 10), "No image", fill=(180, 180, 180), font=font_sm)

        canvas.paste(img, (cell_x, img_y))

        # Rarity border around card image
        border_color = RARITY_COLOR.get(item["rarity"], (100, 100, 100))
        draw.rectangle([cell_x, img_y, cell_x + CARD_W - 1, img_y + CARD_H - 1],
                       outline=border_color, width=3)

        # Card name on top
        short = item["name"] if len(item["name"]) <= 26 else item["name"][:24] + "…"
        draw.text((cell_x, name_y), short, fill=(230, 230, 230), font=font_name)

        # Rarity + Type label below card
        rarity_txt = item["rarity"].capitalize()
        type_txt   = item["type"].capitalize()
        rarity_color = RARITY_COLOR.get(item["rarity"], (180, 180, 180))
        draw.text((cell_x, rarity_y), f"{rarity_txt}  ·  {type_txt}",
                  fill=rarity_color, font=font_rarity)

        # Missing badge (bottom-right of card image) — skip if complete
        if item["missing"] > 0:
            bx = cell_x + CARD_W - BADGE_R - 4
            by = img_y  + CARD_H - BADGE_R - 4
            draw.ellipse([bx, by, bx + BADGE_R * 2, by + BADGE_R * 2], fill=(200, 30, 30))
            label = str(item["missing"])
            bbox  = draw.textbbox((0, 0), label, font=font_badge)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
            draw.text((bx + BADGE_R - tw // 2, by + BADGE_R - th // 2),
                      label, fill=(255, 255, 255), font=font_badge)

    set_label = (set_filter or "all").replace(" ", "_").lower()
    out_path  = Path.cwd() / f"missing_{set_label}.png"
    canvas.save(out_path)
    print(f"\nSaved → {out_path}  ({total} cards)")


# ---------------------------------------------------------------------------
# PDF proxy sheet (binder use)
# ---------------------------------------------------------------------------

# Real card size for a Sorcery / poker-size card.
PROXY_CARD_W_MM = 63
PROXY_CARD_H_MM = 88
PROXY_GAP_MM    = 1
PROXY_COLS      = 3
PROXY_ROWS      = 3

# Outer bucket = TYPE. Each type starts on a fresh page in the proxy PDF.
PROXY_TYPE_ORDER = {
    "site": 0, "artifact": 1, "aura": 2,
    "magic": 3, "minion": 4, "avatar": 5,
}

# Within a type, rarities are grouped rarest-first. A rarity change inside a
# type bumps to the next row (no page break).
PROXY_RARITY_ORDER = {
    "avatar": 0, "unique": 1, "elite": 2,
    "exceptional": 3, "ordinary": 4,
}


def _proxy_sort_key(item):
    return (
        PROXY_TYPE_ORDER.get(item.get("type", ""), 99),
        PROXY_RARITY_ORDER.get(item["rarity"], 99),
        item["name"],
    )


# Replace symbols that the Standard14 PDF fonts can't render reliably.
_GLYPH_SUBS = {
    "→": "->", "←": "<-", "—": "--", "–": "-",
    "·": "*", "•": "*", "…": "...",
    "“": '"', "”": '"', "‘": "'", "’": "'",
}


def _sanitize(text):
    s = text or ""
    for k, v in _GLYPH_SUBS.items():
        s = s.replace(k, v)
    return s


def _wrap_text(text, font, size, max_width):
    """Greedy word-wrap, preserving explicit line breaks."""
    from reportlab.pdfbase.pdfmetrics import stringWidth
    out = []
    for para in _sanitize(text).split("\n"):
        if not para.strip():
            out.append("")
            continue
        line = ""
        for word in para.split():
            cand = f"{line} {word}" if line else word
            if stringWidth(cand, font, size) <= max_width:
                line = cand
            else:
                if line:
                    out.append(line)
                # Hard-break overlong words.
                while stringWidth(word, font, size) > max_width and len(word) > 1:
                    cut = len(word)
                    while cut > 1 and stringWidth(word[:cut], font, size) > max_width:
                        cut -= 1
                    out.append(word[:cut])
                    word = word[cut:]
                line = word
        if line:
            out.append(line)
    return out


def _fit_rules(text, max_size, min_size, max_width, max_height,
               font="Helvetica", leading_extra=1.5):
    """Pick the largest font size whose wrapped text fits in max_height."""
    last = None
    for size in range(max_size * 2, min_size * 2 - 1, -1):
        size = size / 2.0  # 0.5pt steps
        lines = _wrap_text(text, font, size, max_width)
        line_h = size + leading_extra
        if len(lines) * line_h <= max_height:
            return lines, size, line_h
        last = (lines, size, line_h)
    # Doesn't fit even at min_size: truncate.
    lines, size, line_h = last
    keep = max(1, int(max_height // line_h))
    if len(lines) > keep:
        lines = lines[:keep]
        # Add ellipsis marker on the last line if there's room.
        lines[-1] = lines[-1][: max(0, len(lines[-1]) - 1)] + "..."
    return lines, size, line_h


def _draw_text_proxy(c, x, y, w, h, item):
    """Render one text-only proxy card at (x, y) bottom-left, size (w, h)."""
    from reportlab.lib.units import mm

    pad = 2 * mm
    inner_x = x + pad
    inner_w = w - 2 * pad

    # Cut guide border.
    c.setStrokeColorRGB(0, 0, 0)
    c.setLineWidth(0.4)
    c.rect(x, y, w, h, stroke=1, fill=0)

    # Cost box top-right.
    cost = item.get("cost")
    cost_box = 0
    if cost is not None:
        cost_box = 6 * mm
        bx = x + w - cost_box - pad
        by = y + h - cost_box - pad
        c.setLineWidth(0.5)
        c.rect(bx, by, cost_box, cost_box, stroke=1, fill=0)
        c.setFont("Helvetica-Bold", 11)
        c.drawCentredString(bx + cost_box / 2,
                            by + (cost_box - 10) / 2 + 1,
                            str(cost))

    # Name (auto-shrink, up to 2 lines).
    name_w = inner_w - (cost_box + 1 * mm if cost_box else 0)
    name_lines, name_size, _ = _fit_rules(item["name"], 11, 7, name_w, 22,
                                          font="Helvetica-Bold", leading_extra=0.5)
    cur_y = y + h - pad - name_size
    c.setFont("Helvetica-Bold", name_size)
    for line in name_lines:
        c.drawString(inner_x, cur_y, line)
        cur_y -= name_size + 0.5

    cur_y -= 2

    # Type · Rarity   Thresholds
    rarity = (item.get("rarity") or "").capitalize()
    ctype = (item.get("type") or "").capitalize()
    thresholds = item.get("thresholds") or {}
    th_parts = [f"{el[0].upper()}{thresholds[el]}"
                for el in ("air", "earth", "fire", "water")
                if thresholds.get(el)]
    type_line = " ".join(p for p in (rarity, ctype) if p)
    if th_parts:
        type_line += "    " + " ".join(th_parts)
    c.setFont("Helvetica", 7)
    c.drawString(inner_x, cur_y, _sanitize(type_line))
    cur_y -= 8

    # Subtypes.
    subtypes = (item.get("sub_types") or "").strip()
    if subtypes:
        c.setFont("Helvetica-Oblique", 6.5)
        c.drawString(inner_x, cur_y, _sanitize(subtypes))
        cur_y -= 7.5

    # Reserve stats line at the bottom (minions / avatars / sites).
    stats = []
    atk = item.get("attack")
    defn = item.get("defence")
    life = item.get("life")
    if atk is not None:
        stats.append(f"P {atk}")
    if defn is not None:
        stats.append(f"D {defn}")
    if life is not None:
        stats.append(f"L {life}")
    bottom_reserved = 10 if stats else 0

    # Rules text fills the middle, auto-fitting.
    rules = item.get("rules_text") or ""
    if rules:
        avail_top = cur_y - 1
        avail_bottom = y + pad + bottom_reserved + 1
        avail_h = avail_top - avail_bottom
        if avail_h > 6:
            lines, size, line_h = _fit_rules(rules, 8, 5, inner_w, avail_h)
            c.setFont("Helvetica", size)
            text_y = avail_top - size
            for line in lines:
                c.drawString(inner_x, text_y, line)
                text_y -= line_h

    # Stats line bottom-left.
    if stats:
        c.setFont("Helvetica-Bold", 8)
        c.drawString(inner_x, y + pad + 1, "  ".join(stats))


def _draw_image_proxy(c, x, y, w, h, item):
    """Render one image-art proxy card. Falls back to a name-only box if the
    image can't be fetched."""
    from io import BytesIO
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader

    img = _fetch_card_image(item["slug"], item["set"])
    if img:
        buf = BytesIO()
        # JPEG quality 88 is indistinguishable from source at print size and
        # keeps the PDF ~200 KB/card instead of ~3 MB for PNG.
        img.convert("RGB").save(buf, format="JPEG", quality=88, optimize=True)
        buf.seek(0)
        c.drawImage(ImageReader(buf), x, y, width=w, height=h,
                    preserveAspectRatio=False)
    else:
        c.setStrokeColorRGB(0.5, 0.5, 0.5)
        c.rect(x, y, w, h)
        c.setFont("Helvetica", 8)
        c.drawString(x + 2 * mm, y + h / 2, f"[no image] {item['name'][:28]}")

    # Faint cut guide on the card edge.
    c.setStrokeColorRGB(0.85, 0.85, 0.85)
    c.setLineWidth(0.2)
    c.rect(x, y, w, h, stroke=1, fill=0)


def cmd_pdf_proxy(cards, collection, set_filter=None, page="a4",
                  missing_only=False, one_of=False, style="text",
                  type_filter=None, break_page_by_type=False):
    """
    Default: print every card matching the filters, one slot per card (binder
    reference view). With `missing_only=True` (triggered by --missing): print
    only cards you don't have a full playset of, one slot per missing copy
    (shopping list view).
    """
    try:
        from reportlab.lib.pagesizes import A4, LETTER
        from reportlab.lib.units import mm
        from reportlab.pdfgen import canvas as rl_canvas
    except ImportError:
        print("reportlab required: pip install reportlab")
        return

    draw_card = _draw_text_proxy if style == "text" else _draw_image_proxy

    items = []
    for (set_name, card_name), info in cards.items():
        owned = collection.get((set_name, card_name), {"normal": 0, "foil": 0})
        total = owned["normal"] + owned["foil"]
        missing = info["playset"] - total
        if missing_only and missing <= 0:
            continue
        entry = dict(info)
        entry["missing"] = max(missing, 0)
        items.append(entry)

    if not items:
        print("No cards to proxy.")
        return

    items.sort(key=_proxy_sort_key)

    # missing_only: one slot per missing copy (shopping list).
    # otherwise:    one slot per card (binder reference).
    queue = []
    for it in items:
        n = it["missing"] if missing_only else 1
        queue.extend([it] * n)

    page_size = A4 if page.lower() == "a4" else LETTER
    page_w, page_h = page_size
    card_w = PROXY_CARD_W_MM * mm
    card_h = PROXY_CARD_H_MM * mm
    gap    = PROXY_GAP_MM * mm
    per_page = PROXY_COLS * PROXY_ROWS

    grid_w = PROXY_COLS * card_w + (PROXY_COLS - 1) * gap
    grid_h = PROXY_ROWS * card_h + (PROXY_ROWS - 1) * gap
    margin_x = (page_w - grid_w) / 2
    margin_y = (page_h - grid_h) / 2

    set_label = (set_filter or "all").replace(" ", "_").lower()
    # Build a type-initials suffix from the --type filter the user passed,
    # sorted by the canonical print order: site, artifact, aura, magic,
    # minion, avatar. So --type aura,artifact -> "_aa", aura alone -> "_a",
    # no --type -> no suffix.
    if type_filter:
        types_filter = [type_filter] if isinstance(type_filter, str) else list(type_filter)
        types_sorted = sorted({t.lower() for t in types_filter if t},
                              key=lambda t: PROXY_TYPE_ORDER.get(t, 99))
        type_suffix = "".join(t[:1] for t in types_sorted)
        out_path = Path.cwd() / f"proxy_{set_label}_{type_suffix}.pdf"
    else:
        out_path = Path.cwd() / f"proxy_{set_label}.pdf"
    c = rl_canvas.Canvas(str(out_path), pagesize=page_size)
    c.setTitle(f"Sorcery proxies — {set_filter or 'all sets'}")

    # Layout rules:
    #   * Default: cards flow continuously, only break on page-fill.
    #   * With break_page_by_type=True (--break-page-by-type): TYPE change
    #     also forces a new page (leaves blank tail on previous page).
    total = len(queue)
    print(f"Generating {out_path.name}: {total} proxies", flush=True)

    slot = 0
    pages_rendered = 1 if total else 0
    current_type = None

    for idx, item in enumerate(queue):
        new_type = current_type is not None and item["type"] != current_type

        if break_page_by_type and new_type:
            c.showPage()
            slot = 0
            pages_rendered += 1
        elif slot >= per_page:
            c.showPage()
            slot = 0
            pages_rendered += 1

        current_type = item["type"]

        col = slot % PROXY_COLS
        row = slot // PROXY_COLS
        x = margin_x + col * (card_w + gap)
        # reportlab origin = bottom-left
        y = page_h - margin_y - card_h - row * (card_h + gap)

        print(f"  [{idx+1}/{total}] {item['name']}", end="\r", flush=True)
        draw_card(c, x, y, card_w, card_h, item)
        slot += 1

    c.save()
    print(f"\nSaved → {out_path}  ({pages_rendered} page(s))")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(
        description="Sorcery TCG collection tracker",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
examples:
  %(prog)s --missing --set Gothic
  %(prog)s --unique --set Gothic
  %(prog)s --missing
  %(prog)s --pdf-proxy --set Beta --rarity unique,elite --type artifact
        # binder reference: one proxy slot for every Beta unique+elite artifact
  %(prog)s --pdf-proxy --set Beta --rarity unique,elite --type artifact --missing --one-of
        # shopping list: one slot per artifact you own zero of
  %(prog)s --pdf-proxy --set Gothic --rarity unique --image
        # full-art version using cached webp images
""",
    )
    parser.add_argument("--set", dest="set_filter", metavar="NAME",
                        help="Filter by set name (case-insensitive contains)")
    parser.add_argument("--unique", action="store_true",
                        help="Show normal/foil counts vs playset for each card")
    parser.add_argument("--missing", action="store_true",
                        help="Show cards where owned < playset")
    parser.add_argument("--print", action="store_true",
                        help="Generate image grid of missing cards with count badge")
    parser.add_argument("--pdf-proxy", dest="pdf_proxy", action="store_true",
                        help="Generate printable PDF of card proxies at real card "
                             "size (63x88 mm, 3x3/page) ordered by rarity then "
                             "Site/Artifact/Aura/Magic/Minion/Avatar for binder use. "
                             "Default: one slot per card matching the filter. "
                             "Combine with --missing to print only what you don't own "
                             "(one slot per missing copy).")
    parser.add_argument("--pdf-page", dest="pdf_page", default="a4",
                        choices=["a4", "letter"],
                        help="Page size for --pdf-proxy (default: a4)")
    style_group = parser.add_mutually_exclusive_group()
    style_group.add_argument("--text", dest="pdf_style", action="store_const",
                             const="text",
                             help="Text-only proxy: ink-friendly, no art (default)")
    style_group.add_argument("--image", dest="pdf_style", action="store_const",
                             const="image",
                             help="Use card art from .image_cache/ (downloads if missing)")
    parser.set_defaults(pdf_style="text")
    parser.add_argument("--break-page-by-type", dest="break_page_by_type",
                        action="store_true",
                        help="Start a new PDF page whenever the card TYPE changes. "
                             "Default: off — cards flow continuously, only breaking "
                             "when the page is full.")
    parser.add_argument("--limit", type=int, default=None, metavar="N",
                        help="Limit --print to first N cards")
    parser.add_argument("--sort", dest="sort_by", default="name",
                        choices=["name", "rarity", "missing"],
                        help="Sort order: name (default), rarity (ordinary→avatar), missing (low→high)")
    parser.add_argument("--reverse", action="store_true",
                        help="Reverse the sort order")
    parser.add_argument("--rarity", dest="rarity_filter", metavar="RARITY",
                        action="append", default=None,
                        help="Filter to one or more rarities. Repeat the flag "
                             "(--rarity unique --rarity elite) or comma-separate "
                             "(--rarity unique,elite). Allowed: ordinary, "
                             "exceptional, elite, unique, avatar.")
    parser.add_argument("--type", dest="type_filter", metavar="TYPE",
                        action="append", default=None,
                        help="Filter to one or more card types. Repeat the flag "
                             "(--type aura --type artifact) or comma-separate "
                             "(--type aura,artifact). Allowed: artifact, aura, "
                             "avatar, magic, minion, site.")
    parser.add_argument("--one-of", action="store_true",
                        help="Treat playset as 1 for every card (shows cards you own zero of)")
    parser.add_argument("--all", dest="show_all", action="store_true",
                        help="Include complete cards (missing=0) for a full collection snapshot")
    parser.add_argument("--no-sync", action="store_true",
                        help="Skip remote cards.json check")
    args = parser.parse_args()

    if not args.no_sync:
        sync_cards()

    if not args.unique and not args.missing and not args.print and not args.pdf_proxy:
        parser.print_help()
        return

    def _flatten_multi(values, allowed, flag_name):
        out = []
        for raw in (values or []):
            out.extend(p.strip().lower() for p in raw.split(",") if p.strip())
        bad = [v for v in out if v not in allowed]
        if bad:
            parser.error(f"{flag_name}: invalid value(s) {bad}; allowed: {sorted(allowed)}")
        return sorted(set(out)) or None

    rarity_values = _flatten_multi(
        args.rarity_filter,
        {"ordinary", "exceptional", "elite", "unique", "avatar"},
        "--rarity",
    )
    type_values = _flatten_multi(
        args.type_filter,
        {"artifact", "aura", "avatar", "magic", "minion", "site"},
        "--type",
    )

    cards = load_cards(set_filter=args.set_filter, rarity_filter=rarity_values,
                       type_filter=type_values, one_of=args.one_of)
    collection = load_collection(set_filter=args.set_filter)

    if args.unique:
        cmd_unique(cards, collection, sort_by=args.sort_by, reverse=args.reverse)

    if args.missing:
        cmd_missing(cards, collection, sort_by=args.sort_by, reverse=args.reverse,
                    show_all=args.show_all)

    if args.print:
        cmd_print(cards, collection, set_filter=args.set_filter, limit=args.limit,
                  sort_by=args.sort_by, reverse=args.reverse, show_all=args.show_all,
                  one_of=args.one_of)

    if args.pdf_proxy:
        cmd_pdf_proxy(cards, collection, set_filter=args.set_filter,
                      page=args.pdf_page, missing_only=args.missing,
                      one_of=args.one_of, style=args.pdf_style,
                      type_filter=type_values,
                      break_page_by_type=args.break_page_by_type)


if __name__ == "__main__":
    main()
