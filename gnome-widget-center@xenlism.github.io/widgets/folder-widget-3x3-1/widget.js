// widgets/folder-widget-3x3/widget.js
//
// Android-style "Folder Widget": a rounded card holding a fixed grid of
// app icons, no labels. Each icon is independently clickable and launches
// its own .desktop entry (Gio.DesktopAppInfo.launch(), same convention as
// widgets/clock-modern's single launchOnClick handler) - unlike
// clock-modern, which launches ONE app for the whole card, this widget
// launches whichever icon was actually clicked.
//
// Root actor is an St.Bin, not St.BoxLayout: lib/blockSizeManager.js's
// applyBlockSize() force-sets this widget's root actor to an exact
// cols*16 x rows*16 px size from metadata.json's block-type (see
// WIDGET_API.md §2) regardless of what this widget would naturally lay
// out, so centering the icon grid inside an St.Bin (x_align/y_align
// CENTER) keeps it visually centered instead of pinned to the top-left
// corner if the natural grid size doesn't exactly match the allocated
// block. Background/corner-radius are painted on this Bin so they always
// fill the full allocated card, independent of the (possibly smaller)
// centered grid inside.
//
// The grid itself is 3 columns x 3 rows (9 slots), built as nested
// St.BoxLayout rows rather than Clutter.GridLayout, matching this
// project's existing "plain St actors + inline set_style()" convention
// (see SKILL.md §2) and avoiding an extra import. Empty slots (fewer
// than 9 apps configured) render as a faint placeholder square so the
// grid shape stays visible, matching the reference Android folder-widget
// look.
//
// backgroundColor supports an 8-digit #rrggbbaa hex (alpha: true on the
// config.json colorpicker) so a mostly-transparent white card like
// "#FFFFFF0F" works out of the box.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';

/** @private St's CSS engine only understands 6-digit "#rrggbb" hex (plus
 * rgb()/rgba()) - an 8-digit "#rrggbbaa" hex, which is exactly what this
 * widget's alpha-enabled backgroundColor field saves (see config.json's
 * "alpha": true), is not valid St CSS. The background-color declaration
 * using it is silently dropped, which is why the folder card had no
 * visible background even though the color was saved correctly.
 * Converts the 8-digit form to "rgba(r, g, b, a)", which St does
 * support; anything else (6-digit hex, already rgba(), etc.) passes
 * through unchanged. Same fix lib/themeService.js's hexToRgba() already
 * applies for the global theme system - duplicated here per this
 * widget's self-contained convention (see file header). */
function _toCssColor(hex, fallback) {
    const value = typeof hex === 'string' ? hex : fallback;
    const m = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})$/.exec(value);
    if (!m)
        return value;
    const r = parseInt(m[1].slice(0, 2), 16);
    const g = parseInt(m[1].slice(2, 4), 16);
    const b = parseInt(m[1].slice(4, 6), 16);
    const a = Math.round((parseInt(m[2], 16) / 255) * 1000) / 1000;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

const GRID_COLS = 3;
const GRID_ROWS = 3;
const MAX_APPS = GRID_COLS * GRID_ROWS;
const ICON_SIZE = 64;
const CELL_PADDING = 10;
const GRID_SPACING = 12;
const CARD_PADDING = 14;

export default class FolderWidget3x3 {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._cells = []; // { bin, icon, pressId, path }
    }

    // Must never throw, even with empty settings - getDefaultSettings()
    // always backfills these keys, and every settings read below also has
    // its own `??` fallback per SKILL.md §2.
    buildActor() {
        this._actor = new St.Bin({
            style_class: 'folder-widget-3x3-root',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const grid = new St.BoxLayout({vertical: true});

        for (let row = 0; row < GRID_ROWS; row++) {
            const rowBox = new St.BoxLayout({vertical: false});
            if (row > 0)
                rowBox.set_style(`margin-top: ${GRID_SPACING}px;`);

            for (let col = 0; col < GRID_COLS; col++) {
                if (col > 0)
                    rowBox.add_child(new St.Widget({width: GRID_SPACING, height: 1}));

                const bin = new St.Bin({
                    style_class: 'folder-widget-3x3-cell',
                    width: ICON_SIZE + CELL_PADDING * 2,
                    height: ICON_SIZE + CELL_PADDING * 2,
                });
                const icon = new St.Icon({icon_size: ICON_SIZE});
                bin.set_child(icon);
                rowBox.add_child(bin);

                this._cells.push({bin, icon, pressId: null, path: null});
            }

            grid.add_child(rowBox);
        }

        this._actor.set_child(grid);
        this._render();
        return this._actor;
    }

    enable() {
        // No timers needed - only re-render on settings changes.
    }

    disable() {
        for (const cell of this._cells)
            this._disconnectCell(cell);
    }

    getDefaultSettings() {
        return {
            apps: [],
            backgroundColor: '#FFFFFF0F',
            cornerRadius: 18,
        };
    }

    // Cross-process live update: re-render immediately so app picks,
    // background color, or corner radius changed in the Control Center
    // show up right away (mirrors widgets/clock-modern's onSettingsChanged).
    onSettingsChanged() {
        this._render();
    }

    /** @private */
    _disconnectCell(cell) {
        if (cell.pressId !== null) {
            cell.bin.disconnect(cell.pressId);
            cell.pressId = null;
        }
    }

    /** @private */
    _render() {
        const apps = (this._settings.apps ?? []).slice(0, MAX_APPS);
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#FFFFFF0F');
        const cornerRadius = this._settings.cornerRadius ?? 18;

        this._actor.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            `padding: ${CARD_PADDING}px;`
        );

        for (let i = 0; i < this._cells.length; i++) {
            const cell = this._cells[i];
            const path = apps[i] ?? null;
            this._disconnectCell(cell);
            cell.path = path;

            if (!path) {
                cell.icon.hide();
                cell.bin.set_style('background-color: rgba(255,255,255,0.08); border-radius: 12px;');
                cell.bin.reactive = false;
                continue;
            }

            let gicon = null;
            try {
                const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
                if (appInfo)
                    gicon = appInfo.get_icon();
            } catch (e) {
                this._api.logger.info(`folder-widget-3x3: could not read ${path}: ${e}`);
            }

            cell.bin.set_style('background-color: transparent;');
            cell.icon.show();
            if (gicon)
                cell.icon.set_gicon(gicon);
            else
                cell.icon.set_icon_name('application-x-executable-symbolic');

            cell.bin.reactive = true;
            cell.pressId = cell.bin.connect('button-press-event', (_actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
                    return Clutter.EVENT_PROPAGATE; // Super held - drag, not a click

                this._launchApp(cell.path);
                return Clutter.EVENT_STOP;
            });
        }
    }

    /** @private */
    _launchApp(path) {
        if (!path)
            return;

        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (!appInfo) {
                this._api.logger.info(`folder-widget-3x3: could not read .desktop file at ${path}`);
                return;
            }
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`folder-widget-3x3: failed to launch ${path}: ${e}`);
        }
    }
}
