import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import {hasAllocation, insertChildAboveSafely, isMappedActor} from "./actorLifecycle.js";

export const EditModeState = Object.freeze({
    NORMAL: "normal",
    HOVER: "hover",
    EDIT: "edit",
    DRAGGING: "dragging"
});

const ICON_ROW_HEIGHT = 32;

const TOOLBAR_FADE_MS = 150;

const TOOLTIP_SHOW_DELAY_MS = 500;

export class WidgetEditMode {
    constructor(storageService, callbacks = {}, logger = null, themeService = null) {
        this._storage = storageService;
        this._theme = themeService;
        this._onSettings = callbacks.onSettings ?? (() => {});
        this._onRemove = callbacks.onRemove ?? (() => {});
        this._onUninstall = callbacks.onUninstall ?? null;
        this._onAddChild = callbacks.onAddChild ?? (() => {});
        this._onReset = callbacks.onReset ?? (widgetId => this._exitEdit(widgetId));
        this._onBackActorReady = callbacks.onBackActorReady ?? (() => {});
        this._logger = logger ?? {
            debug() {},
            warn() {},
            error() {}
        };
        this._widgets = new Map;
    }
    attach(widgetId, actor, options = {}) {
        if (this._widgets.has(widgetId)) {
            this._logger.debug("edit-mode", `attach("${widgetId}") skipped — already attached`);
            return;
        }
        this._logger.debug("edit-mode", `attach("${widgetId}")`);
        const rightClickId = actor.connect("button-press-event", (_actor, event) => {
            this._logger.debug("edit-mode", `front button-press("${widgetId}") button=${event.get_button()} state=${this.getState(widgetId)}`);
            if (event.get_button() !== Clutter.BUTTON_SECONDARY) return Clutter.EVENT_PROPAGATE;
            this.toggle(widgetId);
            return Clutter.EVENT_STOP;
        });
        const enterId = actor.connect("enter-event", () => {
            this._setState(widgetId, EditModeState.HOVER, {
                ifCurrently: EditModeState.NORMAL
            });
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = actor.connect("leave-event", () => {
            this._setState(widgetId, EditModeState.NORMAL, {
                ifCurrently: EditModeState.HOVER
            });
            return Clutter.EVENT_PROPAGATE;
        });
        this._widgets.set(widgetId, {
            actor: actor,
            state: EditModeState.NORMAL,
            toolbar: null,
            isUserInstalled: options.isUserInstalled ?? false,
            hasAddChild: options.hasAddChild ?? false,
            escId: null,
            toolbarGeneration: 0,
            signalIds: {
                rightClickId: rightClickId,
                enterId: enterId,
                leaveId: leaveId
            }
        });
    }
    toggle(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry) {
            this._logger.warn("edit-mode", `toggle("${widgetId}") — no such widget attached`);
            return;
        }
        if (entry.state === EditModeState.DRAGGING) {
            this._logger.debug("edit-mode", `toggle("${widgetId}") ignored — currently DRAGGING`);
            return;
        }
        this._logger.debug("edit-mode", `toggle("${widgetId}") from state=${entry.state}`);
        if (entry.state === EditModeState.EDIT) this._exitEdit(widgetId); else this._enterEdit(widgetId);
    }
    getState(widgetId) {
        return this._widgets.get(widgetId)?.state ?? null;
    }
    isEditing(widgetId) {
        const state = this.getState(widgetId);
        return state === EditModeState.EDIT || state === EditModeState.DRAGGING;
    }
    enterDragging(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state !== EditModeState.EDIT) return;
        entry.state = EditModeState.DRAGGING;
    }
    exitDragging(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state !== EditModeState.DRAGGING) return;
        entry.state = EditModeState.EDIT;
    }
    _enterEdit(widgetId) {
        const entry = this._widgets.get(widgetId);
        entry.state = EditModeState.EDIT;
        this._logger.debug("edit-mode", `_enterEdit("${widgetId}") toolbar-exists=${!!entry.toolbar}`);
        if (!entry.toolbar) entry.toolbar = this._buildToolbar(widgetId, entry);
        const parent = entry.actor.get_parent();
        parent?.set_child_above_sibling(entry.actor, null);
        parent?.set_child_above_sibling(entry.toolbar, null);
        entry.actor.reactive = false;
        this._showToolbar(entry);
        entry.escId = global.stage.connect("key-press-event", (_stage, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._exitEdit(widgetId);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }
    _exitEdit(widgetId) {
        const entry = this._widgets.get(widgetId);
        entry.state = EditModeState.NORMAL;
        this._logger.debug("edit-mode", `_exitEdit("${widgetId}")`);
        if (entry.escId != null) {
            global.stage.disconnect(entry.escId);
            entry.escId = null;
        }
        entry.actor.reactive = true;
        this._hideToolbar(entry);
    }
    _showToolbar(entry) {
        const {toolbar: toolbar} = entry;
        const generation = ++entry.toolbarGeneration;
        toolbar.remove_all_transitions();
        toolbar.reactive = true;
        toolbar.visible = true;
        toolbar.ease({
            opacity: 255,
            duration: TOOLBAR_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (entry.toolbarGeneration !== generation) return;
                this._logger.debug("edit-mode", `_showToolbar finalize`);
            }
        });
    }
    _hideToolbar(entry) {
        const {toolbar: toolbar} = entry;
        const generation = ++entry.toolbarGeneration;
        toolbar.remove_all_transitions();
        toolbar.reactive = false;
        toolbar.ease({
            opacity: 0,
            duration: TOOLBAR_FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (entry.toolbarGeneration !== generation) return;
                this._logger.debug("edit-mode", `_hideToolbar finalize`);
                try {
                    toolbar.visible = false;
                } catch (e) {}
            }
        });
    }
    _buildToolbar(widgetId, entry) {
        const [width, height] = entry.actor.get_size();
        this._logger.debug("edit-mode", `_buildToolbar("${widgetId}") frontSize=${width}x${height}`);
        if (width <= 0 || height <= 0) {
            this._logger.warn("edit-mode", `_buildToolbar("${widgetId}") built with a non-positive size (${width}x${height}) — ` + "the front actor likely has not been allocated yet; the toolbar may render " + "invisibly or zero-size. If icon clicks/right-click seem to do nothing, this " + "is the first thing to check.");
        }
        const toolbar = new St.Widget({
            style_class: "widget-edit-mode-toolbar-bar",
            layout_manager: new Clutter.FixedLayout,
            reactive: false,
            width: width,
            height: height,
            visible: false,
            opacity: 0
        });
        const row = new St.BoxLayout({
            style_class: "widget-edit-mode-icon-row",
            vertical: false,
            width: width,
            height: ICON_ROW_HEIGHT,
            x_expand: false,
            y_expand: false
        });
        toolbar.add_child(row);
        row.set_position(0, 0);
        const dragArea = new St.Widget({
            style_class: "widget-edit-mode-drag-handle",
            layout_manager: new Clutter.BinLayout,
            reactive: true,
            width: width,
            height: Math.max(height - ICON_ROW_HEIGHT, 0),
            x_expand: false,
            y_expand: false
        });
        toolbar.add_child(dragArea);
        dragArea.set_position(0, ICON_ROW_HEIGHT);
        const grip = new St.Label({
            style_class: "widget-edit-mode-grip",
            text: "⛶",
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER
        });
        dragArea.add_child(grip);
        entry.tooltipCleanups = [];
        const addButton = (iconName, label, styleClass, onClicked) => {
            const button = new St.Button({
                style_class: `widget-edit-mode-action ${styleClass}`,
                accessible_name: label,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    icon_name: iconName,
                    style_class: "widget-edit-mode-action-icon"
                })
            });
            button.connect("clicked", () => {
                if (!this.isEditing(widgetId)) {
                    this._logger.debug("edit-mode", `toolbar button clicked ("${widgetId}", label="${label}") ignored — not editing`);
                    return;
                }
                this._logger.debug("edit-mode", `toolbar button clicked ("${widgetId}", label="${label}")`);
                onClicked();
            });
            row.add_child(button);
            entry.tooltipCleanups.push(this._attachTooltip(button, toolbar, row, label));
        };
        if (entry.hasAddChild) {
            addButton("list-add-symbolic", "Add Widget", "widget-edit-mode-action-add", () => this._onAddChild(widgetId));
        }
        addButton("preferences-system-symbolic", "Settings", "widget-edit-mode-action-settings", () => this._onSettings(widgetId));
        addButton("view-refresh-symbolic", "Reset", "widget-edit-mode-action-reset", () => {
            this._storage?.resetWidgetSettings(widgetId);
            this._storage?.removeWidgetLayoutEntry(widgetId);
            this._onReset(widgetId);
        });
        addButton("window-close-symbolic", "Remove", "widget-edit-mode-action-remove", () => this._onRemove(widgetId));
        if (this._onUninstall && entry.isUserInstalled) {
            addButton("user-trash-symbolic", "Uninstall", "widget-edit-mode-action-uninstall", () => this._onUninstall(widgetId, entry.isUserInstalled));
        }
        toolbar.connect("button-press-event", (_actor, event) => {
            this._logger.debug("edit-mode", `toolbar button-press("${widgetId}") button=${event.get_button()} state=${this.getState(widgetId)}`);
            if (event.get_button() !== Clutter.BUTTON_SECONDARY) return Clutter.EVENT_PROPAGATE;
            this.toggle(widgetId);
            return Clutter.EVENT_STOP;
        });
        const parent = entry.actor.get_parent();
        insertChildAboveSafely(parent, toolbar, entry.actor);
        toolbar.set_position(entry.actor.get_x(), entry.actor.get_y());
        this._theme?.applyGlobalStyle(toolbar);
        this._onBackActorReady(widgetId, toolbar, dragArea);
        return toolbar;
    }
    _attachTooltip(button, toolbar, row, text) {
        let showTimeoutId = null;
        let tooltipLabel = null;
        const hide = () => {
            if (showTimeoutId != null) {
                GLib.source_remove(showTimeoutId);
                showTimeoutId = null;
            }
            tooltipLabel?.destroy();
            tooltipLabel = null;
        };
        const enterId = button.connect("enter-event", () => {
            showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
                showTimeoutId = null;
                const stage = toolbar.get_stage();
                if (!stage || !isMappedActor(button, stage) ||
                    !hasAllocation(toolbar) || !hasAllocation(button) ||
                    row.get_parent() !== toolbar)
                    return GLib.SOURCE_REMOVE;

                tooltipLabel = new St.Label({
                    style_class: "widget-edit-mode-tooltip",
                    text: text
                });
                if (!insertChildAboveSafely(toolbar, tooltipLabel, row)) {
                    tooltipLabel.destroy();
                    tooltipLabel = null;
                    return GLib.SOURCE_REMOVE;
                }
                const [rowX, rowY] = row.get_position();
                const [buttonX, buttonY] = button.get_position();
                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                tooltipLabel.set_position(rowX + buttonX + (button.width - labelWidth) / 2, rowY + buttonY - labelHeight - 4);
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = button.connect("leave-event", () => {
            hide();
            return Clutter.EVENT_PROPAGATE;
        });
        const clickedId = button.connect("clicked", hide);
        return {
            destroy() {
                hide();
                try {
                    button.disconnect(enterId);
                    button.disconnect(leaveId);
                    button.disconnect(clickedId);
                } catch (e) {}
            }
        };
    }
    reapplyTheme() {
        if (!this._theme) return;
        for (const entry of this._widgets.values()) {
            if (entry.toolbar) this._theme.applyGlobalStyle(entry.toolbar);
        }
    }
    _setState(widgetId, next, {ifCurrently: ifCurrently}) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state !== ifCurrently) return;
        entry.state = next;
    }
    detach(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry) return;
        if (entry.escId != null) global.stage.disconnect(entry.escId);
        const {rightClickId: rightClickId, enterId: enterId, leaveId: leaveId} = entry.signalIds;
        try {
            entry.actor.disconnect(rightClickId);
            entry.actor.disconnect(enterId);
            entry.actor.disconnect(leaveId);
        } catch (e) {}
        for (const cleanup of entry.tooltipCleanups ?? []) cleanup.destroy();
        entry.toolbar?.destroy();
        this._widgets.delete(widgetId);
    }
    destroy() {
        for (const widgetId of Array.from(this._widgets.keys())) this.detach(widgetId);
    }
}
