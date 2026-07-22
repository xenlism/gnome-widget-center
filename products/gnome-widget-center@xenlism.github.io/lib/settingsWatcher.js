// products/extension/lib/settingsWatcher.js
//
// Cross-process live update — closes the gap prefs.js's header comment
// (task 05) documents as a known limitation: a setting changed through the
// Control Center's auto-generated (settingsSchemaUI.js) or hand-written
// (widget's own prefs.js) settings page is written straight to
// widgets/<id>.json — but from the PREFS process, a completely separate
// GJS runtime from extension.js's Shell process (see
// development/docs/WIDGET_API.md §4: prefs.js must never import St/Clutter/Meta/Shell
// precisely because it doesn't run inside the Shell). widgetSettings.js's
// module-level `_pending`/`_liveTargets` maps only exist per-runtime, so
// the already-running widget instance in the Shell process has no way to
// find out its settings file changed underneath it — until now.
//
// SettingsWatcher watches ONE widget's settings file for changes made by
// ANY other process (Gio.FileMonitor works across processes because it
// watches the inode/path, not anything in-process) and, once something
// settles, hands off to WidgetSettings.reloadFromDisk() to merge the new
// data into the SAME live proxy object a widget's constructor already
// captured as `api.settings` — no swap, no widget reload, no shell
// restart. See widgetSettings.js's reloadFromDisk() doc comment for
// exactly how that merge works and why it can never re-trigger its own
// debounced save (which would otherwise have the two processes writing
// the file at each other in a loop).
//
// Deliberately file-based (Gio.FileMonitor), not DBus/GSettings: per-widget
// settings are plain JSON files by design (development/docs/SETTINGS_SPEC.md — no
// system-wide schema compile per widget), so there's no GSettings key to
// watch the way settingsService.js's onChanged() does for HOST-level
// settings (task 05's disabled-widgets/dev-mode). A file monitor is the
// natural equivalent for a plain-file store, and Gio is available in both
// processes already (StorageService itself is plain Gio/GLib file I/O -
// see prefs.js's comment on reusing it directly).
//
// Owned by WidgetLoader (one watcher instance per loader, one Gio.FileMonitor
// per currently-loaded widget) - see widgetLoader.js's _settingsWatcher
// wiring in loadOne()/_unloadOneInternal().

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

// GIO can fire multiple CHANGED events for one logical write (e.g. our own
// StorageService.saveWidgetSettings()'s replace_contents() doing an
// atomic temp-file-then-rename under the hood, or an editor doing
// write+chmod if someone hand-edits the JSON) before settling. This is
// the read-side mirror of widgetSettings.js's own DEBOUNCE_MS on the
// write side. Gio.FileMonitorEvent.CHANGES_DONE_HINT already coalesces
// most of this at the platform level, but it isn't guaranteed on every
// backend/filesystem, so this debounce is a portable belt-and-braces
// layer that costs nothing when CHANGES_DONE_HINT alone would've been
// enough.
const DEBOUNCE_MS = 150;

// Events that plausibly mean "the file's content may be different now".
// Metadata-only events (e.g. ATTRIBUTE_CHANGED from an atime bump caused
// by something else merely reading the file) are deliberately excluded so
// they don't trigger a needless disk re-read + diff on every access.
const RELEVANT_EVENTS = new Set([
    Gio.FileMonitorEvent.CHANGED,
    Gio.FileMonitorEvent.CHANGES_DONE_HINT,
    Gio.FileMonitorEvent.CREATED,
    Gio.FileMonitorEvent.RENAMED,
    Gio.FileMonitorEvent.MOVED_IN,
]);

export class SettingsWatcher {
    /**
     * @param {StorageService} storageService - only used to resolve the
     *   same widgets/<id>.json path StorageService itself reads/writes
     *   (via getWidgetSettingsPath()), so this class never has to know
     *   the on-disk layout independently.
     */
    constructor(storageService) {
        this._storageService = storageService;
        this._watches = new Map(); // widgetId -> {monitor, handlerId, debounceId}
    }

    /**
     * @method watch
     * @description Starts watching one widget's settings file for changes
     * made by another process. Safe to call more than once for the same
     * widgetId — any previous watch is torn down first, so there's never
     * more than one active Gio.FileMonitor per widget. Safe to call even
     * if the file doesn't exist on disk yet (a brand-new widget whose
     * defaults haven't been written) — Gio.FileMonitor still fires once
     * the file is CREATED.
     * @param {string} widgetId
     * @param {function():void} onExternalChange - called (already
     *   debounced) whenever the file settles after changing. Deliberately
     *   receives no data itself — callers pull fresh values via
     *   WidgetSettings.reloadFromDisk(), which is also the thing that
     *   decides whether anything actually changed (an event firing is
     *   NOT the same as content differing — see its doc comment) - this
     *   keeps that "what changed" logic in one single place.
     */
    watch(widgetId, onExternalChange) {
        this.unwatch(widgetId);

        const path = this._storageService.getWidgetSettingsPath(widgetId);
        const file = Gio.File.new_for_path(path);

        let monitor;
        try {
            monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            logError(e, `[settings-watcher] could not watch settings file for "${widgetId}"`);
            return;
        }

        const state = {monitor, handlerId: null, debounceId: null};

        state.handlerId = monitor.connect('changed', (_monitor, _file, _otherFile, eventType) => {
            if (!RELEVANT_EVENTS.has(eventType))
                return;

            if (state.debounceId)
                GLib.source_remove(state.debounceId);

            state.debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                state.debounceId = null;
                onExternalChange();
                return GLib.SOURCE_REMOVE;
            });
        });

        this._watches.set(widgetId, state);
    }

    /**
     * @method unwatch
     * @description Stops watching one widget's settings file and releases
     * its Gio.FileMonitor. Safe to call for a widgetId that isn't
     * currently watched (no-op) — same defensive contract as
     * WidgetLoader.unloadOne() for an id that isn't loaded.
     * @param {string} widgetId
     */
    unwatch(widgetId) {
        const state = this._watches.get(widgetId);
        if (!state)
            return;

        if (state.debounceId)
            GLib.source_remove(state.debounceId);
        state.monitor.disconnect(state.handlerId);
        state.monitor.cancel();

        this._watches.delete(widgetId);
    }

    /**
     * @method unwatchAll
     * @description Tears down every active watch — call from
     * WidgetLoader.unloadAll()/extension.js's disable() teardown path so
     * no Gio.FileMonitor outlives the extension being disabled (matching
     * the same "everything a signal/timer connects to must be released"
     * rule development/docs/WIDGET_API.md §3 requires of widget authors — the host
     * holds itself to it too).
     */
    unwatchAll() {
        for (const widgetId of Array.from(this._watches.keys()))
            this.unwatch(widgetId);
    }
}
