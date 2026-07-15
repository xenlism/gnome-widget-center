// extension/lib/monitorWatcher.js
//
// Task 07 — thin wrapper around `Main.layoutManager`'s monitor tracking.
// Does not touch WidgetLayer/widget actors directly — it only normalizes
// GNOME Shell's monitor list into plain objects and fires a callback
// whenever monitors are added/removed/reordered/resized, per
// tasks/07-multi-monitor-support.md step 1. WidgetLayer.reconcileMonitors()
// is the piece that reacts to that callback.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class MonitorWatcher {
    constructor() {
        /** @private {number|null} */
        this._signalId = null;
        /** @private {function(Array<object>, number):void|null} */
        this._callback = null;
    }

    /**
     * @method connect
     * @description Starts listening to `Main.layoutManager`'s
     * `monitors-changed` signal (fired on hotplug, resolution change, or
     * any layout change) and calls back with the fresh monitor list every
     * time. Safe to call more than once — a previous listener is
     * disconnected first.
     * @param {function(Array<object>, number):void} callback - called with
     *   (monitors, primaryIndex) once immediately isn't done here (call
     *   getMonitors()/primaryIndex yourself for the initial state) and
     *   again on every future change.
     */
    connect(callback) {
        this.destroy();
        this._callback = callback;
        this._signalId = Main.layoutManager.connect('monitors-changed', () => {
            this._callback?.(this.getMonitors(), this.primaryIndex);
        });
    }

    /**
     * @method getMonitors
     * @description Current monitor list, normalized to plain objects.
     * Index in this array IS the "monitorIndex" used everywhere else
     * (WidgetLayer, StorageService's layout.json, DragController) — it
     * matches `Main.layoutManager.monitors`'s own indexing, which is what
     * GNOME Shell itself uses for window/actor placement.
     * @returns {Array<{index:number, x:number, y:number, width:number,
     *   height:number, scale:number, isPrimary:boolean}>}
     */
    getMonitors() {
        return Main.layoutManager.monitors.map((monitor, index) => ({
            index,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            // Meta.Monitor/the layout manager's monitor struct exposes this
            // as `geometry-scale` (GObject property) → `geometryScale` in
            // GJS. Older/software-cursor setups may not expose it at all,
            // so fall back to 1 (no scaling) rather than throw.
            scale: monitor.geometryScale ?? monitor['geometry-scale'] ?? 1,
            isPrimary: index === Main.layoutManager.primaryIndex,
        }));
    }

    /**
     * @method get primaryIndex
     * @returns {number} index (into getMonitors()) of the primary monitor
     */
    get primaryIndex() {
        return Main.layoutManager.primaryIndex;
    }

    /**
     * @method destroy
     * @description Disconnects the signal handler, if any. Safe to call
     * multiple times / before connect() was ever called.
     */
    destroy() {
        if (this._signalId != null) {
            Main.layoutManager.disconnect(this._signalId);
            this._signalId = null;
        }
        this._callback = null;
    }
}
