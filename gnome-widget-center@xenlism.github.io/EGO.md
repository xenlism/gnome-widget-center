# Reviewer notes — EGO-X-004 (synchronous file IO in shell code)

**Closed this pass:** `widgets/xtile/widget.js` and
`widgets/geek-architect/widget.js` no longer contain any sync file read at
all. Both constructors now *require* a pre-read `metadata` argument and
throw if it's missing, instead of silently falling back to a synchronous
`readTextFile()`. That fallback was verified dead code — the only two
construction sites, in `lib/shell/widgetRuntimeLoader.js`'s `loadOne()`
and `reloadWidget()`, always call each class's `static async
createInstance(api)` (which reads `metadata.json` via
`readTextFileAsync()`) when a widget module defines one, and both of
these widgets do. Removing the fallback closes the two constructors
without changing behavior for any of the ~50 other bundled widgets, which
have no `createInstance()` and are unaffected.

**Still open, and not fixable without a larger redesign:**
`lib/fsUtils.js`'s `readTextFile()`/`readBytesFile()` (the two
`file.load_contents(null)` calls the checker flags) stay as synchronous
function *definitions* because three call sites still have a genuine,
load-bearing need for a synchronous read, not just an oversight:

- `lib/widgetConfigReader.js` — every bundled widget's module builds its
  default config as a plain object literal at import time
  (`{...configJsonDefaults(import.meta.url)}`), so `config.json` has to be
  available before the module finishes evaluating. ~50 widgets do this.
  Making this async means restructuring every widget's module-level
  config construction into an async init step — a widget-authoring
  contract change, not a same-session fix.
- `lib/storageService.js` (`loadLayout()`) and `lib/themeService.js`
  (`reload()`) — both already do the async read as the primary path
  (`_primeLayoutCache()` / the async branch of `reload()`), started from
  `init()`. The sync call is only a one-time fallback for the rare case
  where a widget's position or theme getter — a plain synchronous
  property read, since GNOME Shell actor allocation can't await — is hit
  before that priming read resolves. After the first read, results are
  cached and no further disk IO happens at all, sync or async.

None of these three can drop the sync fallback without either breaking
widget construction (top-level config reads) or turning a synchronous
getter into something that can return before its data exists (widget
position/theme reads during actor allocation). Both are structural to how
GNOME Shell extensions build actors, not implementation oversights in
this codebase.

**For the reviewer:** if `EGO-X-004` is a hard blocker regardless of the
above, the fix is a genuine architecture change — an async widget-init
contract for all bundled widgets plus deferred/async actor allocation —
tracked as future work, not something to paper over with a suppression
comment.

**Not independently verified in a live GNOME Shell session** — no GJS
runtime in this sandbox, `node --check` (syntax only) plus a repo-wide
import-graph check were used instead. Before shipping, smoke test: adding
`xtile`/`geek-architect` to the desktop, the "Add child" button showing up
correctly on the parent (and not on its children), and dev-mode hot-reload
of both widgets after an on-disk edit.
