import Clutter from "gi://Clutter";

import St from "gi://St";

import GLib from "gi://GLib";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { SnapManager } from "../snapManager.js";

import { GuideRenderer } from "./guideRenderer.js";

const DRAG_OPACITY = 160;

const NORMAL_OPACITY = 255;

const DROP_ANIMATION_MS = 120;

export class EditModeDragController {
    constructor(widgetLayer, storageService, layoutEngine, editMode, logger = null, settings = null) {
        this._layer = widgetLayer;
        this._storage = storageService;
        this._layout = layoutEngine;
        this._editMode = editMode;
        this._logger = logger ?? {
            debug() {},
            warn() {},
            error() {}
        };
        this._settings = settings;
        this._snapManager = new SnapManager(layoutEngine, this._readSnapOptions());
        this._guideRenderer = new GuideRenderer(this._readGuideColor());
        this._settingsChangedIds = [];
        this._wireSettingsLiveUpdates();
        this._tracked = new Map;
        this._drag = null;
        this._getOthersOnMonitor = null;
        this._disposed = false;
        this._latestX = 0;
        this._latestY = 0;
        this._frameScheduled = false;
        this._motionGeneration = 0;
    }
    _readSnapOptions() {
        const s = this._settings;
        if (!s?.isReady) return {};
        return {
            enabled: s.getGlobalValue("snap-enabled") ?? true,
            distance: s.getGlobalValue("snap-distance") ?? 16,
            gridSnapEnabled: s.getGlobalValue("grid-snap-enabled") ?? false,
            gridSize: s.getGlobalValue("grid-size") ?? 16
        };
    }
    _readGuideColor() {
        const s = this._settings;
        if (!s?.isReady) return undefined;
        return s.getGlobalValue("guide-color") || undefined;
    }
    _wireSettingsLiveUpdates() {
        const s = this._settings;
        if (!s?.isReady) return;
        this._settingsChangedIds.push(s.onChanged("snap-enabled", v => this._snapManager.setEnabled(v ?? true)), s.onChanged("snap-distance", v => this._snapManager.setDistance(v ?? 16)), s.onChanged("grid-snap-enabled", v => this._snapManager.setGridSnapEnabled(v ?? false)), s.onChanged("grid-size", v => this._snapManager.setGridSize(v ?? 16)), s.onChanged("guide-color", v => this._guideRenderer.setColor(v)));
    }
    setOthersProvider(provider) {
        this._getOthersOnMonitor = provider;
    }
    attach(widgetId, actor, monitorIndex = 0) {
        if (this._tracked.has(widgetId)) this.detach(widgetId);
        this._tracked.set(widgetId, {
            actor: actor,
            monitorIndex: monitorIndex,
            backActor: null,
            dragHandle: null,
            dragPressId: null
        });
    }
    armDragHandle(widgetId, backActor, dragHandle) {
        const entry = this._tracked.get(widgetId);
        if (!entry || entry.dragHandle) return;
        entry.backActor = backActor;
        entry.dragHandle = dragHandle;
        const pressId = dragHandle.connect("button-press-event", (_actor, event) => {
            if (this._drag || this._disposed) return Clutter.EVENT_PROPAGATE;
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (!this._editMode.isEditing(widgetId)) return Clutter.EVENT_PROPAGATE;
            const {actor: actor, monitorIndex: monitorIndex} = entry;
            const [stageX, stageY] = global.get_pointer();
            const [startX, startY] = actor.get_position();
            const [width, height] = actor.get_size();
            const grabOffsetX = stageX - startX;
            const grabOffsetY = stageY - startY;
            const parent = actor.get_parent();
            parent?.set_child_above_sibling(actor, null);
            parent?.set_child_above_sibling(backActor, null);
            const placeholder = this._buildPlaceholder(width, height);
            if (!parent?.get_stage?.() || actor.get_parent() !== parent) {
                placeholder.destroy();
                return Clutter.EVENT_STOP;
            }
            parent.insert_child_below(placeholder, actor);
            placeholder.set_position(startX, startY);
            this._editMode.enterDragging(widgetId);
            this._drag = {
                widgetId: widgetId,
                actor: actor,
                backActor: backActor,
                monitorIndex: monitorIndex,
                width: width,
                height: height,
                grabOffsetX: grabOffsetX,
                grabOffsetY: grabOffsetY,
                placeholder: placeholder,
                placeholderInvalid: false,
                motionId: global.stage.connect("motion-event", ev => this._onMotion(ev)),
                releaseId: global.stage.connect("button-release-event", ev => this._onRelease(ev))
            };
            backActor.set_opacity(DRAG_OPACITY);
            this._logger.debug("edit-drag", `drag started ("${widgetId}")`);
            return Clutter.EVENT_STOP;
        });
        entry.dragPressId = pressId;
    }
    _onMotion(event) {
        if (!this._drag || this._disposed) return Clutter.EVENT_PROPAGATE;
        [this._latestX, this._latestY] = global.get_pointer();
        if (this._frameScheduled) return Clutter.EVENT_STOP;
        this._frameScheduled = true;
        const generation = ++this._motionGeneration;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (generation !== this._motionGeneration) {
                this._frameScheduled = false;
                return GLib.SOURCE_REMOVE;
            }
            this._frameScheduled = false;
            if (this._disposed || !this._drag) return GLib.SOURCE_REMOVE;
            this._processMotion(this._latestX, this._latestY);
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_STOP;
    }
    _othersFor(drag) {
        const monitorIndex = drag.monitorIndex ?? 0;
        return this._getOthersOnMonitor?.(monitorIndex, drag.widgetId) ?? [];
    }
    _processMotion(stageX, stageY) {
        try {
            const rawX = stageX - this._drag.grabOffsetX;
            const rawY = stageY - this._drag.grabOffsetY;
            const monitorIndex = this._drag.monitorIndex ?? 0;
            const bounds = this._monitorBoundsFor(monitorIndex);
            const others = this._othersFor(this._drag);
            const snapResult = this._snapManager.computeSnap({
                x: rawX,
                y: rawY,
                width: this._drag.width,
                height: this._drag.height
            }, others, bounds);
            const locked = this._layout.clampToBounds(snapResult.x, snapResult.y, this._drag.width, this._drag.height, bounds);
            this._layer.setWidgetPosition(this._drag.widgetId, locked.x, locked.y);
            this._drag.backActor.set_position(locked.x, locked.y);
            const container = this._layer.getContainer(monitorIndex);
            if (container && snapResult.guides?.length > 0) {
                this._guideRenderer.render(snapResult.guides, container);
            }
            const target = this._layout.findFreePosition(locked.x, locked.y, this._drag.width, this._drag.height, bounds, others, this._drag.widgetId);
            this._drag.placeholder.set_position(target.x, target.y);
            if (this._drag.placeholderInvalid !== target.collided) {
                this._drag.placeholderInvalid = target.collided;
                if (target.collided) {
                    this._drag.placeholder.add_style_class_name("widget-edit-mode-placeholder-invalid");
                    this._drag.placeholder.remove_style_class_name("widget-edit-mode-placeholder-valid");
                } else {
                    this._drag.placeholder.add_style_class_name("widget-edit-mode-placeholder-valid");
                    this._drag.placeholder.remove_style_class_name("widget-edit-mode-placeholder-invalid");
                }
            }
        } catch (e) {
            this._logger.error("edit-drag", "Motion processing failed", e);
        }
    }
    _onRelease(event) {
        if (!this._drag || this._disposed) return Clutter.EVENT_PROPAGATE;
        this._guideRenderer.clear();
        const {widgetId: widgetId, actor: actor, backActor: backActor, monitorIndex: monitorIndex, motionId: motionId, releaseId: releaseId, placeholder: placeholder} = this._drag;
        this._motionGeneration++;
        this._frameScheduled = false;
        try {
            global.stage.disconnect(motionId);
        } catch (e) {}
        try {
            global.stage.disconnect(releaseId);
        } catch (e) {}
        const [targetX, targetY] = placeholder.get_position();
        actor.remove_all_transitions();
        backActor.remove_all_transitions();
        let saved = true;
        try {
            this._storage.updateWidgetPosition(widgetId, targetX, targetY, monitorIndex);
        } catch (e) {
            saved = false;
            this._logger.error("edit-drag", `Failed to save position for ${widgetId}`, e);
        }
        if (!saved) {
            backActor.set_opacity(NORMAL_OPACITY);
            if (placeholder) {
                const p = placeholder.get_parent();
                if (p) p.remove_child(placeholder);
                try {
                    placeholder.destroy();
                } catch (_) {}
            }
            this._editMode.exitDragging(widgetId);
            this._drag = null;
            return Clutter.EVENT_STOP;
        }
        actor.ease({
            x: targetX,
            y: targetY,
            duration: DROP_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        backActor.ease({
            x: targetX,
            y: targetY,
            duration: DROP_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD
        });
        backActor.set_opacity(NORMAL_OPACITY);
        if (placeholder) {
            const parent = placeholder.get_parent();
            if (parent) parent.remove_child(placeholder);
            try {
                placeholder.destroy();
            } catch (_) {}
        }
        this._editMode.exitDragging(widgetId);
        this._drag = null;
        this._logger.debug("edit-drag", `drag released ("${widgetId}")`);
        return Clutter.EVENT_STOP;
    }
    _monitorBoundsFor(monitorIndex) {
        const container = this._layer.getContainer(monitorIndex);
        if (container && container.get_parent()) {
            const [width, height] = container.get_size();
            if (width > 0 && height > 0) return {
                width: width,
                height: height
            };
        }
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (monitor) {
            return {
                width: monitor.width,
                height: monitor.height
            };
        }
        return {
            width: global.stage.width,
            height: global.stage.height
        };
    }
    _buildPlaceholder(width, height) {
        return new St.Widget({
            style_class: "widget-edit-mode-placeholder-valid",
            width: width,
            height: height,
            reactive: false
        });
    }
    detach(widgetId) {
        const entry = this._tracked.get(widgetId);
        if (!entry) return;
        if (this._drag?.widgetId === widgetId) {
            this._drag.actor?.remove_all_transitions();
            this._drag.backActor?.remove_all_transitions();
            try {
                global.stage.disconnect(this._drag.motionId);
            } catch (e) {}
            try {
                global.stage.disconnect(this._drag.releaseId);
            } catch (e) {}
            if (this._drag.placeholder) {
                const parent = this._drag.placeholder.get_parent();
                if (parent) parent.remove_child(this._drag.placeholder);
                try {
                    this._drag.placeholder.destroy();
                } catch (_) {}
            }
            this._guideRenderer.clear();
            this._editMode.exitDragging(widgetId);
            this._drag = null;
        }
        if (entry.dragHandle && entry.dragPressId != null) {
            try {
                entry.dragHandle.disconnect(entry.dragPressId);
            } catch (e) {}
        }
        this._tracked.delete(widgetId);
    }
    destroy() {
        if (this._disposed) return;
        this._disposed = true;
        this._motionGeneration++;
        this._frameScheduled = false;
        if (this._drag) {
            this._drag.actor?.remove_all_transitions();
            this._drag.backActor?.remove_all_transitions();
        }
        for (const widgetId of Array.from(this._tracked.keys())) this.detach(widgetId);
        this._guideRenderer.destroy();
        this._snapManager.destroy?.();
        for (const id of this._settingsChangedIds) this._settings?.disconnect(id);
        this._settingsChangedIds = [];
    }
}
