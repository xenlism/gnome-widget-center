import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import {hasAllocation, insertChildAboveSafely, isMappedActor} from "../../lib/actorLifecycle.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, deferUntilMapped as _deferUntilMapped } from "../../lib/widgetVisualKit.js";

import { getSpecialFolderInfo } from "../../lib/fsUtils.js";

const GRID_COLS = 3;

const GRID_ROWS = 3;

const MAX_FOLDERS = GRID_COLS * GRID_ROWS;

const ICON_SIZE = 64;

const CELL_PADDING = 10;

const GRID_SPACING = 12;

const CARD_PADDING = 14;

const TOOLTIP_SHOW_DELAY_MS = 400;

export default class LauncherFolderSquareBig {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._cells = [];
    }
    buildActor() {
        this._actor = new St.Widget({
            style_class: "launcher-folder-square-big-root",
            layout_manager: new Clutter.FixedLayout,
            reactive: true
        });
        this._content = new St.Bin({
            style_class: "launcher-folder-square-big-content",
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE
        }));
        this._actor.add_child(this._content);
        // Content's size is handled entirely by the BindConstraint
        // above (resolved during allocation, not via JS property
        // reads) and FixedLayout defaults children to (0,0) - same as
        // the `switches` widget, which never had this bug. The manual
        // syncContentSize() this replaces used to read
        // this._actor.width/height directly from buildActor(), before
        // the actor is ever added to the stage; reading those
        // properties forces St to resolve a preferred-size/theme-node
        // for the (still unmapped) root actor, producing the repeated
        // "st_widget_get_theme_node called on the widget ... which is
        // not in the stage" warnings for both -root and -content.
        //this._content.set_position(0, 0);
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
                    style_class: "launcher-folder-square-big-cell",
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
                    style_class: "launcher-folder-square-big-tooltip",
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
                this._api.logger.info(`launcher-folder-square-big: could not read file manager .desktop at ${desktopFile}`);
                return;
            }
            appInfo.launch([ Gio.File.new_for_path(folderPath) ], null);
        } catch (e) {
            this._api.logger.info(`launcher-folder-square-big: failed to open ${folderPath}: ${e}`);
        }
    }
}
