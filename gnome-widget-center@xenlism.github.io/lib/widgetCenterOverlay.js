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
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ThemePackRegistry} from './themePackRegistry.js';
import {buildOverlayPreferencesContent} from './widgetCenterOverlayPreferences.js';

const SCHEMA_ID = 'org.gnome.shell.extensions.widget-center';
const KEYBINDING_KEY = 'widget-center-overlay-keybinding';
const DISABLED_KEY = 'disabled-widgets';

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
     *     onWidgetEnabledChanged(id, enabled), onApplyThemePack(manifest, enabled):
     *     hooks a real integration can use to do more than the built-in
     *     fallback (e.g. onWidgetRemove actually deleting layout/settings
     *     via StorageService, not just disabling).
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
        Main.layoutManager.addChrome(this._overlay, {affectsInputRegion: true});

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

        const tabsBox = new St.BoxLayout({style_class: 'wc-overlay-tabs', x_expand: true});
        for (const [id, label] of [['overview', 'Overview'], ['themes', 'Themes'], ['settings', 'Preferences']]) {
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
        header.add_child(tabsBox);

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
        case 'settings':
            content = this._buildSettingsTab();
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
        const disabled = new Set(this._getDisabledWidgets());
        return this._buildGrid(this._discoverWidgets(), entry => this._buildWidgetCard(entry, disabled));
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
        controls.add_child(this._buildToggleButton(
            !disabledSet.has(id), enabled => this._setWidgetEnabled(id, enabled)));
        controls.add_child(new St.Widget({x_expand: true}));
        controls.add_child(this._buildIconButton('emblem-system-symbolic', () => this._openWidgetSettings(id)));
        controls.add_child(this._buildIconButton('window-close-symbolic', () => this._removeWidget(id)));
        card.add_child(controls);

        return card;
    }

    _discoverWidgets() {
        if (this._services.widgetLoader?.discover) {
            try {
                return this._services.widgetLoader.discover();
            } catch (e) {
                console.error('[widget-center] overlay: injected widgetLoader.discover() failed, falling back', e);
            }
        }
        return this._scanMetadataFolders(GLib.build_filenamev([this._path, 'widgets']));
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
        // (widget-center-prefs-app.js) deep-linked to this widget.
        const scriptPath = GLib.build_filenamev([this._path, 'widget-center-prefs-app.js']);
        try {
            Gio.Subprocess.new(['gjs', '-m', scriptPath, `--widget-id=${id}`], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error(`[widget-center] overlay: could not launch Settings for "${id}"`, e);
        }
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
        return this._buildGrid(this._discoverThemePacks(), entry => this._buildThemePackCard(entry));
    }

    _discoverThemePacks() {
        if (!this._themePackRegistry)
            this._themePackRegistry = new ThemePackRegistry([GLib.build_filenamev([this._path, 'themepacks'])]);
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

        const widgetList = (manifest.widgets ?? []).join(', ');
        if (widgetList)
            card.add_child(new St.Label({text: widgetList, style_class: 'wc-overlay-card-widgetlist'}));

        if (manifest.author)
            card.add_child(new St.Label({text: `by ${manifest.author}`, style_class: 'wc-overlay-card-author'}));

        const controls = new St.BoxLayout({style_class: 'wc-overlay-card-controls'});
        controls.add_child(this._buildToggleButton(
            this._isThemePackEnabled(manifest), enabled => this._setThemePackEnabled(manifest, enabled)));
        controls.add_child(new St.Widget({x_expand: true}));
        controls.add_child(this._buildIconButton('emblem-system-symbolic', () => this._openThemePackSettings(id)));
        card.add_child(controls);

        return card;
    }

    _isThemePackEnabled(manifest) {
        const disabled = new Set(this._getDisabledWidgets());
        return (manifest.widgets ?? []).every(w => !disabled.has(w));
    }

    _setThemePackEnabled(manifest, enabled) {
        const current = new Set(this._getDisabledWidgets());
        for (const widgetId of manifest.widgets ?? []) {
            if (enabled)
                current.delete(widgetId);
            else
                current.add(widgetId);
        }
        this._writeDisabledWidgets(current);
        this._services.onApplyThemePack?.(manifest, enabled);
    }

    _openThemePackSettings(id) {
        if (this._services.onThemePackSettings) {
            this._services.onThemePackSettings(id);
            return;
        }
        this._openExtensionPreferences();
    }

    // --- Tab 3: Settings --------------------------------------------------

    // Everything here is read/written straight off this._gsettings — the
    // exact same schema/keys prefs.js's own "Preferences" tab uses (see
    // 2026-08-03: now a real native-St reimplementation of the Preferences
    // window's General/Appearance/Desktop/Interactions/Advanced/About
    // categories (lib/widgetCenterOverlayPreferences.js), reusing the same
    // SettingsService/ThemeService the real window uses — same
    // GSettings/theme.json, so a change made here shows up there too and
    // vice versa, live, no restart. "Backup & Restore" and "Import /
    // Export" are the one part left out (both need Gtk.FileChooserNative,
    // which needs a real GTK window - see lib/prefsDialogs.js's
    // chooseFile()) - the banner button below opens the real window,
    // landed on its "Preferences" tab, for those two specifically.
    _buildSettingsTab() {
        const outer = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true, style_class: 'wc-pref-outer'});

        const banner = new St.Button({style_class: 'wc-pref-banner', can_focus: true, reactive: true});
        const bannerContent = new St.BoxLayout({style_class: 'wc-pref-banner-content', x_expand: true});
        bannerContent.add_child(new St.Icon({icon_name: 'send-to-symbolic', icon_size: 18}));
        const bannerLabel = new St.Label({
            text: 'Need Backup & Restore or Import / Export? Open the full Preferences window →',
            style_class: 'wc-pref-banner-label', x_expand: true,
        });
        bannerContent.add_child(bannerLabel);
        banner.set_child(bannerContent);
        banner.connect('clicked', () => this._openExtensionPreferences());
        outer.add_child(banner);

        const scroll = new St.ScrollView({style_class: 'wc-overlay-scroll', x_expand: true, y_expand: true});
        try {
            scroll.add_child(buildOverlayPreferencesContent(this._extension));
        } catch (e) {
            console.error('[widget-center] overlay: could not build the Preferences tab content', e);
            const err = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true,
                x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
            err.add_child(new St.Label({text: 'Preferences could not be loaded.', style_class: 'wc-overlay-empty'}));
            scroll.add_child(err);
        }
        outer.add_child(scroll);

        return outer;
    }

    _openExtensionPreferences() {
        if (this._services.onOpenPreferences) {
            this._services.onOpenPreferences();
            return;
        }
        // --focus=preferences (widget-center-prefs-app.js +
        // PrefsWindowController.showPreferencesPage()): lands on the
        // Preferences tab directly instead of Overview, since this
        // overlay's own Overview tab already covers that ground natively.
        const scriptPath = GLib.build_filenamev([this._path, 'widget-center-prefs-app.js']);
        try {
            Gio.Subprocess.new(['gjs', '-m', scriptPath, '--focus=preferences'], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error('[widget-center] overlay: could not launch the Preferences app', e);
        }
    }

    // --- Shared small-widget helpers --------------------------------------

    _buildGrid(entries, buildCard) {
        const scroll = new St.ScrollView({
            style_class: 'wc-overlay-scroll', x_expand: true, y_expand: true,
        });
        const box = new St.BoxLayout({vertical: true, style_class: 'wc-overlay-grid'});

        const columns = this._gridColumns();
        for (let i = 0; i < entries.length; i += columns) {
            const row = new St.BoxLayout({style_class: 'wc-overlay-row'});
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

        if (shotPath) {
            const uri = Gio.File.new_for_path(shotPath).get_uri();
            bin.set_style(`background-image: url("${uri}"); background-size: cover; background-position: center;`);
        } else {
            bin.set_child(new St.Icon({
                icon_name: 'image-x-generic-symbolic',
                icon_size: 48,
                style_class: 'wc-overlay-card-screenshot-fallback',
            }));
        }
        return bin;
    }

    _resolveScreenshot(basePath, metadataOrManifest) {
        const relative = metadataOrManifest?.screenshot;
        if (!relative)
            return null;
        const path = GLib.build_filenamev([basePath, relative]);
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }

    _buildToggleButton(initialOn, onChange) {
        let on = initialOn;
        const icon = new St.Icon({
            icon_name: on ? 'checkbox-checked-symbolic' : 'checkbox-symbolic',
            icon_size: 20,
        });
        const button = new St.Button({style_class: 'wc-overlay-toggle', can_focus: true, reactive: true});
        button.set_child(icon);
        button.connect('clicked', () => {
            on = !on;
            icon.icon_name = on ? 'checkbox-checked-symbolic' : 'checkbox-symbolic';
            onChange(on);
        });
        return button;
    }

    _buildIconButton(iconName, callback) {
        const button = new St.Button({style_class: 'wc-overlay-icon-button', can_focus: true, reactive: true});
        button.set_child(new St.Icon({icon_name: iconName, icon_size: 16}));
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
