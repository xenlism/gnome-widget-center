/* Card preview (screenshot and non-screenshot/fallback) is locked to a
 * 3:1 width:height ratio - see _buildScreenshot(). The
 * wc-overlay-card-screenshot CSS height (stylesheet.css) is kept in sync
 * with that ratio. */

import Clutter from "gi://Clutter";

import GdkPixbuf from "gi://GdkPixbuf";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import Meta from "gi://Meta";

import Shell from "gi://Shell";

import St from "gi://St";

import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { ThemePackRegistry } from "./themePackRegistry.js";

const SCHEMA_ID = "org.gnome.shell.extensions.widget-center";

const KEYBINDING_KEY = "widget-center-overlay-keybinding";

const DISABLED_KEY = "disabled-widgets";

const ACTIVE_THEME_PACK_KEY = "active-theme-pack";

const PREFS_APP_ID = "io.github.xenlism.WidgetCenterPrefs";

const SORT_MODES = [ {
    id: "name",
    label: "Name",
    icon: "format-justify-left-symbolic"
}, {
    id: "size",
    label: "Widget size",
    icon: "view-grid-symbolic"
}, {
    id: "mtime",
    label: "Date modified",
    icon: "document-open-recent-symbolic"
} ];

const DBUS_NAME = "io.github.xenlism.WidgetCenterOverlay";

const DBUS_PATH = "/io/github/xenlism/WidgetCenterOverlay";

const DBUS_IFACE_XML = `\n<node>\n  <interface name="io.github.xenlism.WidgetCenterOverlay">\n    <method name="Toggle" />\n    <method name="Open" />\n    <method name="Close" />\n  </interface>\n</node>`;

export class WidgetCenterOverlay {
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
        this._activeTab = "overview";
        this._keyPressId = 0;
        this._modalGrab = null;
        this._themePackRegistry = null;
        this._widgetSort = "name";
        this._themeSort = "name";
        this._widgetSearch = "";
        this._themeSearch = "";
        this._prefsWatchCreatedId = 0;
        this._prefsWatchTimeoutId = 0;
        this._prefsWatchUnmanagedId = 0;
        this._prefsWatchWindow = null;
    }
    enable() {
        try {
            this._gsettings = this._extension.getSettings(SCHEMA_ID);
        } catch (e) {
            console.error("[widget-center] overlay: could not resolve settings schema", e);
            return;
        }
        this._addKeybinding();
        this._exportDBus();
    }
    disable() {
        this.close();
        this._clearPrefsWatch();
        this._removeKeybinding();
        this._unexportDBus();
        this._gsettings = null;
    }
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
        if (this._overlay) return;
        this._logger?.debug("widget-center-overlay", "open()");
        this._buildUI();
        Main.layoutManager.addChrome(this._overlay);
        try {
            // actionMode must be passed explicitly - system-wide shortcuts
            // that are meant to always work (e.g. Super+Space / "switch
            // input source", which GNOME Shell itself registers with
            // Shell.ActionMode.ALL) still get resolved against whatever
            // Main.actionMode is current while a modal grab is up. Leaving
            // this unset let it fall back to a mode that doesn't reliably
            // OR against ALL-tagged bindings, which is what made Super+Space
            // stop switching keyboard layout while this overlay was open.
            // Shell.ActionMode.POPUP is the same mode GNOME Shell's own
            // popup-style modals (menus, app switchers) use, and is known to
            // still let ActionMode.ALL system bindings through.
            this._modalGrab = Main.pushModal(this._overlay, {
                actionMode: Shell.ActionMode.POPUP
            });
        } catch (e) {
            console.error("[widget-center] overlay: pushModal failed, continuing non-modal", e);
            this._modalGrab = null;
        }
        this._keyPressId = global.stage.connect("key-press-event", (actor, event) => this._onStageKeyPress(event));
        this._overlay.grab_key_focus();
    }
    close() {
        if (!this._overlay) return;
        this._logger?.debug("widget-center-overlay", "close()");
        if (this._keyPressId) {
            global.stage.disconnect(this._keyPressId);
            this._keyPressId = 0;
        }
        if (this._modalGrab) {
            try {
                Main.popModal(this._modalGrab);
            } catch (e) {
                console.error("[widget-center] overlay: popModal failed", e);
            }
            this._modalGrab = null;
        }
        Main.layoutManager.removeChrome(this._overlay);
        this._overlay.destroy();
        this._overlay = null;
        this._contentBin = null;
        this._tabButtons = {};
    }
    _addKeybinding() {
        try {
            Main.wm.addKeybinding(KEYBINDING_KEY, this._gsettings, Meta.KeyBindingFlags.NONE, Shell.ActionMode.ALL, () => this.toggle());
            this._keybindingAdded = true;
        } catch (e) {
            console.error("[widget-center] overlay: addKeybinding failed", e);
        }
    }
    _removeKeybinding() {
        if (!this._keybindingAdded) return;
        try {
            Main.wm.removeKeybinding(KEYBINDING_KEY);
        } catch (e) {
            console.error("[widget-center] overlay: removeKeybinding failed", e);
        }
        this._keybindingAdded = false;
    }
    _exportDBus() {
        try {
            const nodeInfo = Gio.DBusNodeInfo.new_for_xml(DBUS_IFACE_XML);
            this._dbusImpl = Gio.DBusExportedObject.wrapJSObject(nodeInfo.interfaces[0], this);
            this._dbusImpl.export(Gio.DBus.session, DBUS_PATH);
            this._ownerId = Gio.bus_own_name(Gio.BusType.SESSION, DBUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
        } catch (e) {
            console.error("[widget-center] overlay: D-Bus export failed (.desktop launch won't work, shortcut still will)", e);
        }
    }
    _unexportDBus() {
        if (this._dbusImpl) {
            try {
                this._dbusImpl.unexport();
            } catch (e) {}
            this._dbusImpl = null;
        }
        if (this._ownerId) {
            Gio.bus_unown_name(this._ownerId);
            this._ownerId = 0;
        }
    }
    _onStageKeyPress(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }
    _buildUI() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._overlay = new St.BoxLayout({
            style_class: "wc-overlay",
            vertical: true,
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height
        });
        this._overlay.add_child(this._buildHeader());
        this._contentBin = new St.Bin({
            style_class: "wc-overlay-content",
            x_expand: true,
            y_expand: true
        });
        this._overlay.add_child(this._contentBin);
        this._renderTab(this._activeTab);
    }
    _buildHeader() {
        const header = new St.BoxLayout({
            style_class: "wc-overlay-header",
            vertical: false
        });
        const leftSpacer = new St.Widget({
            x_expand: true
        });
        const tabsBox = new St.BoxLayout({
            style_class: "wc-overlay-tabs"
        });
        for (const [id, label] of [ [ "overview", "Overview" ], [ "themes", "Themes" ] ]) {
            const button = new St.Button({
                style_class: "wc-overlay-tab",
                label: label,
                can_focus: true,
                reactive: true
            });
            button.connect("clicked", () => this._renderTab(id));
            this._tabButtons[id] = button;
            tabsBox.add_child(button);
        }
        const preferencesButton = new St.Button({
            style_class: "wc-overlay-tab",
            label: "Preferences",
            can_focus: true,
            reactive: true
        });
        preferencesButton.connect("clicked", () => this._openExtensionPreferences());
        tabsBox.add_child(preferencesButton);
        const rightSpacer = new St.Widget({
            x_expand: true
        });
        header.add_child(leftSpacer);
        header.add_child(tabsBox);
        header.add_child(rightSpacer);
        const closeButton = this._buildIconButton("window-close-symbolic", () => this.close());
        closeButton.add_style_class_name("wc-overlay-close");
        header.add_child(closeButton);
        return header;
    }
    _renderTab(tab) {
        this._activeTab = tab;
        for (const [id, button] of Object.entries(this._tabButtons)) button.set_style_class_name(id === tab ? "wc-overlay-tab wc-overlay-tab-active" : "wc-overlay-tab");
        let content;
        switch (tab) {
          case "themes":
            content = this._buildThemesTab();
            break;

          case "overview":
          default:
            content = this._buildOverviewTab();
            break;
        }
        this._contentBin.set_child(content);
    }
    _buildOverviewTab() {
        const outer = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        const gridBin = new St.Bin({
            x_expand: true,
            y_expand: true
        });
        const bar = this._buildSortBar(this._widgetSort, mode => {
            this._widgetSort = mode;
            this._refreshOverviewGrid(gridBin);
        });
        bar.add_child(this._buildSearchEntry("Search widgets…", this._widgetSearch, text => {
            this._widgetSearch = text;
            this._refreshOverviewGrid(gridBin);
        }));
        outer.add_child(bar);
        outer.add_child(gridBin);
        // Discovered once per tab render, not once per keystroke - see
        // _refreshOverviewGrid() below. _discoverWidgets() reads every
        // widget's metadata.json plus a mtime stat off disk, so re-running
        // it on every "text-changed" (i.e. every keystroke in the search
        // box) was the actual cause of the overlay's widget search feeling
        // very slow with a lot of bundled widgets - typing didn't get
        // slower because of the *filtering*, it got slower because each
        // keystroke re-scanned the whole widgets folder from scratch first.
        this._widgetDiscoveryCache = this._discoverWidgets();
        this._refreshOverviewGrid(gridBin);
        return outer;
    }
    _refreshOverviewGrid(gridBin) {
        const disabled = new Set(this._getDisabledWidgets());
        let entries = this._sortEntries(this._widgetDiscoveryCache ?? this._discoverWidgets(), this._widgetSort, {
            name: e => e.metadata?.name ?? e.id,
            size: e => this._blockSizeCells(e.metadata?.["block-type"]),
            mtime: e => e.mtimeUnix ?? 0
        });
        entries = this._filterEntries(entries, this._widgetSearch, e => [ e.metadata?.name, e.id, e.metadata?.description ]);
        gridBin.set_child(this._buildGrid(entries, entry => this._buildWidgetCard(entry, disabled)));
    }
    _blockSizeCells(blockType) {
        const match = /^(\d+)x(\d+)$/.exec(blockType ?? "");
        if (!match) return 0;
        return Number(match[1]) * Number(match[2]);
    }
    _buildWidgetCard(entry, disabledSet) {
        const {id: id, metadata: metadata, path: path} = entry;
        const card = new St.BoxLayout({
            vertical: true,
            style_class: "wc-overlay-card"
        });
        card.add_child(this._buildScreenshot(path, metadata));
        card.add_child(new St.Label({
            text: metadata.name ?? id,
            style_class: "wc-overlay-card-title"
        }));
        if (metadata.description) {
            const desc = new St.Label({
                text: metadata.description,
                style_class: "wc-overlay-card-desc"
            });
            desc.clutter_text.line_wrap = true;
            card.add_child(desc);
        }
        if (metadata.author) card.add_child(new St.Label({
            text: `by ${metadata.author}`,
            style_class: "wc-overlay-card-author"
        }));
        const controls = new St.BoxLayout({
            style_class: "wc-overlay-card-controls"
        });
        controls.add_child(this._buildSwitch(!disabledSet.has(id), enabled => this._setWidgetEnabled(id, enabled)));
        controls.add_child(new St.Widget({
            x_expand: true
        }));
        controls.add_child(this._buildIconTextButton("emblem-system-symbolic", "Settings", () => this._openWidgetSettings(id)));
        if (entry.source === "user") {
            controls.add_child(this._buildIconTextButton("trash-symbolic", "Uninstall", () => this._removeWidget(id)));
        }
        card.add_child(controls);
        return card;
    }
    _userWidgetsRoots() {
        const roots = [ GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "widgets" ]), GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "widgets" ]) ];
        if (this._services.userWidgetsPath) roots.push(this._services.userWidgetsPath);
        return roots;
    }
    _discoverWidgets() {
        let entries;
        if (this._services.widgetLoader?.discover) {
            try {
                entries = this._services.widgetLoader.discover();
            } catch (e) {
                console.error("[widget-center] overlay: injected widgetLoader.discover() failed, falling back", e);
            }
        }
        if (!entries) entries = this._scanMetadataFolders(GLib.build_filenamev([ this._path, "widgets" ]));
        const userRoots = this._userWidgetsRoots();
        return entries.map(entry => {
            const isUser = userRoots.some(root => entry.path === root || entry.path.startsWith(`${root}/`));
            return {
                ...entry,
                source: isUser ? "user" : "bundled",
                mtimeUnix: this._pathMtimeUnix(entry.path)
            };
        });
    }
    _pathMtimeUnix(path) {
        try {
            const info = Gio.File.new_for_path(path).query_info("time::modified", Gio.FileQueryInfoFlags.NONE, null);
            const dt = info.get_modification_date_time?.();
            if (dt) return dt.to_unix();
            return Number(info.get_attribute_uint64("time::modified")) || 0;
        } catch (e) {
            return 0;
        }
    }
    _setWidgetEnabled(id, enabled) {
        const current = new Set(this._getDisabledWidgets());
        if (enabled) current.delete(id); else current.add(id);
        this._writeDisabledWidgets(current);
        this._services.onWidgetEnabledChanged?.(id, enabled);
    }
    _openWidgetSettings(id) {
        if (this._services.onWidgetSettings) {
            this._services.onWidgetSettings(id);
            return;
        }
        this._launchExternalPrefsWindow([ `--widget-id=${id}` ]);
    }
    _removeWidget(id) {
        if (this._services.onWidgetRemove) {
            this._services.onWidgetRemove(id);
            this._renderTab(this._activeTab);
            return;
        }
        this._setWidgetEnabled(id, false);
        this._renderTab(this._activeTab);
    }
    _buildThemesTab() {
        const outer = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        const gridBin = new St.Bin({
            x_expand: true,
            y_expand: true
        });
        const bar = this._buildSortBar(this._themeSort, mode => {
            this._themeSort = mode;
            this._refreshThemesGrid(gridBin);
        });
        bar.add_child(this._buildIconTextButton("emblem-shared-symbolic", "Share desktop", () => this._launchExternalPrefsWindow([ "--export-theme-new" ])));
        bar.add_child(this._buildSearchEntry("Search themes…", this._themeSearch, text => {
            this._themeSearch = text;
            this._refreshThemesGrid(gridBin);
        }));
        outer.add_child(bar);
        outer.add_child(gridBin);
        // Same reasoning as _widgetDiscoveryCache above: discover once per
        // tab render, not once per keystroke.
        this._themePackDiscoveryCache = this._discoverThemePacks();
        this._refreshThemesGrid(gridBin);
        return outer;
    }
    _refreshThemesGrid(gridBin) {
        let entries = this._sortEntries(this._themePackDiscoveryCache ?? this._discoverThemePacks(), this._themeSort, {
            name: e => e.manifest?.name ?? e.id,
            size: e => e.widgetCount ?? (e.manifest?.widgets?.length ?? 0),
            mtime: e => e.mtimeUnix ?? 0
        });
        entries = this._filterEntries(entries, this._themeSearch, e => [ e.manifest?.name, e.id, e.manifest?.description ]);
        gridBin.set_child(this._buildGrid(entries, entry => this._buildThemePackCard(entry)));
    }
    _userThemepacksRoots() {
        const roots = [ GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]) ];
        if (this._services.userThemepacksPath) roots.push(this._services.userThemepacksPath);
        return roots;
    }
    _discoverThemePacks() {
        const bundledPath = GLib.build_filenamev([ this._path, "themepacks" ]);
        const searchPaths = [ {
            path: bundledPath,
            source: "bundled"
        }, ...this._userThemepacksRoots().map(path => ({
            path: path,
            source: "user"
        })) ];
        this._themePackRegistry = new ThemePackRegistry(searchPaths);
        return this._themePackRegistry.discover();
    }
    _buildThemePackCard(entry) {
        const {id: id, path: path, manifest: manifest} = entry;
        const card = new St.BoxLayout({
            vertical: true,
            style_class: "wc-overlay-card"
        });
        card.add_child(this._buildScreenshot(path, manifest));
        card.add_child(new St.Label({
            text: manifest.name ?? id,
            style_class: "wc-overlay-card-title"
        }));
        if (manifest.description) {
            const desc = new St.Label({
                text: manifest.description,
                style_class: "wc-overlay-card-desc"
            });
            desc.clutter_text.line_wrap = true;
            card.add_child(desc);
        }
        if (manifest.author) card.add_child(new St.Label({
            text: `by ${manifest.author}`,
            style_class: "wc-overlay-card-author"
        }));
        const controls = new St.BoxLayout({
            style_class: "wc-overlay-card-controls"
        });
        controls.add_child(this._buildThemeToggle(entry));
        controls.add_child(new St.Widget({
            x_expand: true
        }));
        controls.add_child(this._buildIconTextButton("emblem-shared-symbolic", "Share", () => this._exportThemePack(entry)));
        if (entry.source === "user") {
            controls.add_child(this._buildIconTextButton("user-trash-symbolic", "Uninstall", () => this._removeThemePack(entry)));
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
    _loadThemePack(entry) {
        try {
            this._gsettings.set_string(ACTIVE_THEME_PACK_KEY, entry.id);
            Gio.Settings.sync();
        } catch (e) {
            console.error("[widget-center] overlay: could not save active theme pack", e);
        }
        this._renderTab("themes");
    }
    _unloadThemePack() {
        try {
            this._gsettings.set_string(ACTIVE_THEME_PACK_KEY, "");
            Gio.Settings.sync();
        } catch (e) {
            console.error("[widget-center] overlay: could not clear active theme pack", e);
        }
        this._renderTab("themes");
    }
    _exportThemePack(entry) {
        this._launchExternalPrefsWindow([ `--export-theme-id=${entry.id}` ]);
    }
    _openThemePackSettings(id) {
        if (this._services.onThemePackSettings) {
            this._services.onThemePackSettings(id);
            return;
        }
        this._openExtensionPreferences();
    }
    _removeThemePack(entry) {
        if (this._services.onThemePackRemove) {
            this._services.onThemePackRemove(entry);
            this._themePackRegistry = null;
            this._renderTab(this._activeTab);
            return;
        }
        try {
            const target = Gio.File.new_for_path(entry.path);
            const info = target.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) this._deleteRecursive(target); else target.delete(null);
        } catch (e) {
            console.error(`[widget-center] overlay: could not remove theme pack "${entry.id}"`, e);
        }
        this._themePackRegistry = null;
        this._renderTab(this._activeTab);
    }
    _deleteRecursive(file) {
        const info = file.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null);
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            const enumerator = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
            let child;
            while ((child = enumerator.next_file(null)) !== null) this._deleteRecursive(file.get_child(child.get_name()));
        }
        file.delete(null);
    }
    _openExtensionPreferences() {
        this.close();
        if (this._services.onOpenPreferences) {
            this._services.onOpenPreferences();
            return;
        }
        this._launchExternalPrefsWindow([ "--focus=preferences" ]);
    }
    _gridContentWidth() {
        const columns = this._gridColumns();
        return columns * 480 + (columns - 1) * 16;
    }
    _buildSortBar(currentMode, onChange) {
        const bar = new St.BoxLayout({
            style_class: "wc-overlay-sortbar",
            width: this._gridContentWidth(),
            x_expand: false,
            x_align: Clutter.ActorAlign.CENTER
        });
        for (const mode of SORT_MODES) {
            const button = new St.Button({
                style_class: mode.id === currentMode ? "wc-overlay-tab wc-overlay-tab-active" : "wc-overlay-tab",
                can_focus: true,
                reactive: true,
                accessible_name: `Sort by ${mode.label}`
            });
            button.set_child(new St.Icon({
                icon_name: mode.icon,
                icon_size: 16
            }));
            button.connect("clicked", () => onChange(mode.id));
            bar.add_child(button);
        }
        bar.add_child(new St.Widget({
            x_expand: true
        }));
        return bar;
    }
    _sortEntries(entries, mode, keyFns) {
        const keyFn = keyFns[mode] ?? keyFns.name;
        const sorted = [ ...entries ];
        sorted.sort((a, b) => {
            const ka = keyFn(a);
            const kb = keyFn(b);
            if (typeof ka === "string" || typeof kb === "string") return String(ka).localeCompare(String(kb));
            return mode === "mtime" ? kb - ka : ka - kb;
        });
        return sorted;
    }
    _buildSearchEntry(hintText, initialText, onChange) {
        const entry = new St.Entry({
            style_class: "wc-overlay-search",
            hint_text: hintText,
            can_focus: true,
            reactive: true,
            x_expand: false,
            width: 220
        });
        entry.set_primary_icon(new St.Icon({
            icon_name: "edit-find-symbolic",
            icon_size: 14
        }));
        if (initialText) entry.set_text(initialText);
        entry.clutter_text.connect("text-changed", () => onChange(entry.get_text()));
        return entry;
    }
    _filterEntries(entries, query, fieldsFn) {
        const q = (query ?? "").trim().toLowerCase();
        if (!q) return entries;
        return entries.filter(entry => fieldsFn(entry).some(field => String(field ?? "").toLowerCase().includes(q)));
    }
    _launchExternalPrefsWindow(args) {
        const scriptPath = GLib.build_filenamev([ this._path, "widget-center-prefs-app.js" ]);
        try {
            Gio.Subprocess.new([ "gjs", "-m", scriptPath, ...args ], Gio.SubprocessFlags.NONE);
        } catch (e) {
            console.error("[widget-center] overlay: could not launch the external prefs window", e);
            return;
        }
        this.close();
        this._watchForExternalPrefsWindow();
    }
    _isPrefsWindow(metaWindow) {
        try {
            if (metaWindow.get_gtk_application_id?.() === PREFS_APP_ID) return true;
        } catch (e) {}
        try {
            const wmClass = metaWindow.get_wm_class?.();
            if (wmClass && wmClass.toLowerCase().includes("widgetcenterprefs")) return true;
        } catch (e) {}
        return false;
    }
    _watchForExternalPrefsWindow() {
        this._clearPrefsWatch();
        const attach = metaWindow => {
            this._clearPrefsWatch();
            try {
                metaWindow.make_above();
                metaWindow.activate(global.get_current_time());
            } catch (e) {}
            this._prefsWatchWindow = metaWindow;
            this._prefsWatchUnmanagedId = metaWindow.connect("unmanaged", () => {
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
        this._prefsWatchCreatedId = global.display.connect("window-created", (display, metaWindow) => {
            if (!this._isPrefsWindow(metaWindow)) return;
            attach(metaWindow);
        });
        this._prefsWatchTimeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 10, () => {
            this._prefsWatchTimeoutId = 0;
            if (this._prefsWatchCreatedId) {
                global.display.disconnect(this._prefsWatchCreatedId);
                this._prefsWatchCreatedId = 0;
                this._overlay?.show();
            }
            return GLib.SOURCE_REMOVE;
        });
    }
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
            } catch (e) {}
        }
        this._prefsWatchUnmanagedId = 0;
        this._prefsWatchWindow = null;
    }
    _buildGrid(entries, buildCard) {
        const scroll = new St.ScrollView({
            style_class: "wc-overlay-scroll",
            x_expand: true,
            y_expand: true,
            hscrollbar_policy: St.PolicyType.NEVER
        });
        const box = new St.BoxLayout({
            vertical: true,
            style_class: "wc-overlay-grid",
            x_align: Clutter.ActorAlign.CENTER
        });
        const columns = this._gridColumns();
        for (let i = 0; i < entries.length; i += columns) {
            const row = new St.BoxLayout({
                style_class: "wc-overlay-row",
                x_align: Clutter.ActorAlign.CENTER
            });
            for (let c = 0; c < columns; c++) {
                if (entries[i + c]) row.add_child(buildCard(entries[i + c]));
            }
            box.add_child(row);
        }
        if (entries.length === 0) {
            box.add_child(new St.Label({
                text: "Nothing here yet.",
                style_class: "wc-overlay-empty"
            }));
        }
        scroll.add_child(box);
        return scroll;
    }
    _gridColumns() {
        const width = Main.layoutManager.primaryMonitor?.width ?? 1920;
        if (width >= 1600) return 3;
        if (width >= 1100) return 2;
        return 1;
    }
    _buildScreenshot(basePath, metadataOrManifest) {
        const shotPath = this._resolveScreenshot(basePath, metadataOrManifest);
        const bin = new St.Bin({
            style_class: "wc-overlay-card-screenshot",
            x_expand: true
        });
        let uri = null;
        if (shotPath) {
            uri = Gio.File.new_for_path(shotPath).get_uri();
        } else {
            bin.set_child(new St.Icon({
                icon_name: "image-x-generic-symbolic",
                icon_size: 48,
                style_class: "wc-overlay-card-screenshot-fallback"
            }));
        }
        const initialWidth = 456;
        const initialHeight = Math.round(initialWidth / 3);
        bin.height = initialHeight;
        if (shotPath) {
            bin.set_style(this._coverBackgroundStyle(shotPath, uri, initialWidth, initialHeight));
        }
        return bin;
    }
    _coverBackgroundStyle(shotPath, uri, boxWidth, boxHeight) {
        const fallback = `background-image: url("${uri}"); background-size: ${boxWidth}px ${boxHeight}px; background-position: 0px 0px;`;
        let width, height;
        // Screenshot files don't change while the overlay is open, so their
        // pixel dimensions don't either - cache them instead of re-reading
        // the file's header via GdkPixbuf on every card rebuild (every
        // sort/filter change, i.e. every keystroke in the search box).
        if (!this._imageDimsCache) this._imageDimsCache = new Map;
        const cached = this._imageDimsCache.get(shotPath);
        if (cached) {
            ({width, height} = cached);
        } else {
            try {
                [, width, height] = GdkPixbuf.Pixbuf.get_file_info(shotPath);
            } catch (e) {
                console.warn(`[widget-center] could not read screenshot dimensions for "${shotPath}", falling back to a stretched fit`, e);
            }
            this._imageDimsCache.set(shotPath, { width, height });
        }
        if (!width || !height) return fallback;
        const scale = Math.max(boxWidth / width, boxHeight / height);
        const scaledWidth = Math.ceil(width * scale);
        const scaledHeight = Math.ceil(height * scale);
        const offsetX = -Math.round((scaledWidth - boxWidth) / 2);
        const offsetY = -Math.round((scaledHeight - boxHeight) / 2);
        return `background-image: url("${uri}"); background-size: ${scaledWidth}px ${scaledHeight}px; background-position: ${offsetX}px ${offsetY}px;`;
    }
    _resolveScreenshot(basePath, metadataOrManifest) {
        if (metadataOrManifest?.screenshotBase64) return this._decodedScreenshotCachePath(metadataOrManifest);
        const relative = metadataOrManifest?.screenshot;
        if (!relative) return null;
        const path = GLib.build_filenamev([ basePath, relative ]);
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }
    _decodedScreenshotCachePath(manifest) {
        const ext = (manifest.screenshotMime ?? "").includes("png") ? "png" : (manifest.screenshotMime ?? "").includes("webp") ? "webp" : "jpg";
        const cacheDir = GLib.build_filenamev([ GLib.get_user_cache_dir(), "gnome-widget-center", "thumbnails" ]);
        const cachePath = GLib.build_filenamev([ cacheDir, `${manifest.id}.${ext}` ]);
        if (GLib.file_test(cachePath, GLib.FileTest.EXISTS)) return cachePath;
        try {
            GLib.mkdir_with_parents(cacheDir, 493);
            const bytes = GLib.base64_decode(manifest.screenshotBase64);
            GLib.file_set_contents(cachePath, bytes);
            return cachePath;
        } catch (e) {
            console.error(`[widget-center] overlay: could not decode screenshot for "${manifest.id}"`, e);
            return null;
        }
    }
    _buildSwitch(initialOn, onChange) {
        const readOnly = !onChange;
        const button = new St.Button({
            style_class: "wc-pref-switch",
            toggle_mode: !readOnly,
            checked: !!initialOn,
            can_focus: !readOnly,
            reactive: !readOnly,
            opacity: readOnly ? 200 : 255
        });
        button.add_child(new St.Widget({
            style_class: "wc-pref-switch-knob"
        }));
        if (!readOnly) button.connect("notify::checked", () => onChange(button.checked));
        return button;
    }
    _buildThemeToggle(entry) {
        const toggle = this._buildSwitch(this._isThemePackEnabled(entry.id), on => {
            if (on) this._loadThemePack(entry); else this._unloadThemePack();
        });
        toggle.accessible_name = this._isThemePackEnabled(entry.id) ? `${entry.manifest?.name ?? entry.id} — active` : `${entry.manifest?.name ?? entry.id} — not loaded`;
        return toggle;
    }
    _buildIconButton(iconName, callback) {
        const button = new St.Button({
            style_class: "wc-overlay-icon-button",
            can_focus: true,
            reactive: true
        });
        button.set_child(new St.Icon({
            icon_name: iconName,
            icon_size: 16
        }));
        button.connect("clicked", callback);
        return button;
    }
    _buildIconTextButton(iconName, text, callback) {
        const button = new St.Button({
            style_class: "wc-overlay-icon-button wc-overlay-icon-text-button",
            can_focus: true,
            reactive: true,
            accessible_name: text
        });
        const box = new St.BoxLayout({
            style_class: "wc-overlay-icon-text-box"
        });
        box.add_child(new St.Icon({
            icon_name: iconName,
            icon_size: 16
        }));
        box.add_child(new St.Label({
            text: text
        }));
        button.set_child(box);
        button.connect("clicked", callback);
        return button;
    }
    _getDisabledWidgets() {
        try {
            return this._gsettings.get_strv(DISABLED_KEY);
        } catch (e) {
            return [];
        }
    }
    _writeDisabledWidgets(idSet) {
        try {
            this._gsettings.set_strv(DISABLED_KEY, [ ...idSet ]);
            Gio.Settings.sync();
        } catch (e) {
            console.error("[widget-center] overlay: could not write disabled-widgets", e);
        }
    }
    _scanMetadataFolders(root) {
        const results = [];
        const dir = Gio.File.new_for_path(root);
        if (!dir.query_exists(null)) return results;
        let enumerator;
        try {
            enumerator = dir.enumerate_children("standard::name,standard::type", Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            return results;
        }
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
            const name = info.get_name();
            if (name.startsWith("_")) continue;
            const folder = dir.get_child(name);
            const path = folder.get_path();
            const metadataFile = folder.get_child("metadata.json");
            if (!metadataFile.query_exists(null)) continue;
            try {
                const [ok, contents] = metadataFile.load_contents(null);
                if (!ok) continue;
                const metadata = JSON.parse(new TextDecoder("utf-8").decode(contents));
                results.push({
                    id: metadata.id ?? name,
                    metadata: metadata,
                    path: path
                });
            } catch (e) {
                console.error(`[widget-center] overlay: could not read ${path}/metadata.json`, e);
            }
        }
        return results;
    }
}