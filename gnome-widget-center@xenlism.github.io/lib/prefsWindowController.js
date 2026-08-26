import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import Gio from "gi://Gio";

import GLib from "gi://GLib";

import Pango from "gi://Pango";

import { PrefsWindowController } from "./prefsWindowControllerBase.js";

import { confirmOverwrite } from "./prefsDialogs.js";

import { fileExists, pathIsUnder } from "./fsUtils.js";

import { ThemePackRegistry } from "./themePackRegistry.js";

import { SettingsService } from "./settingsService.js";

import { StorageService } from "./storageService.js";

import { PrefsWidgetList } from "./prefsWidgetList.js";

import { WidgetSettings } from "./widgetSettings.js";

import { loadTranslations } from "../i18n/index.js";

const CARD_SORT_MODES = [ {
    id: "name",
    icon: "format-justify-left-symbolic",
    label: "Name"
}, {
    id: "size",
    icon: "view-grid-symbolic",
    label: "Size"
}, {
    id: "mtime",
    icon: "document-open-recent-symbolic",
    label: "Date modified"
} ];

function deleteRecursive(file) {
    const info = file.query_info("standard::type", Gio.FileQueryInfoFlags.NONE, null);
    if (info.get_file_type() === Gio.FileType.DIRECTORY) {
        const enumerator = file.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let child;
        while ((child = enumerator.next_file(null)) !== null) deleteRecursive(file.get_child(child.get_name()));
        enumerator.close(null);
    }
    file.delete(null);
}

export class PrefsWindowControllerV2 extends PrefsWindowController {
    async build(window) {
        window.connect("close-request", () => {
            WidgetSettings.flushAll();
            return false;
        });
        const settings = new SettingsService(this._extensionObject ?? GLib.build_filenamev([ this.path, "schemas" ]));
        try {
            settings.init();
        } catch (e) {
            logError(e, "[widget-center] prefsV2: SettingsService.init() failed");
        }
        const languageOverride = settings.isReady ? settings.getGlobalValue("language") || undefined : undefined;
        this._i18n = await loadTranslations(GLib.build_filenamev([ this.path, "i18n" ]), languageOverride).catch(() => ({}));
        const storage = new StorageService;
        storage.init();
        const bundledWidgetsPath = GLib.build_filenamev([ this.path, "widgets" ]);
        const userWidgetsPath = GLib.build_filenamev([ GLib.get_user_data_dir(), "gnome-widget-center", "widgets" ]);
        const {ok: ok, errors: errors} = new PrefsWidgetList([ bundledWidgetsPath, userWidgetsPath ]).list();
        this._settings = settings;
        this._storage = storage;
        this._discovered = ok;
        this._bundledWidgetsPath = bundledWidgetsPath;
        this._userWidgetsPath = userWidgetsPath;
        const display = Gdk.Display.get_default();
        const monitor = display.get_monitors().get_item(0);
        const geometry = monitor.get_geometry();
        window.set_default_size(900, geometry.height);
        this._buildOverviewCardsTab(window, settings, ok);
        this._buildThemesCardsTab(window, settings, storage, ok);
        this._preferencesPage = this._buildPreferencesPage(window, settings, storage, ok, {
            bundledWidgetsPath: bundledWidgetsPath,
            userWidgetsPath: userWidgetsPath
        }, {
            includeAbout: false,
            layout: "accordion"
        });
        this._buildAboutTab(window);
        this._openRequestedWidgetPrefs(window, settings, storage, ok);
        if (settings.isReady) {
            const requestedIdHandlerId = settings.onChanged("requested-widget-id", value => {
                this._jumpToWidgetPrefs(window, settings, storage, ok, value);
            });
            window.connect("close-request", () => {
                settings.disconnect(requestedIdHandlerId);
                return false;
            });
        }
    }
    showBackupPage(window) {
        if (!this._preferencesPage || !this._accordionCategoriesById?.backup) return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                window.set_visible_page(this._preferencesPage);
                this._accordionCategoriesById.backup.expand();
            } catch (e) {
                logError(e, "[widget-center] prefsV2: showBackupPage() failed");
            }
            return GLib.SOURCE_REMOVE;
        });
    }
    _buildClampedCardPage(title, icon_name, content) {
        const page = new Adw.PreferencesPage({
            title: title,
            icon_name: icon_name
        });
        const group = new Adw.PreferencesGroup;
        const clamp = new Adw.Clamp({
            maximum_size: 800,
            tightening_threshold: 600
        });
        content.hexpand = true;
        content.vexpand = true;
        clamp.set_child(content);
        group.add(clamp);
        page.add(group);
        return page;
    }
    _buildCardFlowBox() {
        return new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            homogeneous: true,
            row_spacing: 20,
            column_spacing: 20,
            max_children_per_line: 2,
            min_children_per_line: 1,
            margin_top: 24,
            margin_bottom: 24,
            margin_start: 24,
            margin_end: 24,
            valign: Gtk.Align.START,
            hexpand: true
        });
    }
    _pathMtimeUnix(path) {
        try {
            const info = Gio.File.new_for_path(path).query_info("time::modified", Gio.FileQueryInfoFlags.NONE, null);
            return info.get_modification_date_time()?.to_unix() ?? 0;
        } catch (e) {
            return 0;
        }
    }
    _blockSizeCells(blockType) {
        const match = /^(\d+)x(\d+)$/.exec(blockType ?? "");
        if (!match) return 0;
        return Number(match[1]) * Number(match[2]);
    }
    _buildCardToolbar(flow, searchPlaceholder, initialSort, initialSearch, onSortChange, onSearchChange) {
        const bar = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            margin_top: 20,
            margin_start: 24,
            margin_end: 24
        });
        const sortBox = new Gtk.Box({
            spacing: 4,
            css_classes: [ "linked" ]
        });
        const sortButtons = {};
        for (const mode of CARD_SORT_MODES) {
            const button = new Gtk.ToggleButton({
                icon_name: mode.icon,
                tooltip_text: this._tr(`sort.${mode.id}`, mode.label),
                active: mode.id === initialSort
            });
            button.connect("toggled", () => {
                if (!button.get_active()) return;
                for (const [id, other] of Object.entries(sortButtons)) {
                    if (id !== mode.id) other.set_active(false);
                }
                onSortChange(mode.id);
                this._applyFlowSort(flow, mode.id);
            });
            sortButtons[mode.id] = button;
            sortBox.append(button);
        }
        bar.append(sortBox);
        const search = new Gtk.SearchEntry({
            placeholder_text: searchPlaceholder,
            hexpand: true
        });
        if (initialSearch) search.set_text(initialSearch);
        flow._searchQuery = (initialSearch ?? "").trim().toLowerCase();
        search.connect("search-changed", () => {
            const query = search.get_text().trim().toLowerCase();
            flow._searchQuery = query;
            onSearchChange(search.get_text());
            flow.invalidate_filter();
        });
        bar.append(search);
        flow.set_filter_func(child => {
            const query = flow._searchQuery;
            if (!query) return true;
            const card = child.get_child();
            if (!card || card._searchText === undefined) return true;
            return card._searchText.includes(query);
        });
        this._applyFlowSort(flow, initialSort);
        return bar;
    }
    _applyFlowSort(flow, mode) {
        flow.set_sort_func((a, b) => {
            const ka = a.get_child()?._sortKey?.[mode];
            const kb = b.get_child()?._sortKey?.[mode];
            if (ka === undefined || kb === undefined) return 0;
            if (typeof ka === "string" || typeof kb === "string") return String(ka).localeCompare(String(kb));
            return mode === "mtime" ? kb - ka : ka - kb;
        });
        flow.invalidate_sort();
    }
    _buildCardShell() {
        return new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: [ "card" ],
            width_request: 370,
            overflow: Gtk.Overflow.HIDDEN
        });
    }
    _buildIconTextButton(iconName, text, cssClasses = []) {
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6
        });
        content.append(new Gtk.Image({
            icon_name: iconName
        }));
        content.append(new Gtk.Label({
            label: text
        }));
        return new Gtk.Button({
            child: content,
            tooltip_text: text,
            css_classes: cssClasses
        });
    }
    _buildCardBanner(path) {
        const banner = new Gtk.Box({
            css_classes: [ "wc-card-banner" ],
            height_request: 160,
            valign: Gtk.Align.FILL
        });
        if (path) {
            const picture = new Gtk.Picture({
                content_fit: Gtk.ContentFit.COVER,
                hexpand: true,
                vexpand: true
            });
            picture.set_filename(path);
            banner.append(picture);
        } else {
            banner.append(new Gtk.Image({
                icon_name: "image-x-generic-symbolic",
                pixel_size: 48,
                hexpand: true,
                vexpand: true,
                css_classes: [ "dim-label" ]
            }));
        }
        return banner;
    }
    _resolveScreenshotPath(basePath, metadataOrManifest) {
        if (metadataOrManifest?.screenshotBase64) return this._decodedScreenshotCachePath(metadataOrManifest);
        const relative = metadataOrManifest?.screenshot;
        if (!relative) return null;
        const path = GLib.build_filenamev([ basePath, relative ]);
        return fileExists(path) ? path : null;
    }
    _decodedScreenshotCachePath(manifest) {
        const ext = (manifest.screenshotMime ?? "").includes("png") ? "png" : (manifest.screenshotMime ?? "").includes("webp") ? "webp" : "jpg";
        const cacheDir = GLib.build_filenamev([ GLib.get_user_cache_dir(), "gnome-widget-center", "thumbnails" ]);
        const cachePath = GLib.build_filenamev([ cacheDir, `${manifest.id}.${ext}` ]);
        if (fileExists(cachePath)) return cachePath;
        try {
            GLib.mkdir_with_parents(cacheDir, 493);
            const bytes = GLib.base64_decode(manifest.screenshotBase64);
            GLib.file_set_contents(cachePath, bytes);
            return cachePath;
        } catch (e) {
            logError(e, `[widget-center] prefsV2: could not decode screenshot for "${manifest.id}"`);
            return null;
        }
    }
    _buildOverviewCardsTab(window, settings, discovered) {
        if (this._overviewPage) {
            window.remove(this._overviewPage);
            this._overviewPage = null;
        }
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL
        });
        const scroll = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true
        });
        const flow = this._buildCardFlowBox();
        scroll.set_child(flow);
        this.applyAutoEnablePolicy(settings, discovered, this._userWidgetsPath);
        const disabled = new Set(settings.isReady ? settings.getGlobalValue("disabled-widgets") : []);
        if (discovered.length === 0) {
            flow.append(new Gtk.Label({
                label: this._tr("overview.empty", "No widgets found"),
                css_classes: [ "dim-label" ],
                margin_top: 48
            }));
        }
        for (const widget of discovered) {
            const isUser = pathIsUnder(widget.path, this._userWidgetsPath);
            const card = this._buildWidgetCard(window, settings, widget, disabled.has(widget.id), isUser);
            card._searchText = [ widget.name, widget.id, widget.description ].filter(Boolean).join(" ").toLowerCase();
            card._sortKey = {
                name: (widget.name ?? widget.id).toLowerCase(),
                size: this._blockSizeCells(widget.metadata?.["block-type"]),
                mtime: this._pathMtimeUnix(widget.path)
            };
            flow.append(card);
        }
        const toolbar = this._buildCardToolbar(flow, this._tr("overview.search.placeholder", "Search widgets…"), this._overviewSort ?? "name", this._overviewSearch ?? "", mode => {
            this._overviewSort = mode;
        }, text => {
            this._overviewSearch = text;
        });
        container.append(toolbar);
        container.append(scroll);
        const page = this._buildClampedCardPage(this._tr("tab.overview.label", "Overview"), "view-grid-symbolic", container);
        window.add(page);
        this._overviewPage = page;
    }
    _buildWidgetCard(window, settings, widget, isDisabled, isUser) {
        const card = this._buildCardShell();
        card.append(this._buildCardBanner(this._resolveScreenshotPath(widget.path, widget.metadata)));
        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 14,
            margin_end: 14
        });
        card.append(body);
        const title = new Gtk.Label({
            label: widget.name,
            xalign: 0,
            css_classes: [ "title-4" ],
            ellipsize: Pango.EllipsizeMode.END,
            single_line_mode: true
        });
        body.append(title);
        if (widget.description) {
            const desc = new Gtk.Label({
                label: widget.description,
                xalign: 0,
                wrap: true,
                lines: 2,
                ellipsize: Pango.EllipsizeMode.END,
                css_classes: [ "dim-label", "caption" ]
            });
            body.append(desc);
        }
        if (widget.metadata?.author) {
            body.append(new Gtk.Label({
                label: `by ${widget.metadata.author}`,
                xalign: 0,
                css_classes: [ "dim-label", "caption" ]
            }));
        }
        const controls = new Gtk.Box({
            spacing: 6,
            margin_top: 8,
            margin_bottom: 14,
            margin_start: 14,
            margin_end: 14
        });
        card.append(controls);
        const settingsButton = this._buildIconTextButton("emblem-system-symbolic", this._tr("overview.card.settings", "Settings"));
        settingsButton.sensitive = widget.hasConfigJson || widget.hasPrefs || widget.hasSettingsJs || widget.hasSettingsSchema;
        settingsButton.connect("clicked", () => {
            this._openWidgetPrefs(window, this._storage, widget).catch(e => logError(e, `[widget-center] prefsV2: opening settings for "${widget.id}" failed`));
        });
        controls.append(settingsButton);
        if (isUser) {
            const removeButton = this._buildIconTextButton("user-trash-symbolic", this._tr("overview.card.remove", "Uninstall"), [ "destructive-action" ]);
            removeButton.connect("clicked", async () => {
                const confirmed = await confirmOverwrite(window, this._tr("overview.card.remove_confirm_heading", "Remove this widget?"), this._tr("overview.card.remove_confirm_body", `This deletes "${widget.name}" from your user widgets folder. This cannot be undone.`), this._tr("overview.card.remove_confirm_button", "Remove"));
                if (!confirmed) return;
                this._removeUserWidget(settings, widget);
                this._discovered = this._discovered.filter(w => w.id !== widget.id);
                this._buildOverviewCardsTab(window, settings, this._discovered);
            });
            controls.append(removeButton);
        }
        controls.append(new Gtk.Box({
            hexpand: true
        }));
        const enableSwitch = new Gtk.Switch({
            active: !isDisabled,
            valign: Gtk.Align.CENTER,
            tooltip_text: this._tr("overview.card.enable_toggle", "Enable this widget")
        });
        const enableHandlerId = enableSwitch.connect("notify::active", () => {
            const ok = this._setWidgetEnabled(settings, widget.id, enableSwitch.active);
            if (!ok) {
                enableSwitch.block_signal_handler(enableHandlerId);
                enableSwitch.active = !enableSwitch.active;
                enableSwitch.unblock_signal_handler(enableHandlerId);
            }
        });
        controls.append(enableSwitch);
        return card;
    }
    _removeUserWidget(settings, widget) {
        try {
            deleteRecursive(Gio.File.new_for_path(widget.path));
        } catch (e) {
            logError(e, `[widget-center] prefsV2: could not remove widget "${widget.id}"`);
            return;
        }
        if (settings.isReady) {
            try {
                const current = new Set(settings.getGlobalValue("disabled-widgets"));
                current.delete(widget.id);
                settings.setGlobalValue("disabled-widgets", Array.from(current));
            } catch (e) {
                logError(e, `[widget-center] prefsV2: could not clean up disabled-widgets for "${widget.id}"`);
            }
        }
    }
    _buildThemesCardsTab(window, settings, storage, discoveredWidgets) {
        if (this._themesPage) {
            window.remove(this._themesPage);
            this._themesPage = null;
        }
        const container = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL
        });
        const scroll = new Gtk.ScrolledWindow({
            hexpand: true,
            vexpand: true
        });
        const flow = this._buildCardFlowBox();
        scroll.set_child(flow);
        const entries = this._discoverThemePacks();
        if (entries.length === 0) {
            flow.append(new Gtk.Label({
                label: this._tr("themes.empty", "No theme packs found"),
                css_classes: [ "dim-label" ],
                margin_top: 48
            }));
        }
        for (const entry of entries) {
            const card = this._buildThemeCard(window, settings, entry);
            card._searchText = [ entry.manifest?.name, entry.id, entry.manifest?.description ].filter(Boolean).join(" ").toLowerCase();
            card._sortKey = {
                name: (entry.manifest?.name ?? entry.id).toLowerCase(),
                size: entry.widgetCount ?? (entry.manifest?.widgets?.length ?? 0),
                mtime: this._pathMtimeUnix(entry.path)
            };
            flow.append(card);
        }
        const toolbar = this._buildCardToolbar(flow, this._tr("themes.search.placeholder", "Search themes…"), this._themesSort ?? "name", this._themesSearch ?? "", mode => {
            this._themesSort = mode;
        }, text => {
            this._themesSearch = text;
        });
        container.append(toolbar);
        container.append(scroll);
        const page = this._buildClampedCardPage(this._tr("tab.themes.label", "Themes"), "preferences-desktop-wallpaper-symbolic", container);
        window.add(page);
        this._themesPage = page;
    }
    _discoverThemePacks() {
        const bundledPath = GLib.build_filenamev([ this.path, "themepacks" ]);
        const userPath = GLib.build_filenamev([ GLib.get_user_config_dir(), "gnome-widget-center", "themepacks" ]);
        this._userThemepacksPath = userPath;
        const registry = new ThemePackRegistry([ {
            path: bundledPath,
            source: "bundled"
        }, {
            path: userPath,
            source: "user"
        } ]);
        return registry.discover();
    }
    _buildThemeCard(window, settings, entry) {
        const {manifest: manifest, path: path, source: source} = entry;
        const card = this._buildCardShell();
        card.append(this._buildCardBanner(this._resolveScreenshotPath(path, manifest)));
        const body = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 14,
            margin_end: 14
        });
        card.append(body);
        body.append(new Gtk.Label({
            label: manifest.name ?? entry.id,
            xalign: 0,
            css_classes: [ "title-4" ],
            ellipsize: Pango.EllipsizeMode.END,
            single_line_mode: true
        }));
        if (manifest.description) {
            body.append(new Gtk.Label({
                label: manifest.description,
                xalign: 0,
                wrap: true,
                lines: 2,
                ellipsize: Pango.EllipsizeMode.END,
                css_classes: [ "dim-label", "caption" ]
            }));
        }
        const metaBits = [];
        if (manifest.author) metaBits.push(`by ${manifest.author}`);
        metaBits.push(`${(manifest.widgets ?? []).length} widgets`);
        body.append(new Gtk.Label({
            label: metaBits.join(" · "),
            xalign: 0,
            css_classes: [ "dim-label", "caption" ]
        }));
        const controls = new Gtk.Box({
            spacing: 8,
            margin_top: 8,
            margin_bottom: 14,
            margin_start: 14,
            margin_end: 14
        });
        card.append(controls);
        controls.append(new Gtk.Box({
            hexpand: true
        }));
        const statusSwitch = new Gtk.Switch({
            active: this._isThemePackActive(entry.id),
            valign: Gtk.Align.CENTER,
            tooltip_text: this._isThemePackActive(entry.id) ? this._tr("themes.card.active", "Active") : this._tr("themes.card.inactive", "Not loaded")
        });
        statusSwitch.connect("notify::active", () => {
            if (statusSwitch.active) {
                this._applyThemePack(settings, entry);
            } else if (this._isThemePackActive(entry.id)) {
                try {
                    settings.setGlobalValue("active-theme-pack", "");
                } catch (e) {
                    logError(e, `[widget-center] prefsV2: could not clear active theme pack`);
                }
            }
        });
        controls.append(statusSwitch);
        if (source === "user") {
            const removeButton = new Gtk.Button({
                icon_name: "window-close-symbolic",
                tooltip_text: this._tr("themes.card.remove", "Uninstall"),
                css_classes: [ "circular", "osd" ],
                halign: Gtk.Align.END,
                valign: Gtk.Align.START,
                margin_top: 8,
                margin_end: 8
            });
            removeButton.connect("clicked", async () => {
                const confirmed = await confirmOverwrite(window, this._tr("themes.card.remove_confirm_heading", "Remove this theme pack?"), this._tr("themes.card.remove_confirm_body", `This deletes "${manifest.name ?? entry.id}" from your themepacks folder. This cannot be undone.`), this._tr("themes.card.remove_confirm_button", "Remove"));
                if (!confirmed) return;
                try {
                    deleteRecursive(Gio.File.new_for_path(path));
                } catch (e) {
                    logError(e, `[widget-center] prefsV2: could not remove theme pack "${entry.id}"`);
                    return;
                }
                if (this._themesPage) {
                    window.remove(this._themesPage);
                    this._themesPage = null;
                }
                this._buildThemesCardsTab(window, settings, this._storage, this._discovered);
            });
            const overlay = new Gtk.Overlay;
            const banner = card.get_first_child();
            card.remove(banner);
            overlay.set_child(banner);
            overlay.add_overlay(removeButton);
            card.prepend(overlay);
        }
        return card;
    }
    _isThemePackActive(id) {
        if (!this._settings?.isReady) return false;
        try {
            return this._settings.getGlobalValue("active-theme-pack") === id;
        } catch (e) {
            return false;
        }
    }
    _applyThemePack(settings, entry) {
        if (!settings.isReady) return;
        try {
            settings.setGlobalValue("active-theme-pack", entry.id);
        } catch (e) {
            logError(e, `[widget-center] prefsV2: could not apply theme pack "${entry.id}"`);
        }
    }
    _buildAboutTab(window) {
        const page = new Adw.PreferencesPage({
            title: this._tr("tab.about.label", "About"),
            icon_name: "help-about-symbolic"
        });
        window.add(page);
        const headerGroup = new Adw.PreferencesGroup;
        page.add(headerGroup);
        const headerBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            halign: Gtk.Align.CENTER,
            margin_top: 24,
            margin_bottom: 12
        });
        const logoPath = GLib.build_filenamev([ this.path, "assets", "icon.svg" ]);
        if (fileExists(logoPath)) {
            const logo = new Gtk.Picture({
                content_fit: Gtk.ContentFit.CONTAIN,
                width_request: 96,
                height_request: 96,
                halign: Gtk.Align.CENTER
            });
            logo.set_filename(logoPath);
            headerBox.append(logo);
        } else {
            headerBox.append(new Gtk.Image({
                icon_name: "preferences-desktop-applications-symbolic",
                pixel_size: 96
            }));
        }
        headerBox.append(new Gtk.Label({
            label: this.metadata.name ?? "GNOME Widget Center",
            css_classes: [ "title-1" ],
            justify: Gtk.Justification.CENTER
        }));
        headerBox.append(new Gtk.Label({
            label: this._tr("about.tagline", "A desktop widget platform for GNOME Shell"),
            css_classes: [ "dim-label" ],
            justify: Gtk.Justification.CENTER,
            wrap: true
        }));
        headerGroup.add(headerBox);
        const detailsGroup = new Adw.PreferencesGroup({
            title: this._tr("about.details.title", "Details")
        });
        page.add(detailsGroup);
        const versionRow = new Adw.ActionRow({
            title: this._tr("about.version", "Version")
        });
        versionRow.add_suffix(new Gtk.Label({
            label: String(this.metadata.version ?? "—"),
            css_classes: [ "dim-label" ]
        }));
        detailsGroup.add(versionRow);
        detailsGroup.add(new Adw.ActionRow({
            title: this._tr("about.license", "License"),
            subtitle: "GNU General Public License v3.0"
        }));
        if (this.metadata.url) {
            const sourceRow = new Adw.ActionRow({
                title: this._tr("about.source", "Source code"),
                subtitle: this.metadata.url,
                activatable: true
            });
            sourceRow.add_suffix(new Gtk.Image({
                icon_name: "adw-external-link-symbolic"
            }));
            sourceRow.connect("activated", () => Gtk.show_uri(window, this.metadata.url, Gdk.CURRENT_TIME));
            detailsGroup.add(sourceRow);
        }
        const aboutGroup = new Adw.PreferencesGroup({
            title: this._tr("about.project.title", "About this project")
        });
        page.add(aboutGroup);
        const aboutText = this._tr("about.project.body", "GNOME Widget Center brings desktop widgets to GNOME Shell, in the spirit " + "of KDE Plasma widgets, while following the GNOME Human Interface Guidelines. " + "It discovers and loads widget plugins from a folder — either bundled with the " + "extension or installed under your own user data directory — and renders them " + "on the desktop with free, pixel-precise placement and collision-aware " + "drag-and-drop editing. Every widget gets its own settings page, generated " + "automatically from a declarative configuration file, or a fully hand-written " + "one for anything more custom. This Control Center is where you manage which " + "widgets are installed and enabled (Overview), browse and apply shareable theme " + "packs (Themes), and configure the extension's own appearance and behavior " + "(Preferences).");
        const aboutLabel = new Gtk.Label({
            label: aboutText,
            wrap: true,
            xalign: 0,
            margin_top: 6,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6
        });
        aboutGroup.add(aboutLabel);
        const techRow = new Adw.ActionRow({
            title: this._tr("about.technology", "Built with"),
            subtitle: "GJS · GTK4 · Libadwaita · GObject/GSettings"
        });
        aboutGroup.add(techRow);
    }
}