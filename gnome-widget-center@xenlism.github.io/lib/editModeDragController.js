// products/extension/lib/editModeDragController.js
//
// Task 13 — Widget Drag & Drop. 
// 2026-08-02 — Final Production Pass.
// Added disposed flag for safe teardown and moved storage save before animation.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { SnapManager } from './snapManager.js';
import { GuideRenderer } from './guideRenderer.js';

const DRAG_OPACITY = 160;
const NORMAL_OPACITY = 255;
const DROP_ANIMATION_MS = 120;

export class EditModeDragController {
    constructor(widgetLayer, storageService, layoutEngine, editMode, logger = null) {
        this._layer = widgetLayer;
        this._storage = storageService;
        this._layout = layoutEngine;
        this._editMode = editMode;
        this._logger = logger ?? {debug() {}, warn() {}, error() {}};

        this._snapManager = new SnapManager(layoutEngine);
        this._guideRenderer = new GuideRenderer();

        this._tracked = new Map();
        this._drag = null;
        this._getOthersOnMonitor = null;
        this._disposed = false; // Lifecycle flag
        
        // Coalescing state
        this._latestX = 0;
        this._latestY = 0;
        this._frameScheduled = false;
        this._motionGeneration = 0; // Fix 3: Cancel pending frame
    }

    setOthersProvider(provider) {
        this._getOthersOnMonitor = provider;
    }

    attach(widgetId, actor, monitorIndex = 0) {
        // Fix 4: attach leak
        if (this._tracked.has(widgetId))
            this.detach(widgetId);

        this._tracked.set(widgetId, {
            actor, monitorIndex,
            backActor: null,
            dragHandle: null,
            dragPressId: null,
        });
    }

    armDragHandle(widgetId, backActor, dragHandle) {
        const entry = this._tracked.get(widgetId);
        if (!entry || entry.dragHandle) return;

        entry.backActor = backActor;
        entry.dragHandle = dragHandle;

        const pressId = dragHandle.connect('button-press-event', (_actor, event) => {
            if (this._drag || this._disposed) return Clutter.EVENT_PROPAGATE;
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (!this._editMode.isEditing(widgetId)) return Clutter.EVENT_PROPAGATE;

            const {actor, monitorIndex} = entry;
            const [stageX, stageY] = global.get_pointer();
            const [startX, startY] = actor.get_position();
            const [width, height] = actor.get_size();

            const grabOffsetX = stageX - startX;
            const grabOffsetY = stageY - startY;

            const parent = actor.get_parent();
            parent?.set_child_above_sibling(actor, null);
            parent?.set_child_above_sibling(backActor, null);

            const placeholder = this._buildPlaceholder(width, height);
            parent?.insert_child_below(placeholder, actor);
            placeholder.set_position(startX, startY);

            this._editMode.enterDragging(widgetId);

            this._drag = {
                widgetId, actor, backActor, monitorIndex, width, height,
                grabOffsetX, grabOffsetY,
                placeholder,
                placeholderInvalid: false,
                motionId: global.stage.connect('motion-event', ev => this._onMotion(ev)),
                releaseId: global.stage.connect('button-release-event', ev => this._onRelease(ev)),
            };

            backActor.set_opacity(DRAG_OPACITY);
            this._logger.debug('edit-drag', `drag started ("${widgetId}")`);

            return Clutter.EVENT_STOP;
        });

        entry.dragPressId = pressId;
    }

    _onMotion(event) {
        if (!this._drag || this._disposed) return Clutter.EVENT_PROPAGATE;

        // 1. Always cache the latest pointer coordinates (Fix: Use global.get_pointer())
        [this._latestX, this._latestY] = global.get_pointer();

        // 2. If a frame is already scheduled, do nothing (coalesce)
        if (this._frameScheduled) return Clutter.EVENT_STOP;

        // 3. Schedule a single process before the next redraw
        this._frameScheduled = true;
        
        // Fix 3: Cancel pending frame
        const generation = ++this._motionGeneration;
    GLib.idle_add(
    GLib.PRIORITY_DEFAULT_IDLE,
    () => {
        if (generation !== this._motionGeneration) {
            this._frameScheduled = false;
            return GLib.SOURCE_REMOVE;
        }

        this._frameScheduled = false;

        if (this._disposed || !this._drag)
            return GLib.SOURCE_REMOVE;

        this._processMotion(
            this._latestX,
            this._latestY
        );

        return GLib.SOURCE_REMOVE;
    }
);

        return Clutter.EVENT_STOP;
    }

    _othersFor(drag) {
        // Fix 8: Monitor stale
    const monitorIndex = drag.monitorIndex ?? 0;
return this._getOthersOnMonitor?.(monitorIndex, drag.widgetId) ?? [];
    }

    _processMotion(stageX, stageY) {
        try {
            const rawX = stageX - this._drag.grabOffsetX;
            const rawY = stageY - this._drag.grabOffsetY;

            // Fix 8: Monitor stale
            const monitorIndex = this._drag.monitorIndex ?? 0;
            const bounds = this._monitorBoundsFor(monitorIndex);
            const others = this._othersFor(this._drag);

            // 1. Compute magnetic snap
            const snapResult = this._snapManager.computeSnap(
                { x: rawX, y: rawY, width: this._drag.width, height: this._drag.height },
                others,
                bounds
            );

            // 2. Clamp to bounds after snapping
            const locked = this._layout.clampToBounds(
                snapResult.x, snapResult.y, this._drag.width, this._drag.height, bounds
            );

            // 3. Move actors to snapped position
            this._layer.setWidgetPosition(this._drag.widgetId, locked.x, locked.y);
            this._drag.backActor.set_position(locked.x, locked.y);

            // 4. Render guide lines (uses pool internally)
            // Fix 9: Parent destroyed
            const container = this._layer.getContainer(monitorIndex);

if (container && snapResult.guides?.length > 0) {
    this._guideRenderer.render(
        snapResult.guides,
        container
    );
}


            // 5. Calculate drop placeholder (collision avoidance)
            const target = this._layout.findFreePosition(
                locked.x, locked.y, this._drag.width, this._drag.height,
                bounds, others, this._drag.widgetId);

            this._drag.placeholder.set_position(target.x, target.y);
            
            // 6. Optimize CSS state switching (add/remove instead of set)
            if (this._drag.placeholderInvalid !== target.collided) {
                this._drag.placeholderInvalid = target.collided;
                if (target.collided) {
                    this._drag.placeholder.add_style_class_name('widget-edit-mode-placeholder-invalid');
                    this._drag.placeholder.remove_style_class_name('widget-edit-mode-placeholder-valid');
                } else {
                    this._drag.placeholder.add_style_class_name('widget-edit-mode-placeholder-valid');
                    this._drag.placeholder.remove_style_class_name('widget-edit-mode-placeholder-invalid');
                }
            }
        } catch (e) {
            this._logger.error('edit-drag', 'Motion processing failed', e);
        }
    }

    _onRelease(event) {
        if (!this._drag || this._disposed) return Clutter.EVENT_PROPAGATE;

        this._guideRenderer.clear();

        const {widgetId, actor, backActor, monitorIndex, motionId, releaseId, placeholder} = this._drag;
        
        // Fix 3: Cancel pending frame
        this._motionGeneration++;
        this._frameScheduled = false;

        // Safe disconnect
        try { global.stage.disconnect(motionId); } catch (e) {}
        try { global.stage.disconnect(releaseId); } catch (e) {}

        // Read directly from the placeholder position to guarantee landing exactly on the green box
        const [targetX, targetY] = placeholder.get_position();

        // Fix 5: Animation cleanup
        actor.remove_all_transitions();
        backActor.remove_all_transitions();

        // OPTIMIZATION: Save to disk BEFORE animation starts.
        // Fix 6: Save failure
        let saved = true;
        try {
            this._storage.updateWidgetPosition(widgetId, targetX, targetY, monitorIndex);
        } catch (e) {
            saved = false;
            this._logger.error('edit-drag', `Failed to save position for ${widgetId}`, e);
        }

        if (!saved) {
            backActor.set_opacity(NORMAL_OPACITY);

            if (placeholder) {
                const p = placeholder.get_parent();
                if (p) p.remove_child(placeholder);
                
                // Fix 7: Placeholder destroy
                try {
                    placeholder.destroy();
                } catch (_) {}
            }

            this._editMode.exitDragging(widgetId);
            this._drag = null;

            return Clutter.EVENT_STOP;
        }

        actor.ease({
            x: targetX, y: targetY,
            duration: DROP_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        
        backActor.ease({
            x: targetX, y: targetY,
            duration: DROP_ANIMATION_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        backActor.set_opacity(NORMAL_OPACITY);

        // Clean up placeholder safely
        // Fix 7: Placeholder destroy
        if (placeholder) {
            const parent = placeholder.get_parent();
            if (parent) parent.remove_child(placeholder);
            try {
                placeholder.destroy();
            } catch (_) {}
        }
        
        this._editMode.exitDragging(widgetId);
        this._drag = null;
        this._logger.debug('edit-drag', `drag released ("${widgetId}")`);

        return Clutter.EVENT_STOP;
    }

    _monitorBoundsFor(monitorIndex) {
        const container = this._layer.getContainer(monitorIndex);
        if (container && container.get_parent()) {
            const [width, height] = container.get_size();
            if (width > 0 && height > 0) return {width, height};
        }
        
        const monitor = Main.layoutManager.monitors[monitorIndex];
        if (monitor) {
            return {width: monitor.width, height: monitor.height};
        }
        
        return {width: global.stage.width, height: global.stage.height};
    }

    _buildPlaceholder(width, height) {
        return new St.Widget({
            style_class: 'widget-edit-mode-placeholder-valid',
            width, height,
            reactive: false,
        });
    }

    detach(widgetId) {
        const entry = this._tracked.get(widgetId);
        if (!entry) return;

        if (this._drag?.widgetId === widgetId) {
            // Fix 10: remove transitions in destroy
            this._drag.actor?.remove_all_transitions();
            this._drag.backActor?.remove_all_transitions();

            try { global.stage.disconnect(this._drag.motionId); } catch (e) {}
            try { global.stage.disconnect(this._drag.releaseId); } catch (e) {}
            
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
            } catch (e) {
                // Actor may already be destroyed
            }
        }
        this._tracked.delete(widgetId);
    }

    destroy() {
        // Fix 2: destroy() must be idempotent
        if (this._disposed)
            return;

        this._disposed = true;
        
        // Fix 3: Cancel pending frame
        this._motionGeneration++;
        this._frameScheduled = false;

        // Fix 10: remove transitions in destroy
        if (this._drag) {
            this._drag.actor?.remove_all_transitions();
            this._drag.backActor?.remove_all_transitions();
        }
        
        for (const widgetId of Array.from(this._tracked.keys()))
            this.detach(widgetId);
            
        this._guideRenderer.destroy();
        this._snapManager.destroy?.();
    }
}
