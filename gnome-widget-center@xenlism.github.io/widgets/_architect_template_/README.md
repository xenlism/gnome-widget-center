# _architect_template_

Starting point for a new **Architect Widget** — a normal widget that can
create Child Widgets from its own `child/` template. See the XTile
Architecture doc for the full design; this scaffold implements it
generically, so you don't need XTile itself to build your own.

Copy this whole `widgets/_architect_template_/` folder, rename it
(everywhere `_architect_template_` and `xenlism.github.io.my-architect-widget`
appear), then:

1. **`metadata.json`** — change `"id"` and `"name"`, write a real
   `"description"`. This file must NOT have a `"parent"` field — that's
   only on Children.
2. **`widget.js`** — rename the class, replace the label with your
   actual content, and fill in `_addChild()`'s `configOverrides` with
   whatever your Architect needs to hand each new Child (see the TODO
   comment there). Don't paint your own "+ Add Widget" button — as
   long as `_addChild()` exists (and isn't shadowed to `undefined` on
   Children, see the constructor), the host adds an "Add Widget" icon
   to this widget's edit-mode toolbar automatically.
3. **`config.json`** — the Architect's OWN settings (rare — most
   Architects don't need any).
4. **`child/`** — the actual template that gets copied per Child.
   - `child/metadata.json` — the `id`/`parent` fields are overwritten
     automatically at creation time; everything else is yours.
   - `child/config.json` — **this is where per-Child differences live.**
     Add one field per thing that varies between Children (a metric to
     read, an app to launch, an icon, a color — whatever your Architect
     is for).
   - `child/widget.js` — defaults to re-exporting the Parent's own
     class (no new code per Child). Only switch to the commented
     `extends` pattern if a specific Child genuinely needs different
     *behavior*, not just different *data*.
5. **`stylesheet.css`** — rename the `.architect-template-widget-*`
   classes to match.

## Why Children default to "same class, different config"

`lib/architectWidgetKit.js` supports real subclassing too (see the
commented-out block in `child/widget.js`), but the default this
scaffold ships is `export { default } from "{{PARENT_ENTRY_URI}}"` —
literally the same class the Parent uses, imported by absolute path.

This mirrors how this codebase's own near-duplicate widget families
already work today — `widgets/circles-cpu/widget.js` and
`widgets/circles-mem/widget.js` are ~198 lines each, identical except
for a label and which metric-getter gets called. An Architect Widget
that converts a family like that into Parent + Children should end up
with **one** real implementation (in the Parent) and N `config.json`
files, not N copies of the same widget.js.

## `lib/architectWidgetKit.js` — what it does and doesn't do

- `generateChildId(parentId, childName)` — XTile Architecture §8's
  `<parent_widget_id>-<child_name>-<YYYYMMDDHHMMSS>` format.
- `resolveParentEntryUri(api, entryFile)` — turns `api.path.me` (already
  provided by the widget loader to every widget) into an absolute
  `file://` URI a Child anywhere on disk can import.
- `createChildWidgetFromParent(api, parentMetadata, childName, options)`
  — copies `child/`, stamps `id`/`parent`/`name` into the copy's
  metadata.json, merges `options.configOverrides` into the copy's
  config.json field defaults, and rewrites the `{{PARENT_ENTRY_URI}}`
  placeholder.

It does **not** know anything about what any particular Architect's
Children actually do (that's XTile's job, or yours). It DOES make the
new Child appear immediately, without a manual "Rescan widgets": by
default `createChildWidgetFromParent()` calls `api.host.rescan()` once
the Child's files are written. That hook is a small addition to the
host itself (`lib/widgetLoader.js`'s `_buildApi()` + a callback wired
in `extension.js`) that discovers and places any not-yet-loaded widget
directory — the same code path the host already used whenever the
disabled-widgets list changes, just also reachable from a widget. It's
best-effort and optional-chained throughout, so a widget built against
an older host without this hook just falls back to the user rescanning
manually — nothing breaks either way. Pass `{rescan: false}` in
`createChildWidgetFromParent()`'s options if you're creating several
Children in a row and want to rescan once yourself at the end.

## "+ Add Widget" lives in the edit-mode toolbar, not on the card

Earlier versions of this scaffold painted their own "+ Add Widget"
`St.Button` inline in the card. That's gone: `extension.js`'s
`_placeEntry()` checks `typeof instance._addChild === "function"` when
it attaches `lib/widgetEditMode.js` to each widget, and only when
true does that widget's edit-mode toolbar (the row shown when you
right-click the widget, alongside Settings/Reset/Remove/Uninstall)
grow an extra "Add Widget" icon. Clicking it calls your `_addChild()`
exactly like the old button did — `_addChild()`'s own job (prompt,
`createChildWidgetFromParent()`, `configOverrides`) is unchanged.

Consequences for your `widget.js`:
- Don't create an `St.Button` for this in `buildActor()`.
- Keep the constructor's `if (this._metadata.parent) this._addChild =
  undefined;` line — it's what stops a Child from also showing an
  "Add Widget" icon (Children must not spawn grandchildren).
- If your Architect needs the icon to appear conditionally on
  something other than "is this the top-level Parent", shadow
  `_addChild` to `undefined` under that condition instead — the host
  only ever looks at whether the method exists.

## Everything else is a normal widget

An Architect Widget and its Children both follow every normal Widget
Rule — `config.json`, Widget Preferences, lifecycle, Widget Layer
Rules, enable/disable, uninstall. See `widgets/_template/README.md` and
`WIDGET_API.md` for all of that; nothing here replaces it.
