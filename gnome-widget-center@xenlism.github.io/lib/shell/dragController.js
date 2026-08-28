import Clutter from "gi://Clutter";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { MonitorLockManager } from "../monitorLockManager.js";

export class DragController {
    constructor(widgetLayer, storageService, layoutEngine = null) {
        this._layer = widgetLayer;
        this._storage = storageService;
        // Optional: without a layoutEngine, this quick Super+drag only clamps
        // to monitor bounds (its original behavior). With one — wired up the
        // same way EditModeDragController is — it also respects
        // "prevent-widget-overlap" so a plain drag can't drop a widget on top
        // of another one, matching what Edit Mode already enforces.
        this._layout = layoutEngine;
        this._getOthersOnMonitor = null;
        this._tracked = new Map;
        this._drag = null;
    }
    setOthersProvider(provider) {
        this._getOthersOnMonitor = provider;
    }
    _monitorBoundsFor(monitorIndex) {
        const container = this._layer.getContainer?.(monitorIndex);
        if (container && container.get_parent()) {
            const [width, height] = container.get_size();
            if (width > 0 && height > 0) return { width, height };
        }
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (monitor) return { width: monitor.width, height: monitor.height };
        return { width: global.stage.width, height: global.stage.height };
    }
    attach(widgetId, actor, monitorIndex = 0) {
        if (this._tracked.has(widgetId)) return;
        actor.reactive = true;
        const pressId = actor.connect("button-press-event", (_actor, event) => {
            if (this._drag) return Clutter.EVENT_PROPAGATE;
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (!(event.get_state() & Clutter.ModifierType.MOD4_MASK)) return Clutter.EVENT_PROPAGATE;
            const [stageX, stageY] = event.get_coords();
            const [startX, startY] = actor.get_position();
            this._drag = {
                widgetId: widgetId,
                actor: actor,
                monitorIndex: monitorIndex,
                grabX: stageX,
                grabY: stageY,
                startX: startX,
                startY: startY,
                motionId: global.stage.connect("motion-event", (_s, ev) => this._onMotion(ev)),
                releaseId: global.stage.connect("button-release-event", (_s, ev) => this._onRelease(ev))
            };
            return Clutter.EVENT_STOP;
        });
        this._tracked.set(widgetId, {
            actor: actor,
            pressId: pressId,
            monitorIndex: monitorIndex
        });
    }
    _onMotion(event) {
        if (!this._drag) return Clutter.EVENT_PROPAGATE;
        const [stageX, stageY] = event.get_coords();
        const newX = this._drag.startX + (stageX - this._drag.grabX);
        const newY = this._drag.startY + (stageY - this._drag.grabY);
        const [width, height] = this._drag.actor.get_size();
        const locked = MonitorLockManager.clamp(this._drag.monitorIndex, newX, newY, width, height);
        if (!this._layout) {
            this._layer.setWidgetPosition(this._drag.widgetId, locked.x, locked.y);
            return Clutter.EVENT_STOP;
        }
        const bounds = this._monitorBoundsFor(this._drag.monitorIndex);
        const others = this._getOthersOnMonitor?.(this._drag.monitorIndex, this._drag.widgetId) ?? [];
        const target = this._layout.findFreePosition(locked.x, locked.y, width, height, bounds, others, this._drag.widgetId);
        this._layer.setWidgetPosition(this._drag.widgetId, target.x, target.y);
        return Clutter.EVENT_STOP;
    }
    _onRelease(event) {
        if (!this._drag) return Clutter.EVENT_PROPAGATE;
        const {widgetId: widgetId, actor: actor, monitorIndex: monitorIndex, motionId: motionId, releaseId: releaseId} = this._drag;
        global.stage.disconnect(motionId);
        global.stage.disconnect(releaseId);
        this._drag = null;
        const [x, y] = actor.get_position();
        this._storage.updateWidgetPosition(widgetId, x, y, monitorIndex);
        return Clutter.EVENT_STOP;
    }
    detach(widgetId) {
        const entry = this._tracked.get(widgetId);
        if (!entry) return;
        if (this._drag?.widgetId === widgetId) {
            global.stage.disconnect(this._drag.motionId);
            global.stage.disconnect(this._drag.releaseId);
            this._drag = null;
        }
        entry.actor.disconnect(entry.pressId);
        this._tracked.delete(widgetId);
    }
    destroy() {
        for (const widgetId of Array.from(this._tracked.keys())) this.detach(widgetId);
    }
}