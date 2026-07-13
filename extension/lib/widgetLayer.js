import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/**
 * @class WidgetLayer
 * @description Owns the single "Widget Layer" actor group that every widget
 * is placed inside, and inserts it at the scene-graph position validated in
 * task 00 (`Main.layoutManager._backgroundGroup`) — below every app window,
 * above the wallpaper, hidden automatically on lock screen (see
 * tasks/00-project-setup.md "Notes from implementation").
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
 */
export class WidgetLayer {
    /**
     * @param {StorageService} storageService - used only to look up/persist
     *   per-widget POSITIONS (layout.json) — never widget settings.
     */
    constructor(storageService) {
        this._storageService = storageService;
        this._container = null;
        /** @private {Map<string, {actor: Clutter.Actor}>} */
        this._activeWidgets = new Map();
        this._isInitialized = false;
    }

    /**
     * @method init
     * @description Creates the root container and inserts it into the scene
     * graph using the method validated in task 00. Must be called once,
     * before any addWidgetActor() call.
     */
    init() {
        if (this._isInitialized) return;

        this._container = new St.Widget({
            name: 'widget-layer-container',
            reactive: false, // task 04 flips this on per-widget-actor, not here
        });

        // Validated in tasks/00-project-setup.md "Notes from implementation":
        // background_group sits below app windows, is not workspace-bound,
        // and is auto-hidden on lock screen by GNOME's own session-mode
        // handling — no extra guard code needed here.
        Main.layoutManager._backgroundGroup.add_child(this._container);

        this._isInitialized = true;
    }

    /**
     * @method addWidgetActor
     * @description Places a widget's own actor (from `instance.buildActor()`)
     * into the layer at the given position. Does NOT create or own the
     * actor — WidgetLoader/extension.js does, and is responsible for
     * destroying it on unload.
     * @param {string} widgetId
     * @param {Clutter.Actor} actor
     * @param {{x:number, y:number}} position - monitor-relative coordinates
     */
    addWidgetActor(widgetId, actor, position) {
        if (!this._isInitialized) {
            throw new Error('WidgetLayer.init() must be called before addWidgetActor()');
        }
        if (this._activeWidgets.has(widgetId)) {
            throw new Error(`Widget "${widgetId}" is already in the layer — call removeWidgetActor() first`);
        }

        actor.set_position(position?.x ?? 0, position?.y ?? 0);
        this._container.add_child(actor);
        this._activeWidgets.set(widgetId, {actor});
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

        if (entry.actor.get_parent() === this._container)
            this._container.remove_child(entry.actor);
        this._activeWidgets.delete(widgetId);
    }

    /**
     * @method setWidgetPosition
     * @description Moves an already-placed widget's actor (used by the drag
     * controller in task 04 while dragging — does NOT persist to disk; call
     * StorageService.updateWidgetPosition() separately on drop).
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
     * @param {{x:number,y:number}} fallback
     * @returns {{x:number,y:number}}
     */
    getSavedPosition(widgetId, fallback) {
        const saved = this._storageService?.getWidgetPosition(widgetId);
        return saved ?? fallback ?? {x: 0, y: 0};
    }

    /**
     * @method getContainer
     * @returns {St.Widget} root actor of the layer (for tests/inspection only
     *   — normal code should not need this, use add/removeWidgetActor)
     */
    getContainer() {
        return this._container;
    }

    /**
     * @method destroy
     * @description Removes the layer from the scene graph and destroys the
     * container. Does NOT destroy individual widget actors — the caller
     * (extension.js, via WidgetLoader.unloadAll()) must do that first, or
     * their references will simply be dropped here (leaking Clutter actors
     * until the process itself exits). Call removeWidgetActor() or
     * unloadAll() before this in disable().
     */
    destroy() {
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
        this._activeWidgets.clear();
        this._isInitialized = false;
    }
}
