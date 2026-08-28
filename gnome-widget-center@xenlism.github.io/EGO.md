# Reviewer notes — EGO-X-004 (synchronous file IO in shell code)

**Fully resolved.** All previously-open items are closed:

- `WidgetLoader.discover()` / `ThemePackRegistry.discover()` and
  `widgetCenterOverlay.js`'s `_scanMetadataFolders()` are genuinely `async`
  and awaited at every call site.
- `storageService.js`, `widgetConfigReader.js`, `themeService.js`,
  `settingsStore.js`, `prefsWindowControllerBase.js` are converted or use an
  intentional in-memory cache (see each file's own comments for why).
- `systemMetricsApi.js` and the widgets that poll it use the async
  `/proc`/`/etc` reads.
- The last item — `widgets/xtile/widget.js` and
  `widgets/geek-architect/widget.js` reading their own `metadata.json`
  synchronously in the constructor — is now closed too. Both expose an
  opt-in `static async createInstance(api)` that reads metadata.json via
  `readTextFileAsync()` and passes it into the constructor;
  `lib/shell/widgetRuntimeLoader.js`'s two construction sites
  (`loadOne()`, `reloadWidget()`) call this instead of plain `new` when a
  widget module defines it. Every other bundled widget has no
  `createInstance()`, so it's built exactly as before — this was additive,
  not a contract change for the ~50 other widgets. The constructors' plain
  synchronous `readTextFile()` path is kept as a fallback for any direct
  `new` call (defense in depth, not currently exercised anywhere in this
  codebase — the only two construction sites both go through the loader).

`lib/fsUtils.js`'s `readTextFile()`/`readBytesFile()` sync function
*definitions* stay synchronous on purpose — they're still the correct
shared utility for the widget-constructor fallback above and the
intentional caches in `storageService.js`/`themeService.js`/
`widgetConfigReader.js`.

**Not independently verified in a live GNOME Shell session** — no GJS
runtime in this sandbox, `node --check` (syntax only) plus a repo-wide
import-graph check were used instead. Before shipping, smoke test: adding
`xtile`/`geek-architect` to the desktop, the "Add child" button showing up
correctly on the parent (and not on its children), and dev-mode hot-reload
of both widgets after an on-disk edit.
