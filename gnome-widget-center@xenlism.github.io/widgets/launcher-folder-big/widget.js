import Clutter from "gi://Clutter";

import St from "gi://St";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, deferUntilMapped as _deferUntilMapped } from "../../lib/widgetVisualKit.js";

import { createLayeredCard } from "../../lib/cardLayers.js";
import { attachTooltip } from "../../lib/widgetTooltip.js";

import { getSpecialFolderInfo } from "../../lib/fsUtils.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
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
        this._layers = createLayeredCard({
            contentStyleClass: "launcher-folder-square-big-content",
            withTooltipLayer: true,
        });
        this._actor = this._layers.root;
        this._actor.reactive = true;
        // this._content is a plain wrapper - the Content Layer itself
        // (this._layers.content) carries no style of its own (Rule 5).
        this._content = new St.Bin({
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._layers.content.add_child(this._content);
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
        // R5: card visual styling (background-color, corner-radius) goes on
        // the dedicated Background Layer; _content stays a pure wrapper.
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
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
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
        _deferUntilMapped(this._actor, () => {
            this._layers.card.set_style(_cardStyleCss(this._settings, {
                cornerRadiusFallback: 18
            }));
            this._content.set_style(`padding: ${CARD_PADDING}px;`);
        });
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
            cell.tooltip = attachTooltip(cell.bin, this._layers, tooltipText);
            cell.bin.reactive = true;
            cell.pressId = cell.bin.connect("button-press-event", (_actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
                if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
                this._openFolder(cell.path);
                return Clutter.EVENT_STOP;
            });
        }
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
