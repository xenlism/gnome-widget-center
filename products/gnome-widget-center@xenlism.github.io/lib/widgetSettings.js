// products/extension/lib/widgetSettings.js
//
// Task 03 — per-widget JSON settings store. Wraps a plain object in a Proxy
// that auto-saves to ~/.config/gnome-widget-center/widgets/<widget-id>.json
// (via StorageService, task 03's file layer) every time a key is set,
// debounced ~300ms so several writes in a row (e.g. a prefs UI with
// multiple bound fields) only trigger one disk write. See
// development/docs/SETTINGS_SPEC.md for the on-disk format and why this is a plain
// JSON file rather than GSettings.
//
// Ordering constraint this file exists to solve:
//   `api.settings` must already be a live object BEFORE a widget's
//   constructor runs (per development/docs/WIDGET_API.md §3, widgets typically do
//   `this._settings = api.settings;` on the very first line) — but a
//   widget's own defaults come from `instance.getDefaultSettings()`, which
//   can only be called AFTER the instance exists.
//
//   Solution: WidgetSettings.load() returns a live proxy populated with
//   whatever is already on disk (no defaults applied yet — none are known
//   at this point). WidgetLoader then instantiates the widget, calls
//   instance.getDefaultSettings(), and passes the result to
//   WidgetSettings.applyDefaults() to backfill any missing keys — through
//   the SAME proxy object, so the widget's already-captured reference
//   stays valid, and the backfill itself goes through the normal
//   debounced-save path (this is what makes "delete the settings file,
//   reload the widget" recreate it from defaults within ~300ms, per task
//   03's acceptance criteria).

import GLib from 'gi://GLib';

const DEBOUNCE_MS = 300;
const CURRENT_SCHEMA_VERSION = 1;

// widgetId -> {timeoutId, flush()}. Module-level (not per-instance) so
// WidgetSettings.flush()/flushAll() can be called from extension.js
// disable() without needing to keep a separate reference to every proxy
// around — see flushAll() below.
const _pending = new Map();

// widgetId -> the plain `target` object backing that widget's live proxy
// (the one returned, wrapped, by load() below). Module-level for the same
// reason as `_pending`: reloadFromDisk() (cross-process live update, see
// settingsWatcher.js) needs to reach the SAME target object a widget's
// constructor already captured as `api.settings` — which only exists as a
// closure variable inside load() otherwise — without every caller having
// to thread a reference to it around. Populated by load(), cleared by
// release(). Only ever contains entries for widgets currently loaded IN
// THIS PROCESS — extension.js's Shell process and prefs.js's GTK process
// each have their own copy of this module (and therefore their own
// separate map), which is exactly what makes cross-process live update
// necessary in the first place (see settingsWatcher.js header comment).
const _liveTargets = new Map();

export class WidgetSettings {
    /**
     * @method load
     * @description Loads (or lazily creates) a widget's settings as a live,
     * auto-saving Proxy. Does NOT apply any defaults — call
     * applyDefaults() once the widget instance exists and
     * getDefaultSettings() can be called. Safe to call more than once for
     * the same widgetId (e.g. a future reload) — each call reads fresh
     * from disk and gets its own independent debounce timer keyed by
     * widgetId (the previous timer, if still pending, is cancelled first).
     * @param {string} widgetId
     * @param {StorageService} storageService - owns the actual file I/O
     *   and widgetId sanitization (path-traversal guard lives there, not
     *   duplicated here — see storageService.js `_sanitizeWidgetId()`).
     * @returns {Object} proxy — read/write exactly like a plain object.
     */
    static load(widgetId, storageService) {
        const raw = storageService.getWidgetSettings(widgetId) ?? {};
        const target = {_schemaVersion: CURRENT_SCHEMA_VERSION, ...raw};
        _liveTargets.set(widgetId, target);

        const scheduleSave = () => {
            const existing = _pending.get(widgetId);
            if (existing)
                GLib.source_remove(existing.timeoutId);

            const timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                _pending.delete(widgetId);
                storageService.saveWidgetSettings(widgetId, {...target});
                return GLib.SOURCE_REMOVE;
            });

            _pending.set(widgetId, {
                timeoutId,
                flush: () => {
                    GLib.source_remove(timeoutId);
                    _pending.delete(widgetId);
                    storageService.saveWidgetSettings(widgetId, {...target});
                },
            });
        };

        return new Proxy(target, {
            set(obj, prop, value) {
                obj[prop] = value;
                scheduleSave();
                return true;
            },
            deleteProperty(obj, prop) {
                if (prop in obj) {
                    delete obj[prop];
                    scheduleSave();
                }
                return true;
            },
        });
    }

    /**
     * @method applyDefaults
     * @description Fills in any keys present in `defaults` but missing from
     * an already-loaded settings proxy. Each missing key is set THROUGH
     * the proxy (not written directly to its target), so this goes through
     * the normal debounced-save path — a brand-new widget with no settings
     * file yet ends up with one on disk matching its declared defaults
     * within DEBOUNCE_MS. Existing keys (including ones a widget author
     * removed and thinks of as "reset to default" — that's not this
     * method's job) are left untouched.
     * @param {Object} settingsProxy - from WidgetSettings.load()
     * @param {Object} [defaults]
     */
    static applyDefaults(settingsProxy, defaults = {}) {
        for (const [key, value] of Object.entries(defaults)) {
            if (!(key in settingsProxy))
                settingsProxy[key] = value;
        }
    }

    /**
     * @method reloadFromDisk
     * @description Cross-process live update (see settingsWatcher.js): re-reads
     * widgetId's settings file from disk and merges it directly into the
     * SAME `target` object backing the live proxy a widget's constructor
     * already captured as `api.settings` — so an already-running widget
     * sees new values (e.g. changed via the Control Center's prefs page,
     * running in a separate process) without a reload/restart. Any code
     * that reads `this._settings.foo` fresh each time (a periodic update
     * loop, or a widget's own `onSettingsChanged()` hook — see
     * development/docs/WIDGET_API.md §3) reflects the change immediately.
     *
     * Writes go DIRECTLY onto `target`, bypassing the Proxy's `set` trap
     * entirely (see load() above) — so this can never re-trigger
     * WidgetSettings' own debounced save, which would otherwise have this
     * process and the one that made the original change keep re-writing
     * the same file at each other.
     *
     * No-op (returns false) if widgetId was never load()-ed in THIS
     * process — nothing here needs updating because no widget in this
     * process is holding a proxy for it.
     * @param {string} widgetId
     * @param {StorageService} storageService
     * @returns {boolean} whether anything in `target` actually changed —
     *   false also covers the common case of this event being an ECHO of
     *   this SAME process's own debounced save landing on disk a moment
     *   later, which callers should treat as nothing to react to.
     *   Comparison is shallow (`!==`), matching every other place in this
     *   codebase that treats widget settings as flat key/value data (see
     *   development/docs/SETTINGS_SPEC.md's example) — a widget author storing a
     *   nested object as one settings value should treat it as
     *   immutable/replace-whole-value for change detection to see it.
     */
    static reloadFromDisk(widgetId, storageService) {
        const target = _liveTargets.get(widgetId);
        if (!target)
            return false;

        const raw = storageService.getWidgetSettings(widgetId) ?? {};
        const next = {_schemaVersion: target._schemaVersion ?? CURRENT_SCHEMA_VERSION, ...raw};

        let changed = false;

        for (const key of Object.keys(target)) {
            if (!(key in next)) {
                delete target[key];
                changed = true;
            }
        }
        for (const [key, value] of Object.entries(next)) {
            if (target[key] !== value) {
                target[key] = value;
                changed = true;
            }
        }

        return changed;
    }

    /**
     * @method release
     * @description Drops widgetId's entry from the live-targets registry
     * reloadFromDisk() reads — call when a widget is unloaded (see
     * widgetLoader.js's _unloadOneInternal()) so a stray/late file-monitor
     * callback for a widget that's no longer running has nothing to write
     * into, and so the registry doesn't grow forever across repeated
     * enable/disable or hot-reload cycles. Does NOT flush or touch
     * `_pending` — that's flush()'s job and callers already call both
     * separately (see unloadOne()/unloadAll()). Safe to call for a
     * widgetId with no entry (no-op).
     * @param {string} widgetId
     */
    static release(widgetId) {
        _liveTargets.delete(widgetId);
    }

    /**
     * @method flush
     * @description Cancels any pending debounced save for widgetId and
     * writes immediately instead. No-op if nothing is pending.
     * @param {string} widgetId
     */
    static flush(widgetId) {
        _pending.get(widgetId)?.flush();
    }

    /**
     * @method flushAll
     * @description Flushes every widget with a pending debounced save —
     * call from WidgetLoader.unloadAll() (see widgetLoader.js) so a
     * settings change made just before the shell disables the extension
     * isn't silently dropped along with the cancelled GLib timeout.
     */
    static flushAll() {
        for (const widgetId of Array.from(_pending.keys()))
            WidgetSettings.flush(widgetId);
    }
}
