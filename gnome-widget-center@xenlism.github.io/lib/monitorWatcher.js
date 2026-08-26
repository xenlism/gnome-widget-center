import * as Main from "resource:///org/gnome/shell/ui/main.js";

export class MonitorWatcher {
    constructor() {
        this._signalId = null;
        this._callback = null;
    }
    watch(callback) {
        this.destroy();
        this._callback = callback;
        this._signalId = Main.layoutManager.connect("monitors-changed", () => {
            this._callback?.(this.getMonitors(), this.primaryIndex);
        });
    }
    getMonitors() {
        return Main.layoutManager.monitors.map((monitor, index) => ({
            index: index,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            scale: monitor.geometryScale ?? monitor["geometry-scale"] ?? 1,
            isPrimary: index === Main.layoutManager.primaryIndex
        }));
    }
    get primaryIndex() {
        return Main.layoutManager.primaryIndex;
    }
    destroy() {
        if (this._signalId != null) {
            Main.layoutManager.disconnect(this._signalId);
            this._signalId = null;
        }
        this._callback = null;
    }
}