# PDF Studio — layered PDF editor (browser)

A Canva-style editor for **any existing PDF**: the original page is rendered pixel-for-pixel
underneath, and everything you add or change lives on its own draggable layer.

No install, no server — three files open straight in Chrome.

```
index.html   ← open this
styles.css
editor.js
```

> **Internet needed once per load:** pdf.js, fabric.js and pdf-lib come from CDNs.
> Your PDF never leaves the machine — all processing happens in the browser tab.

---

## Quick start

1. Double-click `index.html` (Chrome recommended).
2. **Open PDF** or drag a PDF anywhere onto the page.
3. **Double-click a word** on the page → just that word gets replaced by an editable text box with
   the detected font, size, weight, italic and colour, plus a matching background patch. Hold
   **Alt** or **Shift** while double-clicking to take the whole line (or one table cell).
4. Type the new text. Drag it, resize it, recolour it from the right panel.
5. **Export ▾** → choose *Vector PDF* or *Flattened PDF*.
6. Use **Pages** for the thumbnail grid (rotate / reorder / insert), **Merge / Split** to combine
   or divide files, and the rail tools for **Background** removal, **Signature** and **Table**.

---

## What you can do

| Area | Tools |
|---|---|
| Text | **Word-level** double-click editing, add new text, font (Helvetica / Times / Courier **+ your own / Google fonts**), size, bold, italic, align, colour, optional **transparent** background |
| Tables | Auto-detected per page; the pencil button makes every cell editable, CSV saves the values, the download button saves a PNG of the table; **Table** tool inserts a new editable rows × columns table |
| Images | Place image, drag & drop, paste from clipboard (`Ctrl+V`), rotate with the mouse, scale, flip, opacity |
| Original images | **Peel** stacked images one layer at a time, then drag / scale / rotate / delete; save any layer as PNG; remove; restore; save any original as PNG |
| Background | Magic wand, freehand lasso, polygon lasso and **smart select**, with tolerance and undo; keep the result transparent or replace the page |
| Signature | Draw, type with a chosen font, or upload a PNG; save signatures for reuse and place / drag / resize them |
| Shapes | Box, ellipse, line, freehand pen, highlighter; fill, stroke colour and width, opacity |
| Rotate | Drag the large round handle above any selected text, image, shape, table or multi-selection, or pick **Rotate** (`G`) and drag the object itself; hold **Shift** to snap to 15° |
| Patch | Paint an opaque rectangle over anything (whiteout / cover) |
| Pages | Thumbnail grid with multi-select, drag reorder, rotate 90° CW/CCW/180°, delete with confirmation, add blank pages with a chosen size, insert pages from another PDF or images |
| Merge / Split | Page-level merge organiser: all pages from every added PDF appear as large, lazy-loaded thumbnails that can be reordered, rotated and deleted before merging; split by page range, every N pages, every page, or selected pages |
| Layers | Reorder (front / forward / backward / back), show / hide, **lock / unlock**, rotate to an exact angle, select, delete, **save the selected layer(s) as a transparent PNG** (Ctrl/Shift-click to pick several) |
| View | Zoom in/out, Fit, undo / redo per page |
| Export | Vector (original text kept) or Flatten (exact pixels), any page range, per-page source documents |

### Keyboard

`V` select · `G` rotate · `T` text · `B` patch · `I` image · `R` box · `O` ellipse · `L` line · `P` pen · `H` highlight · `D` detach original image
`Del` delete · arrows nudge 1 pt (Shift = 10 pt) · `Ctrl+Z` / `Ctrl+Y` undo / redo · `Ctrl+S` export

---

## Your own fonts

The **Fonts** panel in the right sidebar does two things:

- **＋ Font file** — pick a `.ttf`, `.otf`, `.woff` or `.woff2` from your computer. It is
  registered instantly and appears in the font dropdown under **My fonts**.
- **Google Font…** — type any Google Fonts family name (for example `Poppins`, `Lato`,
  `Merriweather`). It is downloaded and added to the dropdown.

Uploaded fonts are saved in the browser (`localStorage`) so they are still there after a
reload. Google fonts need internet each time they are used; remove a font with the `×` in the
font list.

> In **Vector** export only the three standard PDF fonts can be embedded as real text.
> Text using a custom font is rendered at 3× and placed as a transparent image, so it looks
> identical but is not selectable in the exported PDF. *Flatten* also looks identical.

---

## Text: words, lines and transparency

- **Double-click a word** replaces only that word. The rest of the line, the other columns and
  everything around it keep their original pixels.
- **Alt / Shift + double-click** replaces the whole visual line. If the line is a table row,
  it replaces that one **cell** instead of merging the row into a single line.
- **Cover replaced text with a patch** (checked by default) hides the original word with a
  colour sampled from its surroundings, so the edit looks native.
- Uncheck it, or press **No patch** for a selected edited text (multi-selection works too), to
  delete the background rectangle. The text layer then has a **transparent** background and can
  be dragged anywhere without carrying a visible patch with it (the original text underneath
  becomes visible again).
- While a replaced word has a patch, the patch **follows the text** when you drag it, and
  deleting the text deletes its patch as well (duplicating keeps a matched pair).

## Tables

The **Tables** panel scans the current page and lists every table it finds, with its row/column
count.

- The **pencil** button turns every cell into its own editable text layer. The table grid, fills and borders
  that are part of the original page are left untouched, so replacing a value never erases the
  table itself. The same *Cover replaced text with a patch* setting applies: uncheck it to
  extract transparent cells (the original cell text then stays visible underneath).
- **CSV** saves the extracted values as a spreadsheet file.
- The **download** button saves a PNG crop of the table exactly as it looks right now (original grid + your edits).

---

## Inserting tables

The **Table** tool creates a real, editable table on the current page (or on a new page):
rows × columns (3 × 3 by default), placeholder text, header bold, cell fill, header fill,
border colour and width, font size, and the page size/orientation when *Insert on a new page*
is ticked. Every cell is a separate text layer over its own grid cell, so you can edit one cell
without touching the rest. The table behaves as one unit: drag any cell to move the whole table,
use the corner handles to resize or rotate it as a block, and **double-click a cell** to type in
it. Delete or duplicate removes/copies the complete table. Unlike extracting an existing table,
the new table has no original background to preserve.

## Pages, rotation and merge / split

**Pages** opens a thumbnail grid of the whole document:

- Click a thumbnail to select it; **Ctrl/Shift-click** several pages.
- **Rotate left / right / 180°** buttons rotate every selected page. The original page and all edited layers
  rotate together, and the page's width/height swap for 90° / 270°.
- **Delete** asks for confirmation, then removes the selected pages (one page always remains).
- **Add pages** inserts a blank page before/after the selection with A4/A3/Letter/Legal or a
  custom size (mm / cm / inch / px / pt, portrait or landscape).
- **Insert from PDF / images** adds pages from other files at the selected position.
- Drag a thumbnail onto another to reorder pages (or use the move buttons).

**Merge / Split**:

- *Merge PDFs*: add several files and every page from every file appears in one large thumbnail grid.
  Drag any page to reorder it, use the per-page rotate buttons, and remove individual pages with the
  trash button (or remove a whole file from its chip). The output follows the displayed page order,
  then choose **Merge & download** (one PDF) or **Merge & open in editor**. Thumbnails render
  lazily, so long documents stay smooth.
- *Split current PDF*: by **page range** (`1-5, 8-10`), **every N pages**, **one PDF per page**,
  or **selected pages**. Multiple outputs are packed into a ZIP download.

## Removing backgrounds

The **Background** tool works on the current page background or on a selected image layer.
It rasterizes the source first (so PDF text becomes pixels), then gives you:

- **Magic wand** — click a colour region; the tolerance slider controls how far the selection
  spreads.
- **Smart select / Auto remove** — samples the page corners and selects the dominant background
  while stopping at strong edges.
- **Lasso / polygon** — draw the area to remove by hand; polygon closes when you click its first
  point again.
- **Undo** steps back through selections, and **Make selected transparent** clears the alpha of
  the selected pixels.
- **Replace page** stores the result as the page background; **Download PNG** saves a transparent
  PNG. A selected image layer is replaced in place instead.

Background removal is an image operation: it cannot reconstruct what was hidden behind an
object, and only raster content can be keyed out (text is rasterized first).

## Signatures

**Signature** opens a panel with three sources:

- **Draw** on the pad with the mouse, pen or finger (Clear / Undo available).
- **Type** your name and pick a handwriting font.
- **Upload** a PNG signature with a transparent background.

Name it and **Save** to keep it in the reuse gallery (`localStorage`). **Insert** places it on
the current page as a normal image layer, so it can be dragged, resized, rotated and locked.
Saved signatures can be inserted again on any page or in a later session.

## Locking and exact angles

Select any layer to use the **Angle** field (type an exact degree, or use the ±90° buttons) in
the properties panel. The **Layers** panel adds a lock toggle per layer: a locked layer stays
selectable (so you can unlock it) but cannot be moved, scaled or rotated, and a hide toggle
removes it from the canvas without deleting it. These states are saved with the page and
survive page switches, undo/redo and export.

### Rotating with the mouse

Every selected text box, image, vector shape, table or multi-selection has a large round
rotation handle above it — drag that handle to spin the object around its visual centre.
For a larger target (or when the handle would be clipped near the top of the page), pick the
**Rotate** tool (`G`) and drag anywhere on the object; it follows the pointer's angle around
the centre. Hold **Shift** while dragging to snap to 15° steps. The angle field updates live,
and the rotation is saved with the page just like the ±90° buttons.

---

## Moving / deleting images that came from the PDF

The original PDF is rendered as a locked background — that is why it stays pixel-perfect.
To edit an image that belongs to the PDF:

1. Open the **Original images** panel (right sidebar). Every image occurrence on the current
   page is listed with a thumbnail.
2. The **scissors** button (or pick the **Detach** tool and click the image on the page) turns the **topmost**
   image under the cursor into a normal layer. Nothing moves visually — that one draw call is
   hidden and an identical editable layer is placed exactly on top.
3. If several images/frames/logos are stacked in the same spot, keep clicking with the Detach
   tool: each click peels exactly one more layer. The panel lists them separately, so you can
   also peel a specific one with its own scissors button. Repeat until the background is white (or
   reveals whatever was painted underneath).
4. Now drag, scale, rotate or `Del` any peeled layer like a normal layer.
5. The **download** button next to an image saves that original image as a PNG. **Download — Save selected layer PNG** in
   the Layers panel saves the selected edited layer as a cropped transparent PNG, ready to be
   reused or saved separately.
6. The **trash** button removes the image without creating a layer.
7. **Restore originals** (or the restore arrow next to a hidden row) puts that original layer back and
   deletes its detached copy. Undo / redo covers all of this too.

The page is re-rendered without only the selected image occurrence, so whatever was painted
*under* that image (colour band, another picture, vector art) shows through correctly.


---

## Export modes — which one?

**Vector PDF** — copies the original PDF pages and draws your edits on top as real text/vector
shapes. The original document text stays selectable and searchable. Best for documents and
small text changes. Pages that cannot be copied safely are rasterized automatically: a page
where you removed/detached an image, a rotated page, an image or cleaned-background page, and
pages from an encrypted source. Custom-font text is placed as a high-resolution transparent
image while everything else on the page stays vector.

**Flattened PDF** — renders each page (original + your layers) to a 2× image and wraps it in a
PDF. What you see is exactly what you get, on any viewer. Best when the original uses exotic
fonts/images or when you need guaranteed identical output. Use **Export ▾** to choose all pages
or just a page range.

Both modes were verified against a rasterized ground truth: axis-aligned shapes, images,
ellipses, lines, freehand paths, flipped/rotated images, rotated pages and multi-line text
land on the **same pixels** (mean channel difference ≤ 0.12/255, typically 0.02).

---

## How auto-detection works

- **Font family** comes from the PDF's own font object (`page.commonObjs`), so
  Helvetica / Times / Courier and their bold/italic variants are exact.
- **Bold / italic** use the PDF font flags (`bold`, `italic`, `black`); if a PDF has broken
  descriptors, a stem-thickness fallback estimates weight from the rendered pixels.
- **Size** comes from the text transform matrix.
- **Colour** is sampled from the ink pixels of the line (median of dark pixels, ignoring
  anti-aliased edges).
- **Background patch** is the median colour around the clicked word/cell, so replacements on
  coloured bands keep the band colour. It can be turned off for transparent text.

---

## Honest limitations

1. **Standard PDF fonts vs custom fonts.** Helvetica / Times / Courier embed as real text in
   Vector export. Uploaded and Google fonts are previewed and exported faithfully, but their
   text becomes a high-resolution image in Vector export (browsers cannot embed arbitrary font
   files into a PDF without a font-subsetting library). *Flatten* is identical either way.
2. **A replacement text patch is a flat colour.** If the edited word sits on a gradient, photo
   or pattern, the patch may be visible. Uncheck *Cover replaced text with a patch* to keep the
   text transparent and place it on a matching background, or cover the area with an image.
3. **Background replacement is a rectangle, not content-aware fill.** It cannot reconstruct what
   was behind an object; it paints over it.
4. **Scanned PDFs have no text layer**, so double-click editing finds nothing. Use *Patch* +
   *Text* to rebuild the line.
5. **Non-uniform text scaling** (different X and Y scale on the same text) is approximated;
   normal uniform text is exact.
6. **Rotated source pages and encrypted PDFs** are always exported rasterized (flattened),
   because pdf-lib cannot safely copy/rotate those content streams. Editing still works normally.
7. **Very large PDFs** (hundreds of pages / high-res scans) use a lot of memory: pages are
   rendered on demand, but exports process one page at a time at 2× scale.
8. Text extraction groups glyphs into visual lines and splits them into words from the PDF's own
   glyph advances. Unusual PDFs (custom text matrices, Type3 fonts) may produce approximate word
   boxes; use Alt/Shift double-click or a Patch + Text layer for those.
9. Undo history is per page and kept in memory only — reloading the tab loses unsaved edits.
10. **Image peeling works per painted occurrence.** An image painted several times by one
     operation (tiled backgrounds/patterns) is now peeled one tile at a time; the Original
     images panel lists each occurrence separately. Images inside unusual colour spaces or
     1-bit stencil masks are skipped by the scanner (they still render in the page background).
11. Uploaded fonts are stored in `localStorage`; a very large font (or many fonts) may exceed
    the browser quota and then only lasts for the current tab. Google Fonts require internet.
12. Table detection looks for ≥2 rows of gutter-separated cell runs. Very irregular layouts
    (merged cells, wrapped multi-line cells, tables drawn as a single text run without gaps)
    may split or miss a table; the cells that are detected are still individually editable.
    Form labels with a big gap between label and value can also look like a small table.
13. Peeling only separates **raster image** layers. A frame/logo drawn as vector paths, or
    anything flattened into one scanned bitmap, has no separate layer to peel — use *Patch* to
    cover it, or detach/remove the whole scan and rebuild on a blank page.
14. **Background removal** is a raster operation. It cannot rebuild what was behind a removed
    object, very large pages are capped at 1600 px for the editing mask, and anti-aliased edges
    may keep a thin fringe — lower the tolerance or use the lasso for a clean cut.
15. **Merge / split** re-encodes the pages with pdf-lib. Form fields, links, bookmarks,
    attachments and JavaScript actions are not carried over; visual page content is.
16. **Drawn signatures** are captured from the canvas at screen resolution. They stay sharp at
    the inserted size; typing or uploading a high-resolution PNG gives better results when you
    need to scale a signature up a lot. Saved signatures live in `localStorage` (per browser).
17. **Page rotation** rotates the original page as a whole with your layers. A 90°/270° page is
    exported rasterized in Vector mode; Flatten mode always matches the screen exactly.

---

## Files

- `index.html` — UI markup, CDN scripts
- `styles.css` — dark UI
- `editor.js` — PDF loading, text/font detection, layer state, history, export
- `window.PDFStudio` — small debug API (`state`, `canvas`, `getTextLines`, `buildPdf`, …)
