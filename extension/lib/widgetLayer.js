import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * @class WidgetLayer
 * @description Owns one "Widget Layer" container ACTOR PER MONITOR (task 07
 * — see tasks/07-multi-monitor-support.md), each inserted at the
 * scene-graph position validated in task 00
 * (`Main.layoutManager._backgroundGroup`) and positioned at that monitor's
 * own (x, y) origin. Because every widget actor is a child of its monitor's
 * container, `actor.get_position()` / `actor.set_position()` (used
 * unchanged by DragController, task 04) are automatically MONITOR-RELATIVE
 * coordinates — no widget or drag code needs to know about multi-monitor
 * offsets at all, only WidgetLayer itself does.
 *
 * Places REAL actors handed to it by WidgetLoader (from each widget's own
 * `buildActor()` per docs/WIDGET_API.md) — this layer does not know or care
 * what's inside a widget's actor, only where to put it.
 *
 * แก้ไข 2026-07-13: เวอร์ชันก่อนหน้าไฟล์นี้ไม่มี addWidgetActor()/
 * removeWidgetActor() เลย — แทนที่ด้วยการอ่าน layout.json เองแล้วสร้าง
 * St.BoxLayout เปล่าๆ ทาสีจาก customProperties.themeColor ตรงๆ (ไม่เคยรับ
 * actor จริงจาก widget instance ใดๆ) และ container ก็ไม่เคยถูกแนบเข้า
 * background_group เลย ผลคือ widget ที่โหลดสำเร็จจริงไม่เคยโผล่บนพื้นโต๊ะ
 * เขียนใหม่ให้ตรงกับสัญญาที่ tasks/02-widget-layer-rendering.md กำหนดไว้เอง
 *
 * แก้ไข 2026-07-15 (task 07): เดิมมี container เดียวแนบกับ background_group
 * ตรงๆ (ไม่ offset ตามจอ) ตำแหน่ง x/y ที่เซฟจึงเป็นพิกัด "รวมทุกจอ" (absolute
 * across the whole stage) — พอมีจอที่ 2 อยู่ทางซ้ายของจอหลัก (x ติดลบ) หรือ
 * สลับลำดับจอ ตำแหน่งจะเพี้ยนทันที เปลี่ยนเป็น container แยกต่อจอ ผูกกับ
 * MonitorWatcher (ดู monitorWatcher.js) แทน
 */
export class WidgetLayer {
    /**
     * @param {StorageService} storageService - used only to look up/persist
     *   per-widget POSITIONS (layout.json) — never widget settings.
     */
    constructor(storageService) {
        this._storageService = storageService;
        /** @private {Map<number, St.Widget>} monitorIndex -> per-monitor container */
        this._monitorContainers = new Map();
        /** @private {Array<object>} last monitor list handed to us, see
         * MonitorWatcher.getMonitors() for shape */
        this._monitors = [];
        /** @private {number} */
        this._primaryIndex = 0;
        /** @private {Map<string, {actor: Clutter.Actor, monitorIndex: number}>} */
        this._activeWidgets = new Map();
        this._isInitialized = false;
    }

    /**
     * @method init
     * @description Creates one container per current monitor and inserts
     * each into the scene graph using the method validated in task 00. Must
     * be called once, before any addWidgetActor() call.
     * @param {Array<object>} monitors - MonitorWatcher.getMonitors() shape;
     *   defaults to reading `Main.layoutManager.monitors` directly so
     *   callers/tests that don't have a MonitorWatcher handy still work.
     * @param {number} [primaryIndex] - defaults to
     *   `Main.layoutManager.primaryIndex`.
     */
    init(monitors = null, primaryIndex = null) {
        if (this._isInitialized) return;

        this._monitors = monitors ?? this._readMonitorsFallback();
        this._primaryIndex = primaryIndex ?? Main.layoutManager.primaryIndex ?? 0;

        for (const monitor of this._monitors)
            this._createContainer(monitor);

        this._isInitialized = true;
    }

    /** @private fallback when init()/reconcileMonitors() is called without
     * an explicit monitor list (e.g. no MonitorWatcher wired up). */
    _readMonitorsFallback() {
        return Main.layoutManager.monitors.map((monitor, index) => ({
            index, x: monitor.x, y: monitor.y,
            width: monitor.width, height: monitor.height,
            scale: monitor.geometryScale ?? 1,
            isPrimary: index === Main.layoutManager.primaryIndex,
        }));
    }

    /** @private creates and inserts the container for one monitor entry. */
    _createContainer(monitor) {
        const container = new St.Widget({
            name: `widget-layer-container-monitor-${monitor.index}`,
            reactive: false, // task 04 flips this on per-widget-actor, not here
        });

        // Validated in tasks/00-project-setup.md "Notes from implementation":
        // background_group sits below app windows, is not workspace-bound,
        // and is auto-hidden on lock screen by GNOME's own session-mode
        // handling — no extra guard code needed here.
        Main.layoutManager._backgroundGroup.add_child(container);

        // The offset that turns every child's LOCAL position into a
        // monitor-relative one from the widget's point of view, while
        // still landing in the right physical spot on the stage.
        container.set_position(monitor.x, monitor.y);

        this._monitorContainers.set(monitor.index, container);
    }

    /**
     * @method addWidgetActor
     * @description Places a widget's own actor (from `instance.buildActor()`)
     * into the layer at the given position. Does NOT create or own the
     * actor — WidgetLoader/extension.js does, and is responsible for
     * destroying it on unload.
     * @param {string} widgetId
     * @param {Clutter.Actor} actor
     * @param {{x:number, y:number, monitorIndex?:number}} position -
     *   coordinates RELATIVE TO the target monitor's own origin (top-left
     *   of that monitor = 0,0), per task 07. `monitorIndex` defaults to the
     *   primary monitor if omitted or no longer valid.
     */
    addWidgetActor(widgetId, actor, position) {
        if (!this._isInitialized) {
            throw new Error('WidgetLayer.init() must be called before addWidgetActor()');
        }
        if (this._activeWidgets.has(widgetId)) {
            throw new Error(`Widget "${widgetId}" is already in the layer — call removeWidgetActor() first`);
        }

        const monitorIndex = this._resolveMonitorIndex(position?.monitorIndex);
        const container = this._monitorContainers.get(monitorIndex);
        const clamped = this._clampToMonitor(monitorIndex, position?.x ?? 0, position?.y ?? 0);

        actor.set_position(clamped.x, clamped.y);
        container.add_child(actor);
        this._activeWidgets.set(widgetId, {actor, monitorIndex});
    }

    /**
     * @method removeWidgetActor
     * @description Detaches a widget's actor from the layer. Does NOT
     * destroy the actor — the caller (WidgetLoader.unloadAll()) owns that.
     * Safe to call for an id that isn't currently in the layer (no-op).
     * @param {string} widgetId
     */
    removeWidgetActor(widgetId) {
        const entry = this._activeWidgets.get(widgetId);
        if (!entry) return;

        const container = this._monitorContainers.get(entry.monitorIndex);
        try {
            if (container && entry.actor.get_parent() === container)
                container.remove_child(entry.actor);
        } catch (e) {
            // Actor may already have been destroyed by the caller (e.g.
            // WidgetLoader.reloadWidget() during task 08 hot-reload
            // destroys the old actor itself once the new one is confirmed
            // working) — nothing left to detach, just drop our stale
            // reference to it below.
        }
        this._activeWidgets.delete(widgetId);
    }

    /**
     * @method setWidgetPosition
     * @description Moves an already-placed widget's actor (used by the drag
     * controller in task 04 while dragging — does NOT persist to disk; call
     * StorageService.updateWidgetPosition() separately on drop). Coordinates
     * are relative to the widget's CURRENT monitor container — DragController
     * doesn't need to know monitor offsets since it only ever adds a stage
     * pixel delta to a previous get_position() read from the same actor.
     * @param {string} widgetId
     * @param {number} x
     * @param {number} y
     */
    setWidgetPosition(widgetId, x, y) {
        const entry = this._activeWidgets.get(widgetId);
        if (!entry) return;
        entry.actor.set_position(x, y);
    }

    /**
     * @method getSavedPosition
     * @description Looks up a widget's last-saved position from
     * layout.json, falling back to the caller-supplied default (typically
     * metadata.json's `default-position`) if nothing was ever saved.
     * @param {string} widgetId
     * @param {{x:number,y:number,monitorIndex?:number,monitor?:number}} fallback
     * @returns {{x:number,y:number,monitorIndex:number}}
     */
    getSavedPosition(widgetId, fallback) {
        const saved = this._storageService?.getWidgetPosition(widgetId);
        if (saved)
            return saved;

        return {
            x: fallback?.x ?? 0,
            y: fallback?.y ?? 0,
            monitorIndex: fallback?.monitorIndex ?? fallback?.monitor ?? 0,
        };
    }

    /**
     * @method reconcileMonitors
     * @description Called by extension.js whenever MonitorWatcher reports a
     * `monitors-changed` event (hotplug, resolution/scale change, layout
     * reorder). Per tasks/07-multi-monitor-support.md:
     *   - rebuilds one container per CURRENT monitor (destroying containers
     *     for monitor indices that no longer exist, creating ones for new
     *     indices);
     *   - any widget whose monitor disappeared is moved to the primary
     *     monitor (never silently dropped) and the reassignment is
     *     persisted, so it isn't lost again on the next save;
     *   - every remaining widget is clamped back inside its (possibly
     *     resized/rescaled) monitor's bounds.
     * Deliberately does NOT try to auto-restore a widget to a monitor that
     * comes back later — task 07's acceptance criteria leaves that as
     * "drag it back yourself via task 04", to avoid fighting the user if
     * they'd already moved it in the meantime.
     * @param {Array<object>} monitors - MonitorWatcher.getMonitors() shape
     * @param {number} primaryIndex
     */
    reconcileMonitors(monitors, primaryIndex) {
        if (!this._isInitialized) return;

        const previousIndices = new Set(this._monitorContainers.keys());
        const nextIndices = new Set(monitors.map(m => m.index));

        this._monitors = monitors;
        this._primaryIndex = primaryIndex ?? 0;

        // Create containers for any newly-appeared monitor index first, so
        // widgets can be reparented into them below without a gap.
        for (const monitor of monitors) {
            if (!this._monitorContainers.has(monitor.index))
                this._createContainer(monitor);
            else
                this._monitorContainers.get(monitor.index).set_position(monitor.x, monitor.y);
        }

        // Move any widget that was living on a monitor index that no
        // longer exists onto the primary monitor instead of leaving it
        // parented to a container we're about to destroy.
        for (const [widgetId, entry] of this._activeWidgets) {
            if (nextIndices.has(entry.monitorIndex))
                continue;

            const oldContainer = this._monitorContainers.get(entry.monitorIndex);
            if (oldContainer && entry.actor.get_parent() === oldContainer)
                oldContainer.remove_child(entry.actor);

            const newContainer = this._monitorContainers.get(this._primaryIndex);
            const clamped = this._clampToMonitor(this._primaryIndex, entry.actor.get_x(), entry.actor.get_y());
            entry.actor.set_position(clamped.x, clamped.y);
            newContainer.add_child(entry.actor);
            entry.monitorIndex = this._primaryIndex;

            // Persist so the fallback isn't undone by the very next save
            // of an unrelated widget's position (updateWidgetPosition()
            // read-modify-writes only its own entry, but layout.json
            // should still reflect reality if the shell restarts before
            // the user drags it back).
            this._storageService?.updateWidgetPosition(widgetId, clamped.x, clamped.y, this._primaryIndex);
        }

        // Now that no widget references them, destroy containers for
        // monitor indices that are gone for good.
        for (const index of previousIndices) {
            if (nextIndices.has(index)) continue;
            const container = this._monitorContainers.get(index);
            container?.destroy();
            this._monitorContainers.delete(index);
        }

        // Clamp everyone still on a monitor that just changed size/scale
        // (e.g. resolution change, HiDPI toggle) back within its bounds.
        for (const entry of this._activeWidgets.values()) {
            const clamped = this._clampToMonitor(entry.monitorIndex, entry.actor.get_x(), entry.actor.get_y());
            entry.actor.set_position(clamped.x, clamped.y);
        }
    }

    /** @private resolves a possibly-missing/stale monitorIndex to a valid
     * one, falling back to the primary monitor. */
    _resolveMonitorIndex(monitorIndex) {
        if (monitorIndex != null && this._monitorContainers.has(monitorIndex))
            return monitorIndex;
        return this._primaryIndex;
    }

    /** @private clamps (x, y) so a widget can never end up fully or
     * partially off the edge of its monitor (e.g. after that monitor
     * shrank). Doesn't know the widget's own size (WidgetLayer never reads
     * a widget's actor internals), so it clamps the origin point only —
     * good enough to guarantee the widget stays reachable/draggable rather
     * than vanishing past the visible edge. */
    _clampToMonitor(monitorIndex, x, y) {
        const monitor = this._monitors.find(m => m.index === monitorIndex);
        if (!monitor) return {x, y};

        return {
            x: Math.min(Math.max(x, 0), Math.max(monitor.width - 1, 0)),
            y: Math.min(Math.max(y, 0), Math.max(monitor.height - 1, 0)),
        };
    }

    /**
     * @method getMonitorIndexFor
     * @description Current monitorIndex a placed widget lives on — used by
     * extension.js when attaching DragController (task 04) so a drag that
     * starts after a monitor reassignment still saves the right index.
     * @param {string} widgetId
     * @returns {number} monitorIndex, or the primary monitor if unknown
     */
    getMonitorIndexFor(widgetId) {
        return this._activeWidgets.get(widgetId)?.monitorIndex ?? this._primaryIndex;
    }

    /**
     * @method getContainer
     * @param {number} [monitorIndex] - defaults to the primary monitor
     * @returns {St.Widget|null} root actor of that monitor's layer (for
     *   tests/inspection only — normal code should not need this, use
     *   add/removeWidgetActor)
     */
    getContainer(monitorIndex = null) {
        const index = monitorIndex ?? this._primaryIndex;
        return this._monitorContainers.get(index) ?? null;
    }

    /**
     * @method destroy
     * @description Removes every monitor container from the scene graph and
     * destroys them. Does NOT destroy individual widget actors — the caller
     * (extension.js, via WidgetLoader.unloadAll()) must do that first, or
     * their references will simply be dropped here (leaking Clutter actors
     * until the process itself exits). Call removeWidgetActor() or
     * unloadAll() before this in disable().
     */
    destroy() {
        for (const container of this._monitorContainers.values())
            container.destroy();
        this._monitorContainers.clear();
        this._activeWidgets.clear();
        this._monitors = [];
        this._isInitialized = false;
    }
}
