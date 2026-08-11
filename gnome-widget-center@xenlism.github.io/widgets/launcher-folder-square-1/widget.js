// widgets/launcher-folder-square-1/widget.js
//
// A compact 1x1 card holding a 2x2 grid of FOLDER shortcuts - the
// "square" folder counterpart to widgets/launcher-square-1 (which does
// the same 2x2-icons-in-a-1x1-card layout for apps) and the small-card
// counterpart to widgets/launcher-folder-big (which is a 2x2 BLOCK
// holding a 3x3 folder grid). Clicking a folder opens it in the
// configured file manager (Nautilus by default).
//
// Recognizes XDG special folders (Downloads, Documents, Music, Pictures,
// Videos, Desktop, Public, Templates, plus $HOME) via
// lib/fsUtils.js's getSpecialFolderInfo() and shows the matching system
// icon + proper name instead of a generic "folder" icon/raw path
// basename - same lookup widgets/launcher-folder-big uses.
//
// Root actor (this._actor) is a plain St.Widget with Clutter.FixedLayout,
// holding a single St.Bin child (this._content) that does the actual
// centering/painting - lib/blockSizeManager.js's applyBlockSize()
// force-sets the root actor to an exact cols*16 x rows*16px size from
// metadata.json's block-type (1x1 = 176x176px) regardless of anything
// set here, so this._content is bound to that size via a
// Clutter.BindConstraint rather than a hardcoded pixel size - same
// pattern as widgets/launcher-square-1 and widgets/launcher-folder-big.

import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import {hasAllocation, insertChildAboveSafely, isMappedActor} from "../../lib/actorLifecycle.js";

import { getSpecialFolderInfo } from "../../lib/fsUtils.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, deferUntilMapped as _deferUntilMapped } from "../../lib/widgetVisualKit.js";

const GRID_COLS = 2;

const GRID_ROWS = 2;

const MAX_FOLDERS = GRID_COLS * GRID_ROWS;

const ICON_SIZE = 48;

const CELL_PADDING = 6;

const GRID_SPACING = 8;

const CARD_PADDING = 12;

const TOOLTIP_SHOW_DELAY_MS = 400;

export default class LauncherFolderSquare1 {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._cells = [];
    }
    buildActor() {
        this._actor = new St.Widget({
            style_class: "launcher-folder-square-1-root",
            layout_manager: new Clutter.FixedLayout,
            reactive: true
        });
        this._content = new St.Bin({
            style_class: "launcher-folder-square-1-content",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE
        }));
        this._actor.add_child(this._content);
        // Content's size is handled entirely by the BindConstraint above
        // (resolved during allocation, not via JS property reads) - same
        // fix as widgets/launcher-square-1 and widgets/launcher-folder-big;
        // reading this._actor.width/height directly here (before the actor
        // is in the stage) is what used to spam
        // "st_widget_get_theme_node called on the widget ... which is not
        // in the stage" at startup.
        this._actor.connect("notify::mapped", () => {
            if (!this._actor.mapped) return;
            this._content.set_size(this._actor.width, this._actor.height);
        });

        this._actor.connect("notify::allocation", () => {
            if (!this._actor.mapped) return;
            this._content.set_size(this._actor.width, this._actor.height);
        });

        const grid = new St.BoxLayout({
            vertical: true
        });
        for (let row = 0; row < GRID_ROWS; row++) {
            const rowBox = new St.BoxLayout({
                vertical: false
            });
            if (row > 0) rowBox.set_style(`margin-top: ${GRID_SPACING}px;`);
            for (let col = 0; col < GRID_COLS; col++) {
                if (col > 0) rowBox.add_child(new St.Widget({
                    width: GRID_SPACING,
                    height: 1
                }));
                const bin = new St.Bin({
                    style_class: "launcher-folder-square-1-cell",
                    width: ICON_SIZE + CELL_PADDING * 2,
                    height: ICON_SIZE + CELL_PADDING * 2
                });
                const icon = new St.Icon({
                    icon_name: "folder",
                    icon_size: ICON_SIZE
                });
                bin.set_child(icon);
                rowBox.add_child(bin);
                this._cells.push({
                    bin: bin,
                    icon: icon,
                    pressId: null,
                    tooltip: null,
                    path: null
                });
            }
            grid.add_child(rowBox);
        }
        this._content.set_child(grid);
        this._render();
        return this._actor;
    }
    enable() {}
    disable() {
        for (const cell of this._cells) this._disconnectCell(cell);
    }
    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            folders: [],
            fileManagerDesktopFile: "/usr/share/applications/org.gnome.Nautilus.desktop",
            backgroundColor: "#FFFFFF00",
            cornerRadius: 18
        };
    }
    onSettingsChanged() {
        this._render();
    }
    _disconnectCell(cell) {
        if (cell.pressId !== null) {
            cell.bin.disconnect(cell.pressId);
            cell.pressId = null;
        }
        if (cell.tooltip) {
            cell.tooltip.destroy();
            cell.tooltip = null;
        }
    }
    _render() {
        const folders = (this._settings.folders ?? []).slice(0, MAX_FOLDERS);
        _deferUntilMapped(this._content, () => this._content.set_style(_cardStyleCss(this._settings, {
            cornerRadiusFallback: 18
        }) + `padding: ${CARD_PADDING}px;`));
        for (let i = 0; i < this._cells.length; i++) {
            const cell = this._cells[i];
            const path = folders[i] ?? null;
            this._disconnectCell(cell);
            cell.path = path;
            if (!path) {
                cell.icon.hide();
                cell.bin.set_style("background-color: rgba(255,255,255,0.08); border-radius: 12px;");
                cell.bin.reactive = false;
                continue;
            }
            cell.bin.set_style("background-color: transparent;");
            cell.icon.show();
            const special = getSpecialFolderInfo(path);
            cell.icon.set_icon_name(special?.icon ?? "folder");
            const tooltipText = special?.label ?? (GLib.path_get_basename(path) || path);
            cell.tooltip = this._attachTooltip(cell.bin, tooltipText);
            cell.bin.reactive = true;
            cell.pressId = cell.bin.connect("button-press-event", (_actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
                if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
                this._openFolder(cell.path);
                return Clutter.EVENT_STOP;
            });
        }
    }
    _attachTooltip(cellActor, text) {
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
        const enterId = cellActor.connect("enter-event", () => {
            showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
                showTimeoutId = null;
                const stage = this._actor?.get_stage?.();
                if (!stage || !isMappedActor(cellActor, stage) || !hasAllocation(this._actor) ||
                    !hasAllocation(cellActor) || this._content?.get_parent?.() !== this._actor)
                    return GLib.SOURCE_REMOVE;
                tooltipLabel = new St.Label({
                    style_class: "launcher-folder-square-1-tooltip",
                    text: text
                });
                tooltipLabel.set_style("background-color: rgba(20, 20, 20, 0.95); color: #fff; " + "font-size: 12px; padding: 4px 8px; border-radius: 6px;");
                if (!insertChildAboveSafely(this._actor, tooltipLabel, this._content)) {
                    tooltipLabel.destroy();
                    tooltipLabel = null;
                    return GLib.SOURCE_REMOVE;
                }
                const [cellAbsX, cellAbsY] = cellActor.get_transformed_position();
                const [rootAbsX, rootAbsY] = this._actor.get_transformed_position();
                const cellX = cellAbsX - rootAbsX;
                const cellY = cellAbsY - rootAbsY;
                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                const [cardWidth, cardHeight] = this._actor.get_size();
                const idealX = cellX + (cellActor.width - labelWidth) / 2;
                const idealY = cellY - labelHeight - 6;
                tooltipLabel.set_position(Math.max(0, Math.min(idealX, cardWidth - labelWidth)), Math.max(0, Math.min(idealY, cardHeight - labelHeight)));
                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = cellActor.connect("leave-event", () => {
            hide();
            return Clutter.EVENT_PROPAGATE;
        });
        const pressId = cellActor.connect("button-press-event", hide);
        return {
            hide: hide,
            destroy() {
                hide();
                try {
                    cellActor.disconnect(enterId);
                    cellActor.disconnect(leaveId);
                    cellActor.disconnect(pressId);
                } catch (e) {}
            }
        };
    }
    _openFolder(folderPath) {
        if (!folderPath) return;
        const desktopFile = this._settings.fileManagerDesktopFile ?? "/usr/share/applications/org.gnome.Nautilus.desktop";
        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(desktopFile);
            if (!appInfo) {
                this._api.logger.info(`launcher-folder-square-1: could not read file manager .desktop at ${desktopFile}`);
                return;
            }
            appInfo.launch([ Gio.File.new_for_path(folderPath) ], null);
        } catch (e) {
            this._api.logger.info(`launcher-folder-square-1: failed to open ${folderPath}: ${e}`);
        }
    }
}
