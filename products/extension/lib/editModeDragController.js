// products/extension/lib/editModeDragController.js
//
// Task 13 — Widget Drag & Drop. Distinct from task 04's DragController
// (Super+drag in Normal mode, no grid) — see
// development/tasks/13-widget-drag-drop.md "ต่างจาก 04-drag-reposition.md
// อย่างไร" for the full reasoning already recorded there. Summary: this
// controller only starts a drag while WidgetEditMode.isEditing(widgetId)
// is true (task 12), snaps to the grid via GridEngine (task 14) on drop,
// and shares task 04's own persistence call
// (StorageService.updateWidgetPosition()) — no new storage format, no new
// IPC, same single-process design as everything else in this codebase.

import Clutter from 'gi://Clutter';
import St from 'gi://St';

export class EditModeDragController {
    /**
     * @param {WidgetLayer} widgetLayer - task 02's layer; moved in memory
     *   during the drag exactly like task 04's controller does.
     * @param {StorageService} storageService - task 03's file layer; same
     *   single write-on-drop discipline as task 04.
     * @param {GridEngine} gridEngine - task 14; used for the drop snap +
     *   collision-avoidance search, and for live placeholder feedback
     *   during the drag.
     * @param {WidgetEditMode} editMode - task 12; gates whether a drag is
     *   even allowed to start, and is told about DRAGGING<->EDIT
     *   transitions via enterDragging()/exitDragging().
     */
    constructor(widgetLayer, storageService, gridEngine, editMode) {
        this._layer = widgetLayer;
        this._storage = storageService;
        this._grid = gridEngine;
        this._editMode = editMode;

        /** @private {Map<string, {actor, pressId, monitorIndex}>} */
        this._tracked = new Map();
        /** @private active drag state, at most one at a time, like task 04 */
        this._drag = null;
        /** @private () => Array<{id,x,y,width,height}> supplied by
         * extension.js — every OTHER widget currently on the same
         * monitor, for collision detection. A function rather than a
         * static list because it must reflect live positions, not a
         * snapshot taken at attach() time. */
        this._getOthersOnMonitor = null;
    }

    /**
     * @method setOthersProvider
     * @description Wires the collision-detection data source. Must be
     * called once before any drag can complete a grid-aware drop; without
     * it, drops still work but skip collision avoidance entirely (treated
     * as "no other widgets" - degrades gracefully rather than throwing).
     * @param {(monitorIndex:number, excludeId:string) => Array<{id:string,x:number,y:number,width:number,height:number}>} provider
     */
    setOthersProvider(provider) {
        this._getOthersOnMonitor = provider;
    }

    /**
     * @method attach
     * @description Wires edit-mode drag handling onto a single widget
     * actor. Call once per widget, same timing as
     * DragController.attach()/WidgetEditMode.attach().
     * @param {string} widgetId
     * @param {Clutter.Actor} actor
     * @param {number} [monitorIndex=0]
     */
    attach(widgetId, actor, monitorIndex = 0) {
        if (this._tracked.has(widgetId))
            return;

        const pressId = actor.connect('button-press-event', (_actor, event) => {
            if (this._drag)
                return Clutter.EVENT_PROPAGATE;

            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            // Spec: "Drag is available only while Edit Mode is active."
            if (!this._editMode.isEditing(widgetId))
                return Clutter.EVENT_PROPAGATE;

            const [stageX, stageY] = event.get_coords();
            const [startX, startY] = actor.get_position();
            const [width, height] = actor.get_size();

            const placeholder = this._buildPlaceholder(width, height);
            actor.get_parent()?.insert_child_below(placeholder, actor);
            placeholder.set_position(startX, startY);

            this._editMode.enterDragging(widgetId);

            this._drag = {
                widgetId, actor, monitorIndex, width, height,
                grabX: stageX, grabY: stageY,
                startX, startY,
                placeholder,
                motionId: global.stage.connect('motion-event', ev => this._onMotion(ev)),
                releaseId: global.stage.connect('button-release-event', ev => this._onRelease(ev)),
            };

            // Preview follows the pointer 1:1 (no grid snap while
            // dragging - only the PLACEHOLDER shows where it would land,
            // per spec's "Drag Preview" + "Placeholder" being two
            // separate features).
            actor.set_opacity(220);

            return Clutter.EVENT_STOP;
        });

        this._tracked.set(widgetId, {actor, pressId, monitorIndex});
    }

    /** @private */
    _onMotion(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;

        const [stageX, stageY] = event.get_coords();
        const newX = this._drag.startX + (stageX - this._drag.grabX);
        const newY = this._drag.startY + (stageY - this._drag.grabY);

        // Preview: unsnapped, follows the pointer exactly (in-memory
        // only, same as task 04 - never touches disk per motion event).
        this._layer.setWidgetPosition(this._drag.widgetId, newX, newY);

        // Placeholder: shows the grid cell it would actually land in if
        // released right now, including collision avoidance, so the user
        // sees the real drop target rather than just a raw grid snap
        // that might overlap another widget.
        const others = this._othersFor(this._drag);
        const bounds = this._monitorBoundsFor(this._drag.monitorIndex);
        const target = this._grid.findNearestFreeCell(
            newX, newY, this._drag.width, this._drag.height,
            bounds, others, this._drag.widgetId);

        this._drag.placeholder.set_position(target.x, target.y);
        this._drag.placeholder.set_style_class_name(
            target.collided
                ? 'widget-edit-mode-placeholder widget-edit-mode-placeholder-collision'
                : 'widget-edit-mode-placeholder');

        return Clutter.EVENT_STOP;
    }

    /** @private */
    _onRelease(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;

        const {widgetId, actor, monitorIndex, width, height, motionId, releaseId, placeholder} = this._drag;
        global.stage.disconnect(motionId);
        global.stage.disconnect(releaseId);

        const [currentX, currentY] = actor.get_position();
        const others = this._othersFor(this._drag);
        const bounds = this._monitorBoundsFor(monitorIndex);
        const target = this._grid.findNearestFreeCell(
            currentX, currentY, width, height, bounds, others, widgetId);

        // Single write for the whole drag, exactly like task 04's own
        // release handler and for the same reason (see its doc comment).
        actor.ease({
            x: target.x, y: target.y,
            duration: 120,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                this._storage.updateWidgetPosition(widgetId, target.x, target.y, monitorIndex);
            },
        });
        actor.set_opacity(255);

        placeholder.destroy();
        this._editMode.exitDragging(widgetId);
        this._drag = null;

        return Clutter.EVENT_STOP;
    }

    /** @private */
    _othersFor(drag) {
        return this._getOthersOnMonitor?.(drag.monitorIndex, drag.widgetId) ?? [];
    }

    /** @private monitor size for GridEngine's bounds argument — reads
     * straight off the layer's own container rather than duplicating
     * MonitorWatcher's monitor list here. Falls back to a generous
     * default if the container can't be found (shouldn't happen in
     * practice, matches the defensive style of WidgetLayer's own
     * fallbacks elsewhere in this codebase). */
    _monitorBoundsFor(monitorIndex) {
        const container = this._layer.getContainer(monitorIndex);
        if (container) {
            const [width, height] = container.get_size();
            if (width > 0 && height > 0)
                return {width, height};
        }
        return {width: 1920, height: 1080};
    }

    /** @private a dashed-border ghost rect showing the live drop target,
     * per spec's "Placeholder" feature. Styling (dashed border, tint) is
     * a stylesheet concern - this only sets the style class, not inline
     * colors. */
    _buildPlaceholder(width, height) {
        return new St.Widget({
            style_class: 'widget-edit-mode-placeholder',
            width, height,
            reactive: false,
        });
    }

    /**
     * @method detach
     * @description Mirrors DragController.detach() - aborts an in-flight
     * drag cleanly (destroying its placeholder and returning the widget's
     * edit-mode state to EDIT) before disconnecting the press handler.
     * @param {string} widgetId
     */
    detach(widgetId) {
        const entry = this._tracked.get(widgetId);
        if (!entry)
            return;

        if (this._drag?.widgetId === widgetId) {
            global.stage.disconnect(this._drag.motionId);
            global.stage.disconnect(this._drag.releaseId);
            this._drag.placeholder.destroy();
            this._editMode.exitDragging(widgetId);
            this._drag = null;
        }

        try {
            entry.actor.disconnect(entry.pressId);
        } catch (e) {
            // Actor may already be destroyed - same defensive pattern
            // used throughout this codebase (see DragController.detach()).
        }
        this._tracked.delete(widgetId);
    }

    /**
     * @method destroy
     * @description Detaches every tracked widget. Call from
     * extension.js disable() BEFORE the loader destroys the actors, same
     * ordering rule as task 04's DragController.destroy().
     */
    destroy() {
        for (const widgetId of Array.from(this._tracked.keys()))
            this.detach(widgetId);
    }
}
