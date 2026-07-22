// products/extension/lib/devWatcher.js
//
// Task 08 — file-change watcher for hot-reload dev mode. Only active while
// the `dev-mode` GSettings key (extension/schemas/*.gschema.xml) is true —
// wired up by extension.js, which starts/stops this per onChanged('dev-mode', ...).
//
// Watches each currently-loaded widget's own folder (non-recursive:
// `Gio.File.monitor_directory()` only reports changes to files DIRECTLY
// inside that folder, which is exactly `widget.js`/`stylesheet.css`/etc
// per development/docs/WIDGET_API.md §1's flat per-widget folder layout — no widget is
// expected to have its own subfolders of source files).
//
// Debounces per-widget (not globally) so saving several files close
// together for widget A doesn't also trigger a reload of unrelated
// widget B, and so a single widget's editor "save" (which can fire
// multiple change events for one file) only reloads once.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const DEBOUNCE_MS = 500;

export class DevWatcher {
    /**
     * @param {function(string):void} onReload - called with a widgetId
     *   ~500ms after its folder settles (debounced). The caller
     *   (extension.js) is responsible for actually invoking
     *   WidgetLoader.reloadWidget() and re-placing the actor in the
     *   Widget Layer — this class only detects "something changed".
     * @param {object} [logger] - optional {log,warn,error} - defaults to console
     */
    constructor(onReload, logger = console) {
        this._onReload = onReload;
        this._logger = logger;
        /** @private {Map<string, {monitor: Gio.FileMonitor, signalId: number, timeoutId: number|null}>} */
        this._watched = new Map();
        this._active = false;
    }

    /** @returns {boolean} whether the watcher is currently running */
    get isActive() {
        return this._active;
    }

    /**
     * @method start
     * @description Turns dev-mode watching on and starts watching every
     * widget in the given list. Safe to call when already active (no-op).
     * @param {Array<{id:string, path:string}>} widgets - typically
     *   `WidgetLoader.instances` at the moment dev-mode is switched on.
     */
    start(widgets = []) {
        if (this._active) return;
        this._active = true;

        for (const {id, path} of widgets)
            this.watchWidget(id, path);

        this._logger.log?.(`[dev-watcher] dev-mode ON — watching ${this._watched.size} widget folder(s)`);
    }

    /**
     * @method watchWidget
     * @description Starts watching a single widget's folder. Called by
     * start() for every already-loaded widget, and again by extension.js
     * whenever a NEW widget gets loaded while dev-mode is already on (e.g.
     * re-enabled via the Control Center) so it isn't missed until the next
     * full restart. No-op if dev-mode isn't active or this widget is
     * already being watched.
     * @param {string} widgetId
     * @param {string} path - the widget's own folder on disk
     */
    watchWidget(widgetId, path) {
        if (!this._active || this._watched.has(widgetId))
            return;

        const dir = Gio.File.new_for_path(path);
        let monitor;
        try {
            monitor = dir.monitor_directory(Gio.FileMonitorFlags.NONE, null);
        } catch (e) {
            this._logger.warn?.(`[dev-watcher] could not watch "${widgetId}" (${path}): ${e.message}`);
            return;
        }

        const entry = {monitor, signalId: 0, timeoutId: null};
        entry.signalId = monitor.connect('changed', () => {
            if (entry.timeoutId != null)
                GLib.source_remove(entry.timeoutId);

            entry.timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
                entry.timeoutId = null;
                this._onReload?.(widgetId);
                return GLib.SOURCE_REMOVE;
            });
        });

        this._watched.set(widgetId, entry);
    }

    /**
     * @method unwatchWidget
     * @description Stops watching a single widget (e.g. it was disabled via
     * the Control Center while dev-mode stayed on) - cancels any pending
     * debounced reload for it too. Safe to call for an id that isn't
     * currently watched (no-op).
     * @param {string} widgetId
     */
    unwatchWidget(widgetId) {
        const entry = this._watched.get(widgetId);
        if (!entry) return;

        if (entry.timeoutId != null)
            GLib.source_remove(entry.timeoutId);
        entry.monitor.disconnect(entry.signalId);
        entry.monitor.cancel();
        this._watched.delete(widgetId);
    }

    /**
     * @method stop
     * @description Turns dev-mode watching off: cancels every file monitor
     * and any pending debounced reload, per acceptance criteria ("ปิด
     * dev-mode → file watcher หยุดทำงาน ไม่กิน resource เปล่า ๆ") — this
     * must leave zero GFileMonitors / GLib timeouts running in production.
     * Safe to call when already stopped (no-op).
     */
    stop() {
        if (!this._active) return;

        for (const widgetId of Array.from(this._watched.keys()))
            this.unwatchWidget(widgetId);

        this._active = false;
        this._logger.log?.('[dev-watcher] dev-mode OFF — file watchers stopped');
    }
}
