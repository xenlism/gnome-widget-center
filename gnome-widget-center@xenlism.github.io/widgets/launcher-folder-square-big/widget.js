// widgets/launcher-folder-square-big/widget.js
//
// Same Android-style launcher-grid shape as widgets/launcher-big-1, just
// pointed at FOLDERS instead of .desktop apps: a rounded 2x2-block card
// holding a 3x3 grid (9 slots) of folder icons. Clicking one opens that
// folder in the configured file manager (Nautilus by default - see
// getDefaultSettings()'s `fileManagerDesktopFile`), not "run this
// .desktop file" the way every other launcher widget in this project
// works, since a folder path isn't itself launchable.
//
// Root actor / content-binding / centering follows widgets/launcher-big-1
// exactly (see that file's header for the full BindConstraint/FixedLayout
// reasoning) - only the per-cell data model and click action differ:
//   - Each grid item is a plain folder PATH (settings.folders[]), not a
//     .desktop path.
//   - The icon is always the CURRENT ICON THEME's own "folder" symbol
//     (`St.Icon`'s `icon_name: 'folder'`, resolved through the running
//     icon theme same as any other themed icon-by-name in this codebase -
//     no folder ever has its own custom icon), not per-item like
//     launcher-big's per-app icons.
//   - Tooltip is the folder's basename (e.g. "Projects" for
//     /home/user/Projects), not a .desktop entry's Name=.
//   - Click launches `fileManagerDesktopFile` (a normal Gio.DesktopAppInfo
//     .desktop path, same launch mechanism as every other widget here)
//     with the folder's path/URI as its one argument, instead of
//     launching the folder path itself.

import Clutter from 'gi://Clutter';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor} from '../../lib/widgetVisualKit.js';

const GRID_COLS = 3;
const GRID_ROWS = 3;
const MAX_FOLDERS = GRID_COLS * GRID_ROWS;
const ICON_SIZE = 64;
const CELL_PADDING = 10;
const GRID_SPACING = 12;
const CARD_PADDING = 14;
// Same delayed-hover-label pattern (and delay) as
// widgets/power-menu/widget.js's _attachTooltip() - each folder icon
// shows its own basename on hover instead of a permanent text label.
const TOOLTIP_SHOW_DELAY_MS = 400;

export default class LauncherFolderSquareBig {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._cells = []; // { bin, icon, pressId, tooltip, path }
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
        // match it via a BindConstraint rather than sized here.
        this._actor = new St.Widget({
            style_class: 'launcher-folder-square-big-root',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
        });

        this._content = new St.Bin({
            style_class: 'launcher-folder-square-big-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._actor.add_child(this._content);
        // FixedLayout uses a child's natural size when allocating it. A
        // BindConstraint alone therefore leaves this card at the icon
        // grid's natural size instead of the root's block size. Mirror
        // root-size changes explicitly so the painted card always
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
                    style_class: 'launcher-folder-square-big-cell',
                    width: ICON_SIZE + CELL_PADDING * 2,
                    height: ICON_SIZE + CELL_PADDING * 2,
                });
                // Always the icon theme's own "folder" symbol - see file
                // header. St.Icon resolves icon_name through the running
                // icon theme the same way every other by-name icon in
                // this codebase does, so this automatically follows
                // whatever icon theme is active (no per-folder icon to
                // look up, unlike launcher-big's per-app .desktop icons).
                const icon = new St.Icon({icon_name: 'folder', icon_size: ICON_SIZE});
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
            folders: [],
            // Opens every folder in this widget - Nautilus (GNOME Files)
            // is GNOME's own default file manager, hence the default
            // path here; anyone using a different file manager's own
            // .desktop entry from /usr/share/applications can swap it in
            // Settings -> File manager.
            fileManagerDesktopFile: '/usr/share/applications/org.gnome.Nautilus.desktop',
            backgroundColor: '#FFFFFF00',
            cornerRadius: 18,
        };
    }

    // Cross-process live update: re-render immediately so folder picks,
    // file-manager choice, background color, or corner radius changed in
    // the Control Center show up right away (mirrors
    // widgets/launcher-big-1's onSettingsChanged).
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
        const folders = (this._settings.folders ?? []).slice(0, MAX_FOLDERS);
        const backgroundColor = _toCssColor(this._settings.backgroundColor, '#FFFFFF00');
        const cornerRadius = this._settings.cornerRadius ?? 18;

        this._content.set_style(
            `background-color: ${backgroundColor}; ` +
            `border-radius: ${cornerRadius}px; ` +
            `padding: ${CARD_PADDING}px;` +
            _shadowBoxShadowCss(this._settings)
        );

        for (let i = 0; i < this._cells.length; i++) {
            const cell = this._cells[i];
            const path = folders[i] ?? null;
            this._disconnectCell(cell);
            cell.path = path;

            if (!path) {
                cell.icon.hide();
                cell.bin.set_style('background-color: rgba(255,255,255,0.08); border-radius: 12px;');
                cell.bin.reactive = false;
                continue;
            }

            cell.bin.set_style('background-color: transparent;');
            cell.icon.show();
            // Always 'folder' (see buildActor()'s comment) - nothing
            // per-path to look up here, unlike launcher-big's per-app
            // Gio.DesktopAppInfo icon lookup.
            cell.icon.set_icon_name('folder');

            const tooltipText = GLib.path_get_basename(path) || path;
            cell.tooltip = this._attachTooltip(cell.bin, tooltipText);

            cell.bin.reactive = true;
            cell.pressId = cell.bin.connect('button-press-event', (_actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY)
                    return Clutter.EVENT_PROPAGATE;

                if (event.get_state() & Clutter.ModifierType.MOD4_MASK)
                    return Clutter.EVENT_PROPAGATE; // Super held - drag, not a click

                this._openFolder(cell.path);
                return Clutter.EVENT_STOP;
            });
        }
    }

    /**
     * @private hover-tooltip for one grid cell, showing the folder's
     * basename after a short hover delay - see widgets/launcher-big-1's
     * own _attachTooltip() for the full positioning-math writeup this is
     * copied from verbatim (same nesting depth: root -> content Bin ->
     * vertical grid -> horizontal row -> cell Bin).
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
                    style_class: 'launcher-folder-square-big-tooltip',
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

    /** @private Opens `folderPath` in the configured file manager - the
     * folder-launcher equivalent of launcher-big-1's _launchApp(), just
     * always launching the SAME app (fileManagerDesktopFile) with the
     * clicked folder as its argument, rather than a different app per
     * cell. Gio.DesktopAppInfo.launch() takes a list of Gio.File - this
     * is exactly how Nautilus (or any other file manager's .desktop
     * entry, e.g. one accepting %U/%F) expects to be told "open this
     * path", same convention GNOME's own Files-app/Nautilus integration
     * uses. */
    _openFolder(folderPath) {
        if (!folderPath)
            return;

        const desktopFile = this._settings.fileManagerDesktopFile
            ?? '/usr/share/applications/org.gnome.Nautilus.desktop';

        try {
            const appInfo = Gio.DesktopAppInfo.new_from_filename(desktopFile);
            if (!appInfo) {
                this._api.logger.info(
                    `launcher-folder-square-big: could not read file manager .desktop at ${desktopFile}`);
                return;
            }
            appInfo.launch([Gio.File.new_for_path(folderPath)], null);
        } catch (e) {
            this._api.logger.info(`launcher-folder-square-big: failed to open ${folderPath}: ${e}`);
        }
    }
}
