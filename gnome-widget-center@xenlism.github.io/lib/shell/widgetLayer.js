import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

export class WidgetLayer {
    constructor(storageService) {
        this._storageService = storageService;
        this._monitorContainers = new Map;
        this._monitors = [];
        this._primaryIndex = 0;
        this._activeWidgets = new Map;
        this._isInitialized = false;
    }
    init(monitors = null, primaryIndex = null) {
        if (this._isInitialized) return;
        this._monitors = monitors ?? this._readMonitorsFallback();
        this._primaryIndex = primaryIndex ?? Main.layoutManager.primaryIndex ?? 0;
        for (const monitor of this._monitors) this._createContainer(monitor);
        this._isInitialized = true;
    }
    _readMonitorsFallback() {
        return Main.layoutManager.monitors.map((monitor, index) => ({
            index: index,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
            scale: monitor.geometryScale ?? 1,
            isPrimary: index === Main.layoutManager.primaryIndex
        }));
    }
    _createContainer(monitor) {
        const container = new St.Widget({
            name: `widget-layer-container-monitor-${monitor.index}`,
            reactive: false
        });
        Main.layoutManager._backgroundGroup.add_child(container);
        container.set_position(monitor.x, monitor.y);
        container.set_size(monitor.width, monitor.height);
        this._monitorContainers.set(monitor.index, container);
    }
    addWidgetActor(widgetId, actor, position) {
        if (!this._isInitialized) {
            throw new Error("WidgetLayer.init() must be called before addWidgetActor()");
        }
        if (this._activeWidgets.has(widgetId)) {
            throw new Error(`Widget "${widgetId}" is already in the layer — call removeWidgetActor() first`);
        }
        const monitorIndex = this._resolveMonitorIndex(position?.monitorIndex);
        const container = this._monitorContainers.get(monitorIndex);
        const clamped = this._clampToMonitor(monitorIndex, position?.x ?? 0, position?.y ?? 0);
        actor.set_position(clamped.x, clamped.y);
        container.add_child(actor);
        this._activeWidgets.set(widgetId, {
            actor: actor,
            monitorIndex: monitorIndex
        });
    }
    removeWidgetActor(widgetId) {
        const entry = this._activeWidgets.get(widgetId);
        if (!entry) return;
        const container = this._monitorContainers.get(entry.monitorIndex);
        try {
            if (container && entry.actor.get_parent() === container) container.remove_child(entry.actor);
        } catch (e) {}
        this._activeWidgets.delete(widgetId);
    }
    setWidgetPosition(widgetId, x, y) {
        const entry = this._activeWidgets.get(widgetId);
        if (!entry) return;
        entry.actor.set_position(x, y);
    }
    getSavedPosition(widgetId, fallback) {
        const saved = this._storageService?.getWidgetPosition(widgetId);
        if (saved) return saved;
        return {
            x: fallback?.x ?? 0,
            y: fallback?.y ?? 0,
            monitorIndex: fallback?.monitorIndex ?? fallback?.monitor ?? 0
        };
    }
    reconcileMonitors(monitors, primaryIndex) {
        if (!this._isInitialized) return;
        const previousIndices = new Set(this._monitorContainers.keys());
        const nextIndices = new Set(monitors.map(m => m.index));
        this._monitors = monitors;
        this._primaryIndex = primaryIndex ?? 0;
        for (const monitor of monitors) {
            if (!this._monitorContainers.has(monitor.index)) {
                this._createContainer(monitor);
            } else {
                const container = this._monitorContainers.get(monitor.index);
                container.set_position(monitor.x, monitor.y);
                container.set_size(monitor.width, monitor.height);
            }
        }
        for (const [widgetId, entry] of this._activeWidgets) {
            if (nextIndices.has(entry.monitorIndex)) continue;
            const oldContainer = this._monitorContainers.get(entry.monitorIndex);
            if (oldContainer && entry.actor.get_parent() === oldContainer) oldContainer.remove_child(entry.actor);
            const newContainer = this._monitorContainers.get(this._primaryIndex);
            const clamped = this._clampToMonitor(this._primaryIndex, entry.actor.get_x(), entry.actor.get_y());
            entry.actor.set_position(clamped.x, clamped.y);
            newContainer.add_child(entry.actor);
            entry.monitorIndex = this._primaryIndex;
            this._storageService?.updateWidgetPosition(widgetId, clamped.x, clamped.y, this._primaryIndex);
        }
        for (const index of previousIndices) {
            if (nextIndices.has(index)) continue;
            const container = this._monitorContainers.get(index);
            container?.destroy();
            this._monitorContainers.delete(index);
        }
        for (const entry of this._activeWidgets.values()) {
            const clamped = this._clampToMonitor(entry.monitorIndex, entry.actor.get_x(), entry.actor.get_y());
            entry.actor.set_position(clamped.x, clamped.y);
        }
    }
    _resolveMonitorIndex(monitorIndex) {
        if (monitorIndex != null && this._monitorContainers.has(monitorIndex)) return monitorIndex;
        return this._primaryIndex;
    }
    _clampToMonitor(monitorIndex, x, y) {
        const monitor = this._monitors.find(m => m.index === monitorIndex);
        if (!monitor) return {
            x: x,
            y: y
        };
        return {
            x: Math.min(Math.max(x, 0), Math.max(monitor.width - 1, 0)),
            y: Math.min(Math.max(y, 0), Math.max(monitor.height - 1, 0))
        };
    }
    getMonitorIndexFor(widgetId) {
        return this._activeWidgets.get(widgetId)?.monitorIndex ?? this._primaryIndex;
    }
    getContainer(monitorIndex = null) {
        const index = monitorIndex ?? this._primaryIndex;
        return this._monitorContainers.get(index) ?? null;
    }
    destroy() {
        for (const container of this._monitorContainers.values()) container.destroy();
        this._monitorContainers.clear();
        this._activeWidgets.clear();
        this._monitors = [];
        this._isInitialized = false;
    }
}