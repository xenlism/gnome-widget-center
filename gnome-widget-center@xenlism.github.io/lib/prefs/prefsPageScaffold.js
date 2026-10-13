// prefsPageScaffold.js - Preferences window scaffolding: the Preferences tab and its category accordion.
import Adw from "gi://Adw";
import Gtk from "gi://Gtk";
import GLib from "gi://GLib";
import { buildStoreSettings } from "./storePage.js";

export const PrefsPageScaffoldMixin = Base => class extends Base {
    // Preferences > Store: release channel, update interval, repositories, rollback.
    _buildStoreCategory(window) {
        const page = new Adw.PreferencesPage;
        buildStoreSettings(page, window, (k, d) => this._tr(k, d)).catch(e => logError(e, "[widget-center] prefs: store settings failed"));
        return page;
    }

    _buildPreferencesPage(window, settings, storage, discoveredWidgets, widgetPaths, options = {}) {
        const page = new Adw.PreferencesPage({
            title: this._tr("tab.preferences.label", "Preferences"),
            icon_name: "preferences-system-symbolic"
        });
        window.add(page);
        const group = new Adw.PreferencesGroup;
        page.add(group);
        const categories = [ {
            id: "general",
            title: this._tr("category.general", "General"),
            subtitle: this._tr("category.general.subtitle", "General settings and behavior"),
            icon: "preferences-system-symbolic",
            build: () => this._buildGeneralCategory(settings)
        }, {
            id: "appearance",
            title: this._tr("category.appearance", "Appearance"),
            subtitle: this._tr("category.appearance.subtitle", "Theme, colors and layout"),
            icon: "applications-graphics-symbolic",
            build: () => this._buildAppearanceCategory(settings, storage, discoveredWidgets)
        }, {
            id: "desktop",
            title: this._tr("category.desktop", "Desktop"),
            subtitle: this._tr("category.desktop.subtitle", "Margins, spacing and position"),
            icon: "video-display-symbolic",
            build: () => this._buildDesktopCategory(settings)
        }, {
            id: "interactions",
            title: this._tr("category.interactions", "Interactions"),
            subtitle: this._tr("category.interactions.subtitle", "Dragging, animations and actions"),
            icon: "input-mouse-symbolic",
            build: () => this._buildInteractionsCategory(settings)
        }, {
            id: "store",
            title: this._tr("category.store", "Store"),
            subtitle: this._tr("category.store.subtitle", "Release channel, repositories and rollback"),
            icon: "folder-download-symbolic",
            build: () => this._buildStoreCategory(window)
        }, {
            id: "backup",
            title: this._tr("category.backup", "Backup and Restore"),
            subtitle: this._tr("category.backup.subtitle", "Backup and restore widgets"),
            icon: "drive-multidisk-symbolic",
            build: () => this._buildBackupCategory(window, settings, storage, discoveredWidgets, widgetPaths)
        }, {
            id: "importexport",
            title: this._tr("category.importexport", "Import / Export"),
            subtitle: this._tr("category.importexport.subtitle", "Import or export widget data"),
            icon: "send-to-symbolic",
            build: () => this._buildImportExportCategory(window, storage, discoveredWidgets)
        }, {
            id: "advanced",
            title: this._tr("category.advanced", "Advanced"),
            subtitle: this._tr("category.advanced.subtitle", "Advanced developer options"),
            icon: "applications-engineering-symbolic",
            build: () => this._buildAdvancedCategory(window, settings, storage, discoveredWidgets)
        } ];
        if (options.includeAbout !== false) {
            categories.push({
                id: "about",
                title: this._tr("category.about", "About"),
                subtitle: this._tr("category.about.subtitle", "About GNOME Widget Center"),
                icon: "help-about-symbolic",
                build: () => this._buildAboutCategory()
            });
        }
        group.add(this._buildCategoryAccordion(categories));
        return page;
    }

    _buildCategoryAccordion(categories) {
        const clamp = new Adw.Clamp({
            maximum_size: 800,
            tightening_threshold: 800
        });
        const list = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 24,
            margin_start: 12,
            margin_end: 12
        });
        clamp.set_child(list);
        this._accordionCategoriesById = {};
        categories.forEach((category, index) => {
            const {widget: widget, expand: expand} = this._buildAccordionCategory(category);
            list.append(widget);
            this._accordionCategoriesById[category.id] = {
                widget: widget,
                expand: expand
            };
            if (index === 0) expand();
        });
        return clamp;
    }

    _buildAccordionCategory(category) {
        const outer = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            css_classes: [ "card" ],
            overflow: Gtk.Overflow.HIDDEN
        });
        const headerList = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: [ "boxed-list" ]
        });
        const headerRow = new Adw.ActionRow({
            title: category.title,
            subtitle: category.subtitle,
            activatable: true
        });
        headerRow.add_prefix(new Gtk.Image({
            icon_name: category.icon
        }));
        const chevron = new Gtk.Image({
            icon_name: "pan-end-symbolic"
        });
        headerRow.add_suffix(chevron);
        headerList.append(headerRow);
        outer.append(headerList);
        const revealer = new Gtk.Revealer({
            transition_type: Gtk.RevealerTransitionType.SLIDE_DOWN,
            reveal_child: false
        });
        outer.append(revealer);
        let built = false;
        const setExpanded = expanded => {
            revealer.reveal_child = expanded;
            chevron.icon_name = expanded ? "pan-down-symbolic" : "pan-end-symbolic";
            if (expanded && !built) {
                built = true;
                const content = category.build();
                content.vexpand = false;
                revealer.set_child(content);
            }
        };
        headerList.connect("row-activated", () => setExpanded(!revealer.reveal_child));
        return {
            widget: outer,
            expand: () => setExpanded(true)
        };
    }

    _buildComingSoonCategory(title, description) {
        return new Adw.StatusPage({
            icon_name: "view-more-symbolic",
            title: title,
            description: description,
            vexpand: true
        });
    }
};
