# CLAUDE.md — agent instructions for this repo

This is a GNOME Shell extension (`gnome-widget-center@xenlism.github.io`)
providing a widget/overlay system with theming, Force Settings, and a
theme-pack export/import flow. Read this before making changes — it
tells you where the real docs live and how to validate a change without
a live GNOME Shell session.

## Read these first, in order

1. **`WIDGET_API.md`** — the widget author contract: folder layout,
   `metadata.json` fields, the four settings systems, how to reach DBus
   services / system metrics / GNOME Shell internals from `widget.js`.
   This is the primary reference for anything touching `widgets/*/`.
2. **`tools/lint-themeable.js`** — run it, don't just read about it (see
   Validation below).

## Architecture facts that affect how you debug things

- Widgets run **in-process**: `lib/widgetLoader.js` loads each
  `widget.js` via a plain dynamic `import(\`file://...\`)` inside the
  Shell's own GJS runtime — not a sandbox. This means `resource:///org/
  gnome/shell/...` internals (`Main.*`) are technically importable from
  a widget (see WIDGET_API.md §9.4) — but they're Shell-internal with no
  API stability guarantee, so DBus (§9.1) or GSettings is always the
  first choice; `Main.*` is a documented last resort with a required
  fallback path.
- Bundled widgets (`widgets/*/widget.js`) can `import` from `lib/*.js`
  via relative paths. Third-party widgets under
  `~/.local/share/gnome-widget-center/widgets/` **cannot** — there's no
  path connecting the two folders. Don't propose a `lib/` import as a
  fix for a third-party-widget bug.
- `themeable: true` in `metadata.json` makes `ThemeService` paint a card
  background onto the widget's root actor (`this._actor`). If the
  widget *also* paints its own card onto `this._content`, you get two
  nested cards ("double-card" bug). Always run
  `tools/lint-themeable.js` after touching any widget's styling or
  `metadata.json`.
- No `package.json` / npm toolchain in this repo. Scripts under
  `tools/` are plain Node scripts (no `gi://` imports) so they run under
  `node` directly, distinct from `widget.js`/`lib/*.js` which only run
  inside GJS (Shell's runtime) and use `gi://` imports `node` can't
  resolve.

## Validation — run all of this before calling a change done

No live GNOME Shell is available in this environment, so validation is
static. Run every one of these; a change isn't done until all pass:

```bash
# 1. Syntax-check every JS file (widget.js, lib/*.js, tools/*.js)
find . -name "*.js" | while read f; do
  out=$(node --check "$f" 2>&1)
  [ -n "$out" ] && echo "FAIL: $f: $out"
done

# 2. Double-card regression guard (see Architecture facts above)
node tools/lint-themeable.js

# 3. GSettings schema is well-formed (catches dup keys, bad types)
mkdir -p /tmp/schema-test && cp schemas/*.xml /tmp/schema-test/ \
  && glib-compile-schemas --strict /tmp/schema-test/

# 4. Every metadata.json's entry/screenshot fields point at files that
#    actually exist (see the geek-date-stat-big screenshot.png/14.png
#    mismatch fixed in this repo's history for the kind of thing this
#    catches)
python3 -c "
import json, os
for w in sorted(os.listdir('widgets')):
    if w in ('_template', 'README.txt'): continue
    wdir = os.path.join('widgets', w)
    if not os.path.isdir(wdir): continue
    mp = os.path.join(wdir, 'metadata.json')
    if not os.path.exists(mp): continue
    meta = json.load(open(mp))
    for field in ('entry', 'screenshot'):
        v = meta.get(field)
        if v and not os.path.exists(os.path.join(wdir, v)):
            print(f'{w}: {field} \"{v}\" not found')
"
```

If you change anything under `schemas/`, also grep for duplicate
`<key name="...">` values — `glib-compile-schemas --strict` catches
most schema errors but a silently-duplicated key name is worth an
explicit look.

## Packaging gotcha

When zipping the repo for delivery, **do not use a bare `-x "*.git*"`
exclude pattern** — the extension's own folder name is
`gnome-widget-center@xenlism.github.io`, which contains the substring
`.github.` and gets matched by `*.git*`, silently excluding the entire
tree (`zip` then reports "Nothing to do!"). Use `-x "*/.git/*"` instead,
which only matches an actual `.git/` directory.

## Conventions worth following in new code

- Instance fields for any signal/proxy get created in `enable()` and
  torn down in `disable()` in matching pairs — grep an existing
  `disable()` for the pattern (`if (this._x && this._xSignalId) { try {
  this._x.disconnect(this._xSignalId) } catch (e) {} } this._x = null;
  this._xSignalId = null;`) before adding a new one.
- `buildActor()` must never throw, even with settings still empty —
  every external-state widget shows a placeholder/empty state instead.
- Subscribe to change signals; never poll a DBus proxy or `Main.*`
  object with `GLib.timeout_add` when a `g-properties-changed` /
  `notify::<prop>` signal is available.

## Widget layer rules (7 rules, enforced by tools/audit-layer-rules.js)

Every widget must follow this structure:

```
this._actor          ← background layer: blocksize, receives cardStyleCss
  └── this._content  ← content layer: BindConstraint(SIZE), clip_to_allocation, NO style
        └── this._background (or _innerPad) ← first child: carries card style / padding
              └── ... widget content children
  └── tooltipLabel   ← tooltip: direct child of _actor, NOT _content (R7)
```

1. **R1** `_content` must have `Clutter.BindConstraint({source: this._actor, coordinate: SIZE})` — not manual `set_size()`.
2. **R2** `themeable:true` widgets: `ThemeService.applyWidgetStyle()` paints `_actor` from GSettings first.
3. **R3** `themeable:false, forceSettingsAware:true` widgets: read `.config/<id>/config.json` → fallback `widgets/<id>/config.json` → `widget.js` defaults.
4. **R4** `_content` must have `clip_to_allocation: true` — content must never overflow.
5. **R5** `_content` is a pure clip wrapper — no `set_style()`, no `style_class`. Card style lives on a `_background` child.
6. **R6** Background color values always use 8-char hex (`#rrggbbaa`) so `toCssColor()` can preserve alpha.
7. **R7** Tooltips are children of `_actor`, never `_content` — so they can overflow the clip boundary. Coordinates computed relative to `_actor.get_transformed_position()`.

Run `node tools/audit-layer-rules.js` after any structural widget change.
