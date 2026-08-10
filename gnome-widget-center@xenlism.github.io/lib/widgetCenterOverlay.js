// lib/widgetCenterOverlay.js
//
// Standalone add-on: a fullscreen St/Clutter overlay ("Widget Center") shown
// on top of the desktop, toggled by a customizable global shortcut
// (default Super+F12) and/or by D-Bus (see io.github.xenlism.WidgetCenterOverlay
// .desktop). Three tabs across the top:
//   - Overview: every discovered widget (screenshot, name, description,
//     author, enable switch, Settings, Remove), in a responsive flowbox -
//     3 per row, 2 on a medium-width screen, 1 on a small one - see
//     _buildGrid()/_gridColumns() below.
//   - Themes:   every discovered theme pack (lib/themePackRegistry.js),
//     screenshot, name, description, its widget list, author, enable
//     switch, Settings - same responsive 3/2/1 flowbox, same
//     _buildGrid() call.
//   - Settings: the overlay's own shortcut, plus a launcher for the full
//     extension Preferences window.
//
// DELIBERATELY NOT wired into extension.js yet — this file, plus
// lib/themePackRegistry.js, the themepacks/ folder, the
// widget-center-overlay-keybinding schema key, and the .desktop launcher
// are all self-contained additions. See overlay-integration-example.js
// (same folder as prefs/integration-example.js's convention) for the exact
// 3-line enable()/disable() wiring to add to extension.js when you're
// ready to merge this in — kept separate on purpose so merging with
// whatever else extension.js has changed to in the meantime is a small,
// reviewable diff instead of a rewrite.
//
// Runs entirely inside the GNOME Shell process (St/Clutter/Meta/Shell are
// only available there — see prefs.js's own header for why prefs.js/
// widget-center-prefs-app.js must NEVER import any of these). Everything
// this file touches from the rest of the codebase is optional and
// injected via the `services` param (see constructor doc) — with no
// services at all it still works standalone off its own GSettings schema
// key and a plain metadata.json folder scan, same discovery contract as
// WidgetLoader.discover()/ThemePackRegistry.discover().
//
// NOT verified end-to-end on real GNOME Shell hardware yet (consistent
// with this project's other checkpoints — see development/handoff*.md) —
// the pieces most worth checking first against a real log: Main.pushModal()
// returning a Grab object vs a boolean depending on shell version, and
// whether St.ScrollView still accepts add_child() directly for its
// scrollable content on shell-version 50.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ThemePackRegistry} from './themePackRegistry.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.widget-center';
const KEYBINDING_KEY = 'widget-center-overlay-keybinding';
const DISABLED_KEY = 'disabled-widgets';
const ACTIVE_THEME_PACK_KEY = 'active-theme-pack';

// GApplication id widget-center-prefs-app.js registers itself under —
// used by _isPrefsWindow() below to recognize a spawned/re-presented
// preferences window among every other Meta.Window on the desktop, for
// the "GTK4 preferences window must render above this fullscreen St
// overlay" fix (see _launchExternalPrefsWindow()'s own doc comment for
// why that's needed at all).
const PREFS_APP_ID = 'io.github.xenlism.WidgetCenterPrefs';

// Sort modes shared by the Overview and Themes tabs' sort control (see
// _buildSortBar()) — 'name' first everywhere since it's the least
// surprising default. 'size' means "widget block footprint" on the
// Overview tab and "number of widgets in the pack" on the Themes tab —
// same label, source-appropriate meaning, see _sortEntries()'s own doc
// comment.
const SORT_MODES = [
    {id: 'name', label: 'Name', icon: 'format-justify-left-symbolic'},
    {id: 'size', label: 'Widget size', icon: 'view-grid-symbolic'},
    {id: 'mtime', label: 'Date modified', icon: 'document-open-recent-symbolic'},
];

const DBUS_NAME = 'io.github.xenlism.WidgetCenterOverlay';
const DBUS_PATH = '/io/github/xenlism/WidgetCenterOverlay';
const DBUS_IFACE_XML = `
<node>
  <interface name="io.github.xenlism.WidgetCenterOverlay">
    <method name="Toggle" />
    <method name="Open" />
    <method name="Close" />
  </interface>
</node>`;

export class WidgetCenterOverlay {
    /**
     * @param {Extension} extensionObject - the `this` from
     *   WidgetCenterExtension.enable() (needed for getSettings() and
     *   .path, same requirement as SettingsService's constructor).
     * @param {object} [services] - ALL optional; every one has a working
     *   fallback so this file never hard-depends on the rest of the
     *   codebase's internals:
     *   - widgetLoader: a WidgetLoader instance — if given, its
     *     discover() is used (matches the live desktop exactly); if not,
     *     this file does its own read-only metadata.json folder scan.
     *   - onWidgetSettings(id), onWidgetRemove(id), onOpenPreferences(),
     *     onWidgetEnabledChanged(id, enabled),
     *     onThemePackRemove(entry): hooks a real integration can use to do
     *     more than the built-in fallback (e.g. onWidgetRemove actually
     *     deleting layout/settings via StorageService, not just
     *     disabling; onThemePackRemove doing something other than a
     *     straight recursive delete of the pack's folder). NOTE
     *     (2026-08-10): `onApplyThemePack` was removed from this list —
     *     applying a theme pack is now driven entirely by the
     *     `active-theme-pack` GSettings key this file writes
     *     (`_loadThemePack()`/`_unloadThemePack()`); extension.js watches
     *     that key itself rather than being called back here.
     *   - logger: anything with a .debug(tag, msg) method (see lib/logger.js).
     */
    constructor(extensionObject, services = {}) {
        this._extension = extensionObject;
        this._path = extensionObject.path;
        this._services = services;
        this._logger = services.logger ?? null;

        this._gsettings = null;
        this._keybindingAdded = false;
        this._dbusImpl = null;
        this._ownerId = 0;

        this._overlay = null;
        this._contentBin = null;
        this._tabButtons = {};
        this._activeTab = 'overview';
        this._keyPressId = 0;
        this._modalGrab = null;

        this._themePackRegistry = null;

        // In-memory only (resets when the overlay is closed/reopened,
        // same lifetime as _activeTab) — 'name' is the default sort for
        // both tabs, see SORT_MODES above.
        this._widgetSort = 'name';
        this._themeSort = 'name';

        // Live-search text for the Overview/Themes tabs' search boxes
        // (see _buildSearchEntry()) — same in-memory-only lifetime as
        // the sort state above. Empty string means "show everything".
        this._widgetSearch = '';
        this._themeSearch = '';

        // Watcher bookkeeping for _launchExternalPrefsWindow()'s "hide
        // the overlay while a GTK4 prefs window is up, show it again
        // once that window's gone" z-order fix — see that method's doc
        // comment. Tracked so disable()/close() can clean up a
        // still-pending watcher instead of leaking a signal connection
        // or a GLib timeout source.
        this._prefsWatchCreatedId = 0;
        this._prefsWatchTimeoutId = 0;
        this._prefsWatchUnmanagedId = 0;
        this._prefsWatchWindow = null;
    }

    /** Call from the extension's enable(). Registers the shortcut + D-Bus, does not open anything. */
    enable() {
        try {
            this._gsettings = this._extension.getSettings(SCHEMA_ID);
        } catch (e) {
            console.error('[widget-center] overlay: could not resolve settings schema', e);
            return;
        }
        this._addKeybinding();
        this._exportDBus();
    }

    /** Call from the extension's disable(). Closes the overlay if open and undoes enable(). */
    disable() {
        this.close();
        this._clearPrefsWatch();
        this._removeKeybinding();
        this._unexportDBus();
        this._gsettings = null;
    }

    // --- D-Bus methods (also usable directly, e.g. from a test script) ---
    Toggle() {
        this.toggle();
    }

    Open() {
        this.open();
    }

    Close() {
        this.close();
    }

    toggle() {
        this._overlay ? this.close() : this.open();
    }

    open() {
        if (this._overlay)
            return;

        this._logger?.debug('widget-center-overlay', 'open()');
        this._buildUI();
        // `affectsInputRegion` is not a supported addChrome() parameter.
        // The reactive actor and pushModal() below already make this
        // fullscreen overlay receive input on supported Shell versions.
        Main.layoutManager.addChrome(this._overlay);

        try {
            // Grabs keyboard+pointer so Escape/clicks land here instead of
            // leaking to whatever's underneath, same idea as any other
            // fullscreen Shell UI (screenshot mode, the Overview itself).
            this._modalGrab = Main.pushModal(this._overlay);
        } catch (e) {
            console.error('[widget-center] overlay: pushModal failed, continuing non-modal', e);
            this._modalGrab = null;
        }

        this._keyPressId = global.stage.connect('key-press-event', (actor, event) => this._onStageKeyPress(event));
        this._overlay.grab_key_focus();
    }

    close() {
        if (!this._overlay)
            return;

        this._logger?.debug('widget-center-overlay', 'close()');
        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = 0;
        }
        if (this._modalGrab) {
            try {
                Main.popModal(this._modalGrab);
            } catch (e) {
                console.error('[widget-center] overlay: popModal failed', e);
            }
            this._modalGrab = null;
        }
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = null;
        this._contentBin = null;
        this._tabButtons = {};
    }

    // --- Keybinding ---------------------------------------------------

    _addKeybinding() {
        try {
            Main.wm.addKeybinding(
                KEYBINDING_KEY,
                this._gsettings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.ALL,
                () => this.toggle());
            this._keybindingAdded = true;
        } catch (e) {
            console.error('[widget-center] overlay: addKeybinding failed', e);
        }
    }

    _removeKeybinding() {
        if (!this._keybindingAdded)
            return;
        try {
            Main.wm.removeKeybinding(KEYBINDING_KEY);
        } catch (e) {
            console.error('[widget-center] overlay: removeKeybinding failed', e);
        }
        this._keybindingAdded = false;
    }

    // --- D-Bus (lets the .desktop launcher toggle the overlay) --------

    _exportDBus() {
        try {
            const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DBUS_IFACE_XML);
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(nodeInfo.interfaces[0], this);
            this._dbusImpl.export(Gio.DBus.session, DBUS_PATH);
            this._ownerId = Gio.bus_own_name(
                Gio.BusType.SESSION, DBUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
        } catch (e) {
            console.error('[widget-center] overlay: D-Bus export failed (.desktop launch won\'t work, shortcut still will)', e);
        }
    }

    _unexportDBus() {
        if (this._dbusImpl) {
            try {
                this._dbusImpl.unexport();
            } catch (e) { /* already unexported */ }
            this._dbusImpl = null;
        }
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
    }

    // --- Input ----------------------------------------------------------

    _onStageKeyPress(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    // --- UI shell: header/tabs + content area ---------------------------

    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;

        this._overlay = new St.BoxLayout({
            style_class: 'wc-overlay',
            vertical: true,
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        this._overlay.add_child(this._buildHeader());

        this._contentBin = new St.Bin({
            style_class: 'wc-overlay-content',
            x_expand: true,
            y_expand: true,
        });
        this._overlay.add_child(this._contentBin);

        this._renderTab(this._activeTab);
    }

    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'wc-overlay-header', vertical: false});

        // Center the tab strip in the header instead of it hugging the
        // left edge: tabsBox itself is sized to its own content (no
        // x_expand), flanked by two equal x_expand spacers, so BoxLayout
        // splits the leftover width evenly on both sides of it. The close
        // button stays pinned to the far right, outside this centering
        // group, matching the "tabs centered, close in the corner" layout
        // requested for the overlay (see development/handoff-2026-08-05-
        // bg-alpha-media-fix.md item 4).
        const leftSpacer = new St.Widget({x_expand: true});
        const tabsBox = new St.BoxLayout({style_class: 'wc-overlay-tabs'});
        for (const [id, label] of [['overview', 'Overview'], ['themes', 'Themes']]) {
            const button = new St.Button({
                style_class: 'wc-overlay-tab',
                label,
                can_focus: true,
                reactive: true,
            });
            button.connect('clicked', () => this._renderTab(id));
            this._tabButtons[id] = button;
            tabsBox.add_child(button);
        }
        // "Preferences" is no longer an in-overlay tab that renders
        // content into _contentBin — it's a plain click-to-open button
        // that hands straight off to the real extension Preferences
        // window (prefs.js), same launch path _openExtensionPreferences()
        // already used for the old tab's own banner/back-out link. Never
        // added to this._tabButtons (nothing to ever mark "active" for a
        // button that doesn't switch _contentBin's content), and
        // _renderTab() below no longer has a 'settings' case for the
        // same reason.
        const preferencesButton = new St.Button({
            style_class: 'wc-overlay-tab',
            label: 'Preferences',
            can_focus: true,
            reactive: true,
        });
        preferencesButton.connect('clicked', () => this._openExtensionPreferences());
        tabsBox.add_child(preferencesButton);
        const rightSpacer = new St.Widget({x_expand: true});
        header.add_child(leftSpacer);
        header.add_child(tabsBox);
        header.add_child(rightSpacer);

        const closeButton = this._buildIconButton('window-close-symbolic', () => this.close());
        closeButton.add_style_class_name('wc-overlay-close');
        header.add_child(closeButton);

        return header;
    }

    _renderTab(tab) {
        this._activeTab = tab;
        for (const [id, button] of Object.entries(this._tabButtons))
            button.set_style_class_name(id === tab ? 'wc-overlay-tab wc-overlay-tab-active' : 'wc-overlay-tab');

        let content;
        switch (tab) {
        case 'themes':
            content = this._buildThemesTab();
            break;
        case 'overview':
        default:
            content = this._buildOverviewTab();
            break;
        }
        this._contentBin.set_child(content);
    }

    // --- Tab 1: Overview (widgets) ---------------------------------------

    _buildOverviewTab() {
        const outer = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});

        // The grid lives in its own St.Bin below the toolbar so a
        // search keystroke or sort-mode click only ever swaps THIS
        // bin's child (_refreshOverviewGrid()) rather than going
        // through _renderTab('overview') and rebuilding the whole tab
        // (toolbar included) from scratch — see _buildSearchEntry()'s
        // doc comment for why that distinction matters for a live
        // "type and it filters immediately" search box specifically.
        const gridBin = new St.Bin({x_expand: true, y_expand: true});

        const bar = this._buildSortBar(
            this._widgetSort, mode => { this._widgetSort = mode; this._refreshOverviewGrid(gridBin); });
        bar.add_child(this._buildSearchEntry(
            'Search widgets…', this._widgetSearch,
            text => { this._widgetSearch = text; this._refreshOverviewGrid(gridBin); }));
        outer.add_child(bar);
        outer.add_child(gridBin);

        this._refreshOverviewGrid(gridBin);
        return outer;
    }

    /** @private (re)builds just the Overview tab's card grid into
     * `gridBin` — the sort-mode/search-text change handlers above call
     * this directly instead of _renderTab('overview') so the toolbar
     * (and, critically, the live St.Entry the user may be mid-keystroke
     * in) is never torn down and rebuilt. */
    _refreshOverviewGrid(gridBin) {
        const disabled = new Set(this._getDisabledWidgets());
        let entries = this._sortEntries(this._discoverWidgets(), this._widgetSort, {
            name: e => e.metadata?.name ?? e.id,
            size: e => this._blockSizeCells(e.metadata?.['block-type']),
            mtime: e => e.mtimeUnix ?? 0,
        });
        entries = this._filterEntries(entries, this._widgetSearch,
            e => [e.metadata?.name, e.id, e.metadata?.description]);
        gridBin.set_child(this._buildGrid(entries, entry => this._buildWidgetCard(entry, disabled)));
    }

    /** @private "2x1" -> 2 (cell count) for the Overview tab's "Widget
     * size" sort, matching whatever declares metadata.json's
     * `block-type` field (see blockSizeManager.js) — falls back to 0
     * (sorts first/smallest) for a widget with no/unparsable block-type
     * rather than throwing, since a bad metadata.json is already
     * reported elsewhere (WidgetLoader.errors) and shouldn't also break
     * sorting. */
    _blockSizeCells(blockType) {
        const match = /^(\d+)x(\d+)$/.exec(blockType ?? '');
        if (!match)
            return 0;
        return Number(match[1]) * Number(match[2]);
    }

    _buildWidgetCard(entry, disabledSet) {
        const {id, metadata, path} = entry;
        const card = new St.BoxLayout({vertical: true, style_class: 'wc-overlay-card'});

        card.add_child(this._buildScreenshot(path, metadata));
        card.add_child(new St.Label({text: metadata.name ?? id, style_class: 'wc-overlay-card-title'}));

        if (metadata.description) {
            const desc = new St.Label({text: metadata.description, style_class: 'wc-overlay-card-desc'});
            desc.clutter_text.line_wrap = true;
            card.add_child(desc);
        }
        if (metadata.author)
            card.add_child(new St.Label({text: `by ${metadata.author}`, style_class: 'wc-overlay-card-author'}));

        const controls = new St.BoxLayout({style_class: 'wc-overlay-card-controls'});
        controls.add_child(this._buildSwitch(
            !disabledSet.has(id), enabled => this._setWidgetEnabled(id, enabled)));
        controls.add_child(new St.Widget({x_expand: true}));
        controls.add_child(this._buildIconTextButton(
            'emblem-system-symbolic', 'Settings', () => this._openWidgetSettings(id)));
        // Remove button only for a widget installed under the user's own
        // folder(s) — a built-in widget bundled with the extension itself
        // has no Remove button at all, see entry.source/_discoverWidgets().
        if (entry.source === 'user') {
            controls.add_child(this._buildIconTextButton(
                'window-close-symbolic', 'Uninstall', () => this._removeWidget(id)));
        }
        card.add_child(controls);

        return card;
    }

    /** @private every directory a widget is considered "the user's own"
     * if found under — both the convention extension.js's own
     * WidgetLoader already uses (`~/.local/share/gnome-widget-center/
     * widgets`) and the `~/.config/gnome-widget-center/widgets` location
     * called out explicitly for this feature, so a widget dropped into
     * either one loses its Remove button correctly regardless of which
     * XDG base directory it ended up under. */
    _userWidgetsRoots() {
        const roots = [
            GLib.build_filenamev([GLib.get_user_data_dir(), 'gnome-widget-center', 'widgets']),
            GLib.build_filenamev([GLib.get_user_config_dir(), 'gnome-widget-center', 'widgets']),
        ];
        if (this._services.userWidgetsPath)
            roots.push(this._services.userWidgetsPath);
        return roots;
    }

    _discoverWidgets() {
        let entries;
        if (this._services.widgetLoader?.discover) {
            try {
                entries = this._services.widgetLoader.discover();
            } catch (e) {
                console.error('[widget-center] overlay: injected widgetLoader.discover() failed, falling back', e);
            }
        }
        if (!entries)
            entries = this._scanMetadataFolders(GLib.build_filenamev([this._path, 'widgets']));

        const userRoots = this._userWidgetsRoots();
        return entries.map(entry => {
            const isUser = userRoots.some(root => entry.path === root || entry.path.startsWith(`${root}/`));
            return {...entry, source: isUser ? 'user' : 'bundled', mtimeUnix: this._pathMtimeUnix(entry.path)};
        });
    }

    /** @private best-effort mtime (Unix seconds) of a file/folder, 0 on
     * any failure — used by the "Date modified" sort mode on both tabs. */
    _pathMtimeUnix(path) {
        try {
            const info = Gio.File.new_for_path(path).query_info(
                'time::modified', Gio.FileQueryInfoFlags.NONE, null);
            const dt = info.get_modification_date_time?.();
            if (dt)
                return dt.to_unix();
            return Number(info.get_attribute_uint64('time::modified')) || 0;
        } catch (e) {
            return 0;
        }
    }

    _setWidgetEnabled(id, enabled) {
        const current = new Set(this._getDisabledWidgets());
        if (enabled)
            current.delete(id);
        else
            current.add(id);
        this._writeDisabledWidgets(current);
        // A real integration's extension.js already watches
        // `changed::disabled-widgets` (see its file header) and will load/
        // unload the widget itself from that signal — this hook is only
        // for anything extra an integration wants to do (e.g. logging).
        this._services.onWidgetEnabledChanged?.(id, enabled);
    }

    _openWidgetSettings(id) {
        if (this._services.onWidgetSettings) {
            this._services.onWidgetSettings(id);
            return;
        }
        // Same subprocess pattern as extension.js's own
        // _openWidgetSettings() — spawns the standalone prefs app
        // (widget-center-prefs-app.js) deep-linked to this widget. Routed
        // through _launchExternalPrefsWindow() (rather than a bare
        // Gio.Subprocess.new()) so the resulting GTK4 window actually
        // renders above this overlay instead of behind it — see that
        // method's doc comment.
        this._launchExternalPrefsWindow([`--widget-id=${id}`]);
    }

    _removeWidget(id) {
        if (this._services.onWidgetRemove) {
            this._services.onWidgetRemove(id);
            this._renderTab(this._activeTab);
            return;
        }
        // No StorageService/WidgetLayer reference here by design (this
        // file stays decoupled) — the fallback just disables the widget.
        // Pass onWidgetRemove in `services` for a real delete-from-disk
        // removal like Edit Mode's own Remove button.
        this._setWidgetEnabled(id, false);
        this._renderTab(this._activeTab);
    }

    // --- Tab 2: Themes (theme packs) -------------------------------------

    _buildThemesTab() {
        const outer = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true});

        // Same "grid gets its own bin so search/sort don't rebuild the
        // toolbar" reasoning as _buildOverviewTab()'s gridBin above.
        const gridBin = new St.Bin({x_expand: true, y_expand: true});

        const bar = this._buildSortBar(
            this._themeSort, mode => { this._themeSort = mode; this._refreshThemesGrid(gridBin); });
        
        // "Export current desktop…" — blank-form export (no prefill),
        // the tab-level counterpart to each card's own Export button
        // above. Routed through the same --export-theme-new flag
        // themePackExportDialog.js's own header comment already
        // documents as one of its two entry points; this button, not
        // the dialog or the flag, was the missing piece.
         bar.add_child(this._buildIconTextButton(
            'emblem-shared-symbolic', 'Share desktop',
            () => this._launchExternalPrefsWindow(['--export-theme-new'])));
        bar.add_child(this._buildSearchEntry(
            'Search themes…', this._themeSearch,
            text => { this._themeSearch = text; this._refreshThemesGrid(gridBin); }));
        outer.add_child(bar);
        outer.add_child(gridBin);

        this._refreshThemesGrid(gridBin);
        return outer;
    }

    /** @private (re)builds just the Themes tab's card grid into
     * `gridBin` — see _refreshOverviewGrid()'s matching doc comment. */
    _refreshThemesGrid(gridBin) {
        let entries = this._sortEntries(this._discoverThemePacks(), this._themeSort, {
            name: e => e.manifest?.name ?? e.id,
            size: e => e.widgetCount ?? (e.manifest?.widgets?.length ?? 0),
            mtime: e => e.mtimeUnix ?? 0,
        });
        entries = this._filterEntries(entries, this._themeSearch,
            e => [e.manifest?.name, e.id, e.manifest?.description]);
        gridBin.set_child(this._buildGrid(entries, entry => this._buildThemePackCard(entry)));
    }

    /** @private every directory a theme pack is considered "the user's
     * own" if found under — see _userWidgetsRoots()'s matching doc
     * comment; same reasoning, `~/.config/gnome-widget-center/themepacks`
     * is the location called out explicitly for this feature. */
    _userThemepacksRoots() {
        const roots = [
            GLib.build_filenamev([GLib.get_user_config_dir(), 'gnome-widget-center', 'themepacks']),
        ];
        if (this._services.userThemepacksPath)
            roots.push(this._services.userThemepacksPath);
        return roots;
    }

    _discoverThemePacks() {
        const bundledPath = GLib.build_filenamev([this._path, 'themepacks']);
        const searchPaths = [
            {path: bundledPath, source: 'bundled'},
            ...this._userThemepacksRoots().map(path => ({path, source: 'user'})),
        ];
        // Rebuilt every call (search paths never change after
        // construction) rather than cached across the overlay's whole
        // lifetime — cheap directory scan, and always reflects a pack
        // dropped in/removed from disk between two tab renders without
        // needing an explicit invalidation call from _removeThemePack()/
        // the export flow.
        this._themePackRegistry = new ThemePackRegistry(searchPaths);
        return this._themePackRegistry.discover();
    }

    _buildThemePackCard(entry) {
        const {id, path, manifest} = entry;
        const card = new St.BoxLayout({vertical: true, style_class: 'wc-overlay-card'});

        card.add_child(this._buildScreenshot(path, manifest));
        card.add_child(new St.Label({text: manifest.name ?? id, style_class: 'wc-overlay-card-title'}));

        if (manifest.description) {
            const desc = new St.Label({text: manifest.description, style_class: 'wc-overlay-card-desc'});
            desc.clutter_text.line_wrap = true;
            card.add_child(desc);
        }

        if (manifest.author)
            card.add_child(new St.Label({text: `by ${manifest.author}`, style_class: 'wc-overlay-card-author'}));

        const controls = new St.BoxLayout({style_class: 'wc-overlay-card-controls'});
        // 2026-08-10 ask: the separate "Apply" button + read-only status
        // switch are now ONE interactive switch - see _buildThemeToggle()'s
        // own doc comment for what turning it on/off actually does.
        controls.add_child(this._buildThemeToggle(entry));
        controls.add_child(new St.Widget({x_expand: true}));
        // Export re-opens this pack's own themePackExportDialog.js
        // prefilled with its manifest (name/description/author/url/
        // widgets) via the --export-theme-id= flag — see
        // widget-center-prefs-app.js's own doc comment for why this has
        // to be a spawned GTK4 process rather than an in-overlay dialog
        // (this file is St/Clutter-only). The dialog itself, and this
        // CLI flag, both already existed — this button, the only thing
        // that was actually missing, is the 2026-08-09 fix.
        controls.add_child(this._buildIconTextButton(
            'emblem-shared-symbolic', 'Share', () => this._exportThemePack(entry)));
        // Remove button only for a pack under the user's own themepacks
        // folder(s) — a pack bundled with the extension itself has no
        // Remove button at all, see entry.source/_discoverThemePacks().
        // Icon + "Uninstall" text (2026-08-08 ask) rather than icon-only,
        // since this deletes the pack's files off disk (see
        // _removeThemePack()'s own doc comment) and deserves a clearer
        // label than a bare X.
        if (entry.source === 'user') {
            controls.add_child(this._buildIconTextButton(
                'user-trash-symbolic', 'Uninstall', () => this._removeThemePack(entry)));
        }
        card.add_child(controls);
        return card;
    }

    _isThemePackEnabled(id) {
        try {
            return this._gsettings.get_string(ACTIVE_THEME_PACK_KEY) === id;
        } catch (e) {
            return false;
        }
    }

    /** @private Turns this pack ON — the interactive switch's ONLY job
     * now is to write `active-theme-pack` (see _buildThemeToggle()).
     * Everything this method used to do by hand (pre-touching
     * `disabled-widgets` for the pack's widget list, then calling
     * `onApplyThemePack`) is now done ONCE, uniformly, by extension.js's
     * own `active-theme-pack` watcher (`_applyActiveThemePack()`) —
     * whether this write came from here or from the separate prefs
     * process's own theme card switch. Doing it here too used to race
     * that watcher's own disabled-widgets write and, for a flat .gwct
     * pack, never actually moved an already-placed widget to its new
     * saved position — see that method's doc comment for the full
     * 2026-08-10 fix this simplification is part of. */
    _loadThemePack(entry) {
        try {
            this._gsettings.set_string(ACTIVE_THEME_PACK_KEY, entry.id);
            Gio.Settings.sync();
        } catch (e) {
            console.error('[widget-center] overlay: could not save active theme pack', e);
        }
        this._renderTab('themes');
    }

    /** @private Turns the currently-active pack OFF — just clears the
     * marker, it never undoes what the theme placed (which widgets it
     * enabled/positioned may since have been independently changed by
     * the user, so "undo" isn't well-defined here — see
     * _buildThemeToggle()'s own doc comment). */
    _unloadThemePack() {
        try {
            this._gsettings.set_string(ACTIVE_THEME_PACK_KEY, '');
            Gio.Settings.sync();
        } catch (e) {
            console.error('[widget-center] overlay: could not clear active theme pack', e);
        }
        this._renderTab('themes');
    }

    /** @private Opens themePackExportDialog.js (GTK4/libadwaita, a
     * separate spawned process — see _launchExternalPrefsWindow()'s doc
     * comment for why) prefilled with this pack's own manifest, via the
     * `--export-theme-id=` flag widget-center-prefs-app.js already
     * parses and prefsWindowControllerBase.js already routes to
     * openThemePackExportDialog() with. This is the entry point that
     * was missing — the dialog and the flag both already existed. */
    _exportThemePack(entry) {
        this._launchExternalPrefsWindow([`--export-theme-id=${entry.id}`]);
    }

    _openThemePackSettings(id) {
        if (this._services.onThemePackSettings) {
            this._services.onThemePackSettings(id);
            return;
        }
        this._openExtensionPreferences();
    }

    /**
     * Remove a theme pack. Prefer `services.onThemePackRemove(entry)` if
     * given (e.g. a real integration that wants to confirm with the user
     * first, or log it) — otherwise falls back to deleting the pack's
     * folder/file straight off disk (`<themepacks>/<id>/` or
     * `<themepacks>/<name>.gwct`, see entry.path — ThemePackRegistry
     * discovers both shapes now, see that file's header), since unlike a
     * bundled widget (see `_removeWidget()`'s fallback, which only
     * disables rather than deletes) a theme pack is just something the
     * user or a prior session dropped into their own themepacks/
     * themselves — there's nothing else referencing it that a straight
     * delete could leave dangling. Only ever wired to a Remove button for
     * a `source: 'user'` entry in the first place (_buildThemePackCard()),
     * so this never runs against a bundled pack.
     */
    _removeThemePack(entry) {
        if (this._services.onThemePackRemove) {
            this._services.onThemePackRemove(entry);
            this._themePackRegistry = null;
            this._renderTab(this._activeTab);
            return;
        }
        try {
            const target = Gio.File.new_for_path(entry.path);
            const info = target.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                this._deleteRecursive(target);
            else
                target.delete(null);
        } catch (e) {
            console.error(`[widget-center] overlay: could not remove theme pack "${entry.id}"`, e);
        }
        this._themePackRegistry = null;
        this._renderTab(this._activeTab);
    }

    /** @private Recursively deletes a Gio.File directory (or a single
     * file) — Gio.File has no built-in recursive delete, and
     * `delete_finish()`/`delete(null)` only removes an already-empty
     * directory. */
    _deleteRecursive(file) {
        const info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const enumerator = file.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let child;
            while ((child = enumerator.next_file(null)) !== null)
                this._deleteRecursive(file.get_child(child.get_name()));
        }
        file.delete(null);
    }

    // --- Preferences ---------------------------------------------------

    // 2026-08-08: the overlay no longer hosts a reimplemented Preferences
    // tab in-place (see _buildHeader()'s doc comment on the Preferences
    // button) — clicking "Preferences" now always hands off to the real
    // extension Preferences window below instead.
    _openExtensionPreferences() {
        if (this._services.onOpenPreferences) {
            this._services.onOpenPreferences();
            return;
        }
        // --focus=preferences (widget-center-prefs-app.js +
        // PrefsWindowController.showPreferencesPage()): lands on the
        // Preferences tab directly instead of Overview, since this
        // overlay's own Overview tab already covers that ground
        // natively. Routed through _launchExternalPrefsWindow() for the
        // z-index-over-overlay fix — see that method's doc comment.
        this._launchExternalPrefsWindow(['--focus=preferences']);
    }

    // --- Sorting (shared by the Overview and Themes tabs) -----------------

    /** @private a small St row of buttons, one per SORT_MODES entry,
     * highlighting whichever is `currentMode` — deliberately plain
     * buttons rather than a dropdown/combo (St has no native dropdown
     * widget) so this stays a simple, obviously-correct
     * St.Button loop instead of hand-rolling a popup menu for something
     * with only three options.
     * @param {string} currentMode - one of SORT_MODES' `id`s.
     * @param {(mode: string) => void} onChange
     * @returns {St.BoxLayout} - callers may add_child() more controls
     *   onto this same row (see _buildThemesTab()'s Export button).
     */
    /** @private the exact pixel width of the card grid's own content
     * (not the wider scroll viewport it's centered in) - `N` columns of
     * `.wc-overlay-card`'s fixed 480px width plus `(N-1)` lots of the
     * grid row's 16px spacing, matching `.wc-overlay-row`'s actual laid-
     * out width exactly (see `_gridColumns()`'s doc comment for the same
     * 480/16/columns numbers). Used to size the sort/search bar above
     * the grid to the SAME width, instead of it stretching edge-to-edge
     * across the whole overlay - see `_buildSortBar()`. */
    _gridContentWidth() {
        const columns = this._gridColumns();
        return columns * 480 + (columns - 1) * 16;
    }

    _buildSortBar(currentMode, onChange) {
        // 2026-08-09 (handover v3): fixed to `_gridContentWidth()` and
        // centered, rather than `x_expand: true` - the grid below it is
        // centered at a fixed columns*480+gaps width too (see
        // `_buildGrid()`), so an edge-to-edge bar no longer sat flush
        // with the actual card area on any monitor wider than that
        // (user report: "bar width vs card area width mismatch").
        const bar = new St.BoxLayout({
            style_class: 'wc-overlay-sortbar',
            width: this._gridContentWidth(),
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER,
        });
        for (const mode of SORT_MODES) {
            const button = new St.Button({
                style_class: mode.id === currentMode ? 'wc-overlay-tab wc-overlay-tab-active' : 'wc-overlay-tab',
                can_focus: true, reactive: true, accessible_name: `Sort by ${mode.label}`,
            });
            button.set_child(new St.Icon({icon_name: mode.icon, icon_size: 16}));
            button.connect('clicked', () => onChange(mode.id));
            bar.add_child(button);
        }
        bar.add_child(new St.Widget({x_expand: true}));
        return bar;
    }

    /** @private Sorts a copy of `entries` by `mode` using `keyFns[mode]`
     * to extract a comparable value from each entry — `keyFns` is
     * per-tab (see _buildOverviewTab()'s vs _buildThemesTab()'s calls)
     * since "size" means something different for a widget (its block
     * footprint) than for a theme pack (how many widgets it bundles),
     * even though both share the same `SORT_MODES` control/labels.
     * String keys sort case-insensitively; everything else sorts
     * numerically descending for 'mtime' (newest first — the useful
     * order for "date modified") and ascending otherwise.
     * @param {Array} entries
     * @param {string} mode
     * @param {{name: Function, size: Function, mtime: Function}} keyFns
     */
    _sortEntries(entries, mode, keyFns) {
        const keyFn = keyFns[mode] ?? keyFns.name;
        const sorted = [...entries];
        sorted.sort((a, b) => {
            const ka = keyFn(a);
            const kb = keyFn(b);
            if (typeof ka === 'string' || typeof kb === 'string')
                return String(ka).localeCompare(String(kb));
            return mode === 'mtime' ? kb - ka : ka - kb;
        });
        return sorted;
    }

    // --- Search (shared by the Overview and Themes tabs) ------------------

    /** @private A single-line St.Entry styled/behaving like GNOME
     * Shell's own search boxes (hint text shown when empty+unfocused,
     * filters live via 'text-changed' — applying on every keystroke,
     * rather than only on 'key-focus-out'/Enter, since "พิมพ์แล้วแสดงผลเลย" (results
     * update as you type) was the explicit ask this was built for).
     * Deliberately a small fixed width, not x_expand — this is meant to
     * sit at the right-hand end of a _buildSortBar() row (which already
     * ends in its own x_expand spacer pushing everything after it all
     * the way right), not stretch to fill the whole row itself.
     * @param {string} hintText
     * @param {string} initialText - seeds the entry so a tab that gets
     *   rebuilt for an unrelated reason (e.g. a widget Remove) doesn't
     *   silently lose whatever the user had already typed.
     * @param {(text: string) => void} onChange
     * @returns {St.Entry}
     */
    _buildSearchEntry(hintText, initialText, onChange) {
        const entry = new St.Entry({
            style_class: 'wc-overlay-search',
            hint_text: hintText,
            can_focus: true,
            reactive: true,
            x_expand: false,
            width: 220,
        });
        entry.set_primary_icon(new St.Icon({icon_name: 'edit-find-symbolic', icon_size: 14}));
        if (initialText)
            entry.set_text(initialText);
        entry.clutter_text.connect('text-changed', () => onChange(entry.get_text()));
        return entry;
    }

    /** @private Case-insensitive substring filter shared by the
     * Overview/Themes search boxes. `fieldsFn(entry)` returns the
     * fields to match against (name/id/description, ...) — any one
     * matching is enough. A blank/whitespace-only query matches
     * everything (same "empty search box = no filtering" convention
     * every search box in this project's own config-field lists
     * follows).
     * @param {Array} entries
     * @param {string} query
     * @param {(entry) => Array<string>} fieldsFn
     */
    _filterEntries(entries, query, fieldsFn) {
        const q = (query ?? '').trim().toLowerCase();
        if (!q)
            return entries;
        return entries.filter(entry =>
            fieldsFn(entry).some(field => String(field ?? '').toLowerCase().includes(q)));
    }

    // --- External GTK4 windows: z-index-over-overlay fix -------------------

    /**
     * Spawns widget-center-prefs-app.js with `args` (or re-presents its
     * already-running single instance — see that file's own header for
     * the GApplication single-instance handoff) and makes sure the
     * resulting GTK4/libadwaita window actually ends up VISIBLE to the
     * user instead of hidden behind this overlay.
     *
     * Why that's a real problem, not a hypothetical one: this overlay is
     * Shell chrome (`Main.layoutManager.addChrome()`, see open()) —
     * chrome actors are added to `Main.layoutManager.uiGroup`, which
     * paints above `global.window_group` (every normal application
     * window, GTK4 prefs windows included) by construction, the same way
     * the Activities overview or a modal dialog from the Shell itself
     * sits above ordinary windows. A `gjs`-spawned Adw.PreferencesWindow
     * is just another normal window as far as Mutter's stacking is
     * concerned, so without this fix it opens successfully but renders
     * completely hidden behind this overlay's own full-monitor St
     * actor — clicking Settings/Export/Backup would appear to do
     * nothing.
     *
     * Fix: hide (not destroy) this overlay's own actor for as long as
     * the external window is open, so there's nothing left for it to be
     * hidden behind, then show it again once that window closes.
     * `Meta.Window.make_above()` is applied too as defense in depth (in
     * case some Shell version's chrome layering differs from the above),
     * but the hide/show is the part actually guaranteed to work
     * regardless of Mutter internals.
     * @param {string[]} args - argv appended to the `gjs -m` invocation.
     */
    _launchExternalPrefsWindow(args) {
        const scriptPath = GLib.build_filenamev([this._path, 'widget-center-prefs-app.js']);
        try {
            Gio.Subprocess.new(['gjs', '-m', scriptPath, ...args], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error('[widget-center] overlay: could not launch the external prefs window', e);
            return;
        }
        // 2026-08-09 (handover v5): closes the overlay outright now,
        // instead of hide()-ing it and re-show()-ing it once the spawned
        // prefs window closes again - user ask ("close the overlay when
        // clicking Preferences", not "hide it and bring it back later").
        // _watchForExternalPrefsWindow() below still runs, purely for its
        // make_above()/activate() half (still needed - see that
        // method's own doc comment on why a spawned window can render
        // hidden behind Shell chrome without it); it just has nothing to
        // re-show anymore since `close()` already tore the overlay down.
        this.close();
        this._watchForExternalPrefsWindow();
    }

    /** @private true if `metaWindow` looks like widget-center-prefs-app.js's
     * own window — checked via the GTK application id first (reliable
     * under both X11 and Wayland, unlike WM_CLASS which Wayland clients
     * don't always set usefully) with a WM_CLASS substring match as a
     * fallback for older Shell/Mutter versions that don't expose
     * get_gtk_application_id(). */
    _isPrefsWindow(metaWindow) {
        try {
            if (metaWindow.get_gtk_application_id?.() === PREFS_APP_ID)
                return true;
        } catch (e) { /* not available on this Shell version */ }
        try {
            const wmClass = metaWindow.get_wm_class?.();
            if (wmClass && wmClass.toLowerCase().includes('widgetcenterprefs'))
                return true;
        } catch (e) { /* ignore */ }
        return false;
    }

    /** @private Finds the prefs window (already-mapped, for the
     * single-instance-re-present case — see widget-center-prefs-app.js's
     * header for why a second launch doesn't create a new Meta.Window at
     * all — or freshly created, for a first launch this session),
     * `make_above()`s it, and re-shows this overlay once it's unmanaged
     * (closed). Gives up after 10s if no matching window ever turns up
     * (e.g. `gjs` missing) so this never leaks a dangling
     * `window-created` connection or leaves the overlay permanently
     * hidden. */
    _watchForExternalPrefsWindow() {
        this._clearPrefsWatch();

        const attach = metaWindow => {
            this._clearPrefsWatch();
            try {
                metaWindow.make_above();
                metaWindow.activate(global.get_current_time());
            } catch (e) { /* best effort */ }
            this._prefsWatchWindow = metaWindow;
            this._prefsWatchUnmanagedId = metaWindow.connect('unmanaged', () => {
                this._prefsWatchUnmanagedId = 0;
                this._prefsWatchWindow = null;
                this._overlay?.show();
            });
        };

        for (const actor of global.get_window_actors()) {
            const metaWindow = actor.get_meta_window();
            if (metaWindow && this._isPrefsWindow(metaWindow)) {
                attach(metaWindow);
                return;
            }
        }

        this._prefsWatchCreatedId = global.display.connect('window-created', (display, metaWindow) => {
            if (!this._isPrefsWindow(metaWindow))
                return;
            attach(metaWindow);
        });
        this._prefsWatchTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._prefsWatchTimeoutId = 0;
            if (this._prefsWatchCreatedId) {
                global.display.disconnect(this._prefsWatchCreatedId);
                this._prefsWatchCreatedId = 0;
                // No window ever showed up - don't leave the overlay
                // hidden forever over a launch that silently failed.
                this._overlay?.show();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** @private tears down whatever _watchForExternalPrefsWindow() left
     * connected/scheduled — called both when a watch resolves normally
     * (attach()) and from disable(), so a Shell restart/extension
     * disable while a prefs window watch is still pending can't leak a
     * signal connection or GLib timeout source. */
    _clearPrefsWatch() {
        if (this._prefsWatchCreatedId) {
            global.display.disconnect(this._prefsWatchCreatedId);
            this._prefsWatchCreatedId = 0;
        }
        if (this._prefsWatchTimeoutId) {
            GLib.source_remove(this._prefsWatchTimeoutId);
            this._prefsWatchTimeoutId = 0;
        }
        if (this._prefsWatchWindow && this._prefsWatchUnmanagedId) {
            try {
                this._prefsWatchWindow.disconnect(this._prefsWatchUnmanagedId);
            } catch (e) { /* window may already be gone */ }
        }
        this._prefsWatchUnmanagedId = 0;
        this._prefsWatchWindow = null;
    }

    // --- Shared small-widget helpers --------------------------------------

    _buildGrid(entries, buildCard) {
        const scroll = new St.ScrollView({
            style_class: 'wc-overlay-scroll', x_expand: true, y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER,
        });
        // vertical BoxLayout, not x_expand: its own width is just
        // "widest row", so it needs x_align: CENTER to sit in the middle
        // of the (wider) scroll viewport instead of hugging the left
        // edge — same fix as _buildHeader()'s tab strip, see the comment
        // there. Each row gets it too, so a short last row (fewer cards
        // than `columns`) centers on its own rather than sitting left
        // under a full row above it.
        const box = new St.BoxLayout({
            vertical: true, style_class: 'wc-overlay-grid', x_align: Clutter.ActorAlign.CENTER,
        });

        const columns = this._gridColumns();
        for (let i = 0; i < entries.length; i += columns) {
            const row = new St.BoxLayout({style_class: 'wc-overlay-row', x_align: Clutter.ActorAlign.CENTER});
            for (let c = 0; c < columns; c++) {
                if (entries[i + c])
                    row.add_child(buildCard(entries[i + c]));
            }
            box.add_child(row);
        }

        if (entries.length === 0) {
            box.add_child(new St.Label({
                text: 'Nothing here yet.', style_class: 'wc-overlay-empty',
            }));
        }

        scroll.add_child(box);
        return scroll;
    }

    /** @private Flowbox-style column count shared by the Overview and
     * Themes tabs' _buildGrid() call - 3 per row, dropping to 2 then 1 on
     * a smaller screen. Each `.wc-overlay-card` is a fixed 480px
     * (stylesheet.css) with 16px spacing between cards (`.wc-overlay-row`)
     * and the content area's own 24px+24px side padding
     * (`.wc-overlay-content`), so N columns needs
     * `N*480 + (N-1)*16 + 48` px of monitor width to comfortably fit
     * without any card getting clipped or forced to wrap oddly -
     * thresholds below round that up with some breathing room rather
     * than cutting exactly at the fitting width.
     *
     * Computed from `Main.layoutManager.primaryMonitor` - the same
     * monitor `_buildUI()` already sizes the whole overlay to - rather
     * than from this actor's own allocation at layout time: this
     * codebase has already been bitten once by allocation-timing bugs
     * (see blockSizeManager.js's file header for the history), and the
     * overlay is rebuilt fresh on every open and every tab switch
     * anyway (`_renderTab()` throws the old content away and calls
     * `_buildGrid()` again), so a monitor-width snapshot taken at build
     * time is simpler than a live resize listener and just as correct
     * for this UI's actual lifecycle. */
    _gridColumns() {
        const width = Main.layoutManager.primaryMonitor?.width ?? 1920;
        if (width >= 1600)
            return 3;
        if (width >= 1100)
            return 2;
        return 1;
    }

            _buildScreenshot(basePath, metadataOrManifest) {
        const shotPath = this._resolveScreenshot(basePath, metadataOrManifest);
        const bin = new St.Bin({style_class: 'wc-overlay-card-screenshot', x_expand: true});

        let uri = null;
        if (shotPath) {
            uri = Gio.File.new_for_path(shotPath).get_uri();
        } else {
            // Fallback: show an icon if no screenshot is available
            bin.set_child(new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                icon_size: 48,
                style_class: 'wc-overlay-card-screenshot-fallback',
            }));
        }

        // 1. Set initial aspect ratio to 3:1 (using default width of 456px)
        // Height is calculated as 456 / 3 = 152px (applies to both image and fallback cases)
        const initialWidth = 456;
        const initialHeight = Math.round(initialWidth / 3);
        bin.height = initialHeight;
        
        if (shotPath) {
            bin.set_style(this._coverBackgroundStyle(shotPath, uri, initialWidth, initialHeight));
        }

        // 2. Listen for card allocation changes (e.g., when screen resizes or card width changes)
        // to update the height while maintaining a 3:1 aspect ratio (for both cases)
        bin.connect('notify::allocation', () => {
            const actualWidth = bin.allocation.get_width();
            if (actualWidth > 0 && bin._lastWidth !== actualWidth) {
                bin._lastWidth = actualWidth;
                
                // Calculate new height to maintain 3:1 aspect ratio
                const actualHeight = Math.round(actualWidth / 3);
                
                // Force update height only (width follows the card)
                bin.height = actualHeight;
                
                // If a screenshot exists, update the background crop style to match new dimensions
                if (shotPath) {
                    bin.set_style(this._coverBackgroundStyle(shotPath, uri, actualWidth, actualHeight));
                }
            }
        });

        return bin;
    }

    /**
     * @private Builds a `background-image`/`background-size`/
     * `background-position` style string that crops (never stretches) a
     * source image to fill a `boxWidth`x`boxHeight` box - manual
     * replacement for CSS `background-size: cover; background-position:
     * center`, which St's CSS parser doesn't understand (see
     * `_buildScreenshot()`'s own comment on why).
     * @param {string} shotPath - on-disk path (for GdkPixbuf.Pixbuf.
     *   get_file_info(), which reads just the header, not the full image,
     *   to get the source's real pixel dimensions).
     * @param {string} uri - `file://` URI for the same path, for the CSS
     *   `background-image: url(...)` declaration itself.
     * @param {number} boxWidth
     * @param {number} boxHeight
     * @returns {string}
     */
    _coverBackgroundStyle(shotPath, uri, boxWidth, boxHeight) {
        const fallback =
            `background-image: url("${uri}"); background-size: ${boxWidth}px ${boxHeight}px; background-position: 0px 0px;`;

        let width, height;
        try {
            [, width, height] = GdkPixbuf.Pixbuf.get_file_info(shotPath);
        } catch (e) {
            console.warn(`[widget-center] could not read screenshot dimensions for "${shotPath}", falling back to a stretched fit`, e);
        }
        if (!width || !height)
            return fallback; // couldn't identify the image - same stretched fallback this method replaces

        // Scale UP only (never down) by whichever axis needs more growth
        // to fully cover the box - the smaller-overflow axis then hangs
        // over the box edge, which background-position below centers and
        // St's own clipping on the St.Bin (a plain widget, clips its
        // background to its allocated box like any other) crops away.
        const scale = Math.max(boxWidth / width, boxHeight / height);
        const scaledWidth = Math.ceil(width * scale);
        const scaledHeight = Math.ceil(height * scale);

        // Center the overflow: whichever axis grew past the box gets a
        // negative offset of half the overflow, pulling the image back so
        // its center - not its top-left corner - lands in the box center.
        const offsetX = -Math.round((scaledWidth - boxWidth) / 2);
        const offsetY = -Math.round((scaledHeight - boxHeight) / 2);

        return `background-image: url("${uri}"); background-size: ${scaledWidth}px ${scaledHeight}px; background-position: ${offsetX}px ${offsetY}px;`;
    }

    _resolveScreenshot(basePath, metadataOrManifest) {
        // Flat .gwct theme packs (see themePackRegistry.js's file header)
        // embed the screenshot as base64 rather than a relative file on
        // disk — decode it once into a cache file and reuse that path,
        // rather than re-decoding on every render of the Themes tab.
        if (metadataOrManifest?.screenshotBase64)
            return this._decodedScreenshotCachePath(metadataOrManifest);

        const relative = metadataOrManifest?.screenshot;
        if (!relative)
            return null;
        const path = GLib.build_filenamev([basePath, relative]);
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }

    /** @private Decodes `manifest.screenshotBase64` to
     * `~/.cache/gnome-widget-center/thumbnails/<id>.<ext>` and returns
     * that path, reusing an already-decoded file instead of rewriting it
     * every time a card is rebuilt (e.g. from a sort-mode change) —
     * keyed by the pack's own id, so a re-exported pack with the same id
     * but a new screenshot naturally overwrites the stale cached file. */
    _decodedScreenshotCachePath(manifest) {
        const ext = (manifest.screenshotMime ?? '').includes('png') ? 'png'
            : (manifest.screenshotMime ?? '').includes('webp') ? 'webp' : 'jpg';
        const cacheDir = GLib.build_filenamev([GLib.get_user_cache_dir(), 'gnome-widget-center', 'thumbnails']);
        const cachePath = GLib.build_filenamev([cacheDir, `${manifest.id}.${ext}`]);

        if (GLib.file_test(cachePath, GLib.FileTest.EXISTS))
            return cachePath;

        try {
            GLib.mkdir_with_parents(cacheDir, 0o755);
            const bytes = GLib.base64_decode(manifest.screenshotBase64);
            GLib.file_set_contents(cachePath, bytes);
            return cachePath;
        } catch (e) {
            console.error(`[widget-center] overlay: could not decode screenshot for "${manifest.id}"`, e);
            return null;
        }
    }

    /**
     * Shared on/off switch — St.Button(toggle_mode:true) + a "knob"
     * child, reused (rather than duplicated) so the widget-enable control
     * (Overview tab) and the theme-active toggle (Themes tab, see
     * `_buildThemeToggle()` below) render as the exact same visual
     * switch. Pass `onChange: null` for a read-only/informational switch
     * — `sensitive: false` then blocks both the click and the `:hover`/
     * `:active` CSS states, matching a genuinely disabled control rather
     * than a clickable-looking one that silently does nothing.
     * @param {boolean} initialOn
     * @param {?function(boolean):void} onChange - null for a read-only switch
     */
    _buildSwitch(initialOn, onChange) {
        const readOnly = !onChange;
        const button = new St.Button({
            style_class: 'wc-pref-switch',
            toggle_mode: !readOnly,
            checked: !!initialOn,
            can_focus: !readOnly,
            reactive: !readOnly,
            opacity: readOnly ? 200 : 255,
        });
        button.add_child(new St.Widget({style_class: 'wc-pref-switch-knob'}));
        if (!readOnly)
            button.connect('notify::checked', () => onChange(button.checked));
        return button;
    }

    /** @private Interactive on/off switch for a theme pack card —
     * 2026-08-10 ask: replaces the old separate "Apply" button + this
     * same read-only status switch with ONE control that both shows and
     * drives whether this pack is the active theme. Turning ON just
     * calls `_loadThemePack()` (writes `active-theme-pack`, see that
     * method's own doc comment for what actually applying it now does).
     * Turning OFF calls `_unloadThemePack()` (clears the marker only —
     * never unloads whatever the theme most recently placed, since
     * "undo everything a theme did" isn't well-defined and was never
     * asked for). Only one pack is ever active, so flipping one card's
     * switch on always leaves every other card's switch reading off on
     * the next render — `_isThemePackEnabled()` comparing every card
     * against the single `active-theme-pack` value already gives this
     * "mutually exclusive" behavior for free, no extra bookkeeping
     * needed here. */
    _buildThemeToggle(entry) {
        const toggle = this._buildSwitch(this._isThemePackEnabled(entry.id), on => {
            if (on)
                this._loadThemePack(entry);
            else
                this._unloadThemePack();
        });
        toggle.accessible_name = this._isThemePackEnabled(entry.id)
            ? `${entry.manifest?.name ?? entry.id} — active`
            : `${entry.manifest?.name ?? entry.id} — not loaded`;
        return toggle;
    }

    _buildIconButton(iconName, callback) {
        const button = new St.Button({style_class: 'wc-overlay-icon-button', can_focus: true, reactive: true});
        button.set_child(new St.Icon({icon_name: iconName, icon_size: 16}));
        button.connect('clicked', callback);
        return button;
    }

    /** @private icon + text button — used where an icon-only button
     * (`_buildIconButton()` above) isn't clear enough on its own, e.g.
     * a destructive "Uninstall" action that should say so, not just show
     * an X. Same `wc-overlay-icon-button` base style plus a label, so it
     * still matches the rest of this card's chrome. */
    _buildIconTextButton(iconName, text, callback) {
        const button = new St.Button({
            style_class: 'wc-overlay-icon-button wc-overlay-icon-text-button',
            can_focus: true,
            reactive: true,
            accessible_name: text,
        });
        const box = new St.BoxLayout();
        box.add_child(new St.Icon({icon_name: iconName, icon_size: 16}));
        box.add_child(new St.Label({text}));
        button.set_child(box);
        button.connect('clicked', callback);
        return button;
    }

    // --- disabled-widgets (shared GSettings key with the rest of the extension) ---

    _getDisabledWidgets() {
        try {
            return this._gsettings.get_strv(DISABLED_KEY);
        } catch (e) {
            return [];
        }
    }

    _writeDisabledWidgets(idSet) {
        try {
            this._gsettings.set_strv(DISABLED_KEY, [...idSet]);
            Gio.Settings.sync();
        } catch (e) {
            console.error('[widget-center] overlay: could not write disabled-widgets', e);
        }
    }

    _scanMetadataFolders(root) {
        const results = [];
        const dir = Gio.File.new_for_path(root);
        if (!dir.query_exists(null))
            return results;

        let enumerator;
        try {
            enumerator = dir.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return results;
        }

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY)
                continue;
            const name = info.get_name();
            if (name.startsWith('_'))
                continue;

            const folder = dir.get_child(name);
            const path = folder.get_path();
            const metadataFile = folder.get_child('metadata.json');
            if (!metadataFile.query_exists(null))
                continue;

            try {
                const [ok, contents] = metadataFile.load_contents(null);
                if (!ok)
                    continue;
                const metadata = JSON.parse(new TextDecoder('utf-8').decode(contents));
                results.push({id: metadata.id ?? name, metadata, path});
            } catch (e) {
                console.error(`[widget-center] overlay: could not read ${path}/metadata.json`, e);
            }
        }
        return results;
    }
}
