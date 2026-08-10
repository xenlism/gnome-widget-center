// widgets/launcher-big/widget.js
//
// Android-style "Launcher Widget": a rounded card holding a fixed grid of
// app icons, no labels. Each icon is independently clickable and launches
// its own .desktop entry (Gio.DesktopAppInfo.launch(), same convention as
// widgets/clock-modern's single launchOnClick handler) - unlike
// clock-modern, which launches ONE app for the whole card, this widget
// launches whichever icon was actually clicked.
//
// Root actor (this._actor) is a plain St.Widget with Clutter.FixedLayout,
// holding a single St.Bin child (this._content) that does the actual
// centering/painting: lib/blockSizeManager.js's applyBlockSize()
// force-sets the root actor to an exact cols*16 x rows*16 px size from
// metadata.json's block-type (see WIDGET_API.md §2) regardless of what
// this widget would naturally lay out, so this._content is bound to that
// size via a Clutter.BindConstraint and centers the icon grid inside
// itself (x_align/y_align CENTER) - keeping it visually centered instead
// of pinned to the top-left corner if the natural grid size doesn't
// exactly match the allocated block. Background/corner-radius are
// painted on this._content so they always fill the full allocated card,
// independent of the (possibly smaller) centered grid inside. The plain
// FixedLayout root exists so per-icon hover tooltips (see
// _attachTooltip()) can be positioned as free-floating overlay children,
// same reason widgets/power-menu/widget.js's root uses FixedLayout.
//
// The grid itself is 3 columns x 3 rows (9 slots), built as nested
// St.BoxLayout rows rather than Clutter.GridLayout, matching this
// project's existing "plain St actors + inline set_style()" convention
// (see SKILL.md §2) and avoiding an extra import. Empty slots (fewer
// than 9 apps configured) render as a faint placeholder square so the
// grid shape stays visible, matching the reference Android launcher-widget
// look.
//
// backgroundColor supports an 8-digit #rrggbbaa hex (alpha: true on the
// config.json colorpicker) so a mostly-transparent white card like
// "#FFFFFF0F" works out of the box.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS} from '../../lib/widgetVisualKit.js';

const GRID_COLS = 3;
const GRID_ROWS = 3;
const MAX_APPS = GRID_COLS * GRID_ROWS;
const ICON_SIZE = 64;
const CELL_PADDING = 10;
const GRID_SPACING = 12;
const CARD_PADDING = 14;
// Same delayed-hover-label pattern (and delay) as
// widgets/power-menu/widget.js's _attachTooltip() - each app icon shows
// its .desktop entry's Name on hover instead of a permanent text label.
const TOOLTIP_SHOW_DELAY_MS = 400;

export default class LauncherBig {
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
        // Plain (non-layout-managed-by-parent) root so tooltip labels can
        // be positioned as free-floating overlay children, same reason
        // widgets/power-menu/widget.js's root uses Clutter.FixedLayout.
        // lib/blockSizeManager.js's applyBlockSize() sets this actor's
        // size directly (see file header), so this._content is bound to
        // match it via a BindConstraint rather than sized here - that
        // preserves the original St.Bin-based CENTER/CENTER behavior
        // (the icon grid still centers inside this._content exactly as
        // before) while giving this._actor itself a coordinate space
        // tooltips can be placed in.
        this._actor = new St.Widget({
            style_class: 'launcher-big-root',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
        });

        this._content = new St.Bin({
            style_class: 'launcher-big-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._actor.add_child(this._content);
        // FixedLayout uses a child's natural size when allocating it.  A
        // BindConstraint alone therefore leaves this card at the icon
        // grid's natural 304px square instead of the root's block size.
        // Mirror root-size changes explicitly so the painted card always
        // occupies the complete block allocated by BlockSizeManager.
        const syncContentSize = () => {
            this._content.set_position(0, 0);
            this._content.set_size(this._actor.width, this._actor.height);
        };
        this._actor.connect('notify::width', syncContentSize);
        this._actor.connect('notify::height', syncContentSize);
        syncContentSize();

        const grid = new St.BoxLayout({vertical: true});

        for (let row = 0; row < GRID_ROWS; row++) {
            const rowBox = new St.BoxLayout({vertical: false});
            if (row > 0)
                rowBox.set_style(`margin-top: ${GRID_SPACING}px;`);

            for (let col = 0; col < GRID_COLS; col++) {
                if (col > 0)
                    rowBox.add_child(new St.Widget({width: GRID_SPACING, height: 1}));

                const bin = new St.Bin({
                    style_class: 'launcher-big-cell',
                    width: ICON_SIZE + CELL_PADDING * 2,
                    height: ICON_SIZE + CELL_PADDING * 2,
                });
                const icon = new St.Icon({icon_size: ICON_SIZE});
                bin.set_child(icon);
                rowBox.add_child(bin);

                this._cells.push({bin, icon, pressId: null, tooltip: null, path: null});
            }

            grid.add_child(rowBox);
        }

        this._content.set_child(grid);
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
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            apps: [],
            backgroundColor: '#FFFFFF00',
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
        if (cell.tooltip) {
            cell.tooltip.destroy();
            cell.tooltip = null;
        }
    }

    /** @private */
    _render() {
        const apps = (this._settings.apps ?? []).slice(0, MAX_APPS);

        this._content.set_style(
            _cardStyleCss(this._settings, {cornerRadiusFallback: 18}) +
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
            let tooltipText = null;
            try {
                const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
                if (appInfo) {
                    gicon = appInfo.get_icon();
                    // The .desktop file's Name= value - same field GNOME's
                    // own app grid/dash use as each app's display name.
                    tooltipText = appInfo.get_name();
                }
            } catch (e) {
                this._api.logger.info(`launcher-big: could not read ${path}: ${e}`);
            }

            cell.bin.set_style('background-color: transparent;');
            cell.icon.show();
            if (gicon)
                cell.icon.set_gicon(gicon);
            else
                cell.icon.set_icon_name('application-x-executable-symbolic');

            if (tooltipText)
                cell.tooltip = this._attachTooltip(cell.bin, tooltipText);

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

    /**
     * @private hover-tooltip for one grid cell, showing its app's
     * .desktop Name after a short hover delay - same delayed-hover-label
     * pattern as widgets/power-menu/widget.js's _attachTooltip(). Differs
     * from that version in how the label's position is computed: that
     * widget's buttons sit one level below its root (root -> GridLayout
     * -> button), so summing each actor's own get_position() was enough.
     * This widget's cells sit three levels below this._actor (root ->
     * content Bin -> vertical grid -> horizontal row -> cell Bin), and
     * the content Bin re-centers that whole stack via CENTER/CENTER
     * alignment, so get_position() alone isn't reliably meaningful at
     * every level. get_transformed_position() (stage/screen coordinates)
     * sidesteps that - diffing the cell's and root's transformed
     * positions gives the cell's position relative to the root
     * regardless of how deeply it's nested or how its ancestors align it.
     * Returns `{hide(), destroy()}` - see disable()/_disconnectCell()
     * above for how each is used.
     * @param {St.Bin} cellActor
     * @param {string} text
     */
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

        const enterId = cellActor.connect('enter-event', () => {
            showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
                showTimeoutId = null;
                tooltipLabel = new St.Label({
                    style_class: 'launcher-big-tooltip',
                    text,
                });
                tooltipLabel.set_style(
                    'background-color: rgba(20, 20, 20, 0.95); color: #fff; ' +
                    'font-size: 12px; padding: 4px 8px; border-radius: 6px;'
                );
                this._actor.insert_child_above(tooltipLabel, this._content);

                const [cellAbsX, cellAbsY] = cellActor.get_transformed_position();
                const [rootAbsX, rootAbsY] = this._actor.get_transformed_position();
                const cellX = cellAbsX - rootAbsX;
                const cellY = cellAbsY - rootAbsY;

                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                const [cardWidth, cardHeight] = this._actor.get_size();

                // Prefer just above the icon, clamped to stay fully
                // on-card - same reasoning as power-menu's version:
                // anything outside [0, cardWidth] x [0, cardHeight] would
                // be clipped invisible rather than floating over
                // neighboring widgets.
                const idealX = cellX + (cellActor.width - labelWidth) / 2;
                const idealY = cellY - labelHeight - 6;
                tooltipLabel.set_position(
                    Math.max(0, Math.min(idealX, cardWidth - labelWidth)),
                    Math.max(0, Math.min(idealY, cardHeight - labelHeight))
                );

                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = cellActor.connect('leave-event', () => {
            hide();
            return Clutter.EVENT_PROPAGATE;
        });
        // Hides on click too (e.g. the app is about to launch) - a
        // second listener on 'button-press-event' alongside the launch
        // handler _render() also connects; cellActor is a plain St.Bin
        // (not St.Button), so there's no separate 'clicked' signal to use.
        const pressId = cellActor.connect('button-press-event', hide);

        return {
            hide,
            destroy() {
                hide();
                try {
                    cellActor.disconnect(enterId);
                    cellActor.disconnect(leaveId);
                    cellActor.disconnect(pressId);
                } catch (e) {
                    // cellActor may already be destroyed by the caller's
                    // own teardown - same defensive pattern as power-menu.
                }
            },
        };
    }

    /** @private */
    _launchApp(path) {
        if (!path)
            return;

        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(path);
            if (!appInfo) {
                this._api.logger.info(`launcher-big: could not read .desktop file at ${path}`);
                return;
            }
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`launcher-big: failed to launch ${path}: ${e}`);
        }
    }
}
