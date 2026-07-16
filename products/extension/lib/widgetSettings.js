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
