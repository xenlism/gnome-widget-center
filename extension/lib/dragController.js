// extension/lib/dragController.js
//
// Task 04 — Super+drag repositioning for widget actors already placed in
// the Widget Layer (task 02). During a drag, the actor is moved in memory
// only (WidgetLayer.setWidgetPosition()) on every pointer motion; the new
// position is persisted exactly ONCE, on release
// (StorageService.updateWidgetPosition()) — see
// tasks/04-drag-reposition.md for why there is no DBus/SQLite service in
// between: this extension owns both the in-memory actor and layout.json
// directly, same process, no IPC.
//
// Drag implementation note: motion/release are tracked on `global.stage`
// (not the widget actor itself) once a drag starts. A Clutter actor stops
// receiving motion-event once the pointer leaves its own bounds, which
// happens constantly during a real drag - the standard GNOME Shell pattern
// is to grab at the stage level for the duration of the drag and release
// afterwards, which is what attach()/_onRelease() do below.

import Clutter from 'gi://Clutter';

export class DragController {
    /**
     * @param {WidgetLayer} widgetLayer - task 02's layer; used to move the
     *   actor in memory during the drag via setWidgetPosition(). Never
     *   touches disk.
     * @param {StorageService} storageService - task 03's file layer; used
     *   to persist the final position once on drop via
     *   updateWidgetPosition(). Never called per-frame (see acceptance
     *   criteria in tasks/04-drag-reposition.md).
     */
    constructor(widgetLayer, storageService) {
        this._layer = widgetLayer;
        this._storage = storageService;
        /** @private {Map<string, {actor, pressId, monitorIndex}>} */
        this._tracked = new Map();
        /** @private active drag state, at most one at a time (single
         * pointer) - null when nothing is being dragged. */
        this._drag = null;
    }

    /**
     * @method attach
     * @description Wires Super+drag handling onto a single widget actor.
     * Call once per widget right after it's placed in the layer (i.e.
     * right after WidgetLayer.addWidgetActor() in extension.js). Safe to
     * call twice for the same widgetId - the second call is a no-op, so
     * callers don't need to track whether a widget was already attached.
     * @param {string} widgetId
     * @param {Clutter.Actor} actor
     * @param {number} [monitorIndex=0] - carried through unchanged and
     *   saved alongside x/y on drop. Full multi-monitor drag handling
     *   (moving a widget from one monitor to another mid-drag) is task
     *   07's job, per "Out of scope" below - this just preserves whatever
     *   monitorIndex the widget already had.
     */
    attach(widgetId, actor, monitorIndex = 0) {
        if (this._tracked.has(widgetId))
            return;

        // Layer leaves actors non-reactive by default (see
        // widgetLayer.js init()) so widgets that don't want to be
        // draggable aren't forced to be - opt in here instead.
        actor.reactive = true;

        const pressId = actor.connect('button-press-event', (_actor, event) => {
            if (this._drag)
                return Clutter.EVENT_PROPAGATE; // one drag at a time

            if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                return Clutter.EVENT_PROPAGATE;

            if (!(event.get_state() & Clutter.ModifierType.MOD4_MASK))
                return Clutter.EVENT_PROPAGATE; // Super not held - not a drag

            const [stageX, stageY] = event.get_coords();
            const [startX, startY] = actor.get_position();

            this._drag = {
                widgetId, actor, monitorIndex,
                grabX: stageX, grabY: stageY,
                startX, startY,
                motionId: global.stage.connect('motion-event', (_s, ev) => this._onMotion(ev)),
                releaseId: global.stage.connect('button-release-event', (_s, ev) => this._onRelease(ev)),
            };

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

        // In-memory only - never touches disk. Called on every motion
        // event during the drag, unlike updateWidgetPosition() below.
        this._layer.setWidgetPosition(this._drag.widgetId, newX, newY);

        return Clutter.EVENT_STOP;
    }

    /** @private */
    _onRelease(event) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;

        const {widgetId, actor, monitorIndex, motionId, releaseId} = this._drag;
        global.stage.disconnect(motionId);
        global.stage.disconnect(releaseId);
        this._drag = null;

        const [x, y] = actor.get_position();

        // Single write for the whole drag. StorageService sanitizes
        // widgetId and read-modify-writes only this widget's entry in
        // layout.json - dragging one widget can never clobber another's
        // saved position (see storageService.js updateWidgetPosition()).
        this._storage.updateWidgetPosition(widgetId, x, y, monitorIndex);

        return Clutter.EVENT_STOP;
    }

    /**
     * @method detach
     * @description Disconnects drag handling for a single widget - e.g.
     * right before removeWidgetActor() when a widget is unloaded while the
     * extension stays enabled (hot-reload dev mode, task 08). If this
     * widget is mid-drag, the drag is aborted cleanly first so the
     * stage-level grab doesn't outlive the actor it was tracking.
     * @param {string} widgetId
     */
    detach(widgetId) {
        const entry = this._tracked.get(widgetId);
        if (!entry)
            return;

        if (this._drag?.widgetId === widgetId) {
            global.stage.disconnect(this._drag.motionId);
            global.stage.disconnect(this._drag.releaseId);
            this._drag = null;
        }

        entry.actor.disconnect(entry.pressId);
        this._tracked.delete(widgetId);
    }

    /**
     * @method destroy
     * @description Disconnects every tracked widget's drag signals. Call
     * from extension.js disable() BEFORE the loader destroys the actors
     * (same ordering rule as WidgetLayer - see extension.js disable()),
     * so no signal handler ever fires against an already-destroyed actor.
     */
    destroy() {
        for (const widgetId of Array.from(this._tracked.keys()))
            this.detach(widgetId);
    }
}
