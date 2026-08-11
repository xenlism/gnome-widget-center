import Clutter from "gi://Clutter";

import { MonitorLockManager } from "./monitorLockManager.js";

export class DragController {
    constructor(widgetLayer, storageService) {
        this._layer = widgetLayer;
        this._storage = storageService;
        this._tracked = new Map;
        this._drag = null;
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
        this._layer.setWidgetPosition(this._drag.widgetId, locked.x, locked.y);
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