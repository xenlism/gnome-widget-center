import GLib from "gi://GLib";

import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import { fileExists } from "./fsUtils.js";

import { pickTranslation } from "./i18nUtils.js";

import { WidgetSettings } from "./widgetSettings.js";

import { buildSettingsPage } from "./settingsSchemaUI.js";

import { readWidgetConfig } from "./widgetConfigReader.js";

import { buildConfigPage } from "./widgetConfigUI.js";

import { createGwcContext, validateSchema } from "./settingsApi.js";

import { SettingsStore } from "./settingsStore.js";

import { buildGroup as buildSettingsJsGroup } from "./settingsRenderer.js";

import { ThemeService } from "./themeService.js";

import { rgbaToHex } from "./colorUtils.js";

import { loadTranslations } from "../i18n/index.js";

export const PrefsWidgetManagementMixin = Base => class extends Base {
    applyAutoEnablePolicy(settings, discoveredIds) {
        if (!settings?.isReady) return new Set;
        let known, disabled;
        try {
            known = new Set(settings.getGlobalValue("known-widget-ids"));
            disabled = new Set(settings.getGlobalValue("disabled-widgets"));
        } catch (e) {
            logError(e, "[widget-center] prefs: could not read known-widget-ids/disabled-widgets");
            return new Set;
        }
        const autoEnable = !!settings.getGlobalValue("auto-enable-new-widgets");
        let knownChanged = false;
        let disabledChanged = false;
        for (const id of discoveredIds) {
            if (known.has(id)) continue;
            known.add(id);
            knownChanged = true;
            if (!autoEnable && !disabled.has(id)) {
                disabled.add(id);
                disabledChanged = true;
            }
        }
        if (knownChanged) {
            try {
                settings.setGlobalValue("known-widget-ids", Array.from(known));
            } catch (e) {
                logError(e, "[widget-center] prefs: could not save known-widget-ids");
            }
        }
        if (disabledChanged) {
            try {
                settings.setGlobalValue("disabled-widgets", Array.from(disabled));
            } catch (e) {
                logError(e, "[widget-center] prefs: could not save disabled-widgets (auto-enable policy)");
            }
        }
        return disabled;
    }
    jumpToWidget(window, widgetId) {
        this._jumpToWidgetPrefs(window, this._settings, this._storage, this._discovered, widgetId);
    }
    _openRequestedWidgetPrefs(window, settings, storage, discovered) {
        if (!settings.isReady) return;
        let requestedId;
        try {
            requestedId = settings.getGlobalValue("requested-widget-id");
        } catch (e) {
            logError(e, "[widget-center] prefs: could not read requested-widget-id");
            return;
        }
        this._jumpToWidgetPrefs(window, settings, storage, discovered, requestedId);
    }
    _jumpToWidgetPrefs(window, settings, storage, discovered, requestedId) {
        if (!requestedId) return;
        try {
            settings.setGlobalValue("requested-widget-id", "");
        } catch (e) {
            logError(e, "[widget-center] prefs: could not clear requested-widget-id");
        }
        const widget = discovered.find(w => w.id === requestedId);
        if (!widget) {
            logError(new Error(`requested-widget-id "${requestedId}" not found among discovered widgets`));
            return;
        }
        if (!widget.hasConfigJson && !widget.hasPrefs && !widget.hasSettingsSchema && !widget.metadata?.["themeable"]) return;
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._openWidgetPrefs(window, storage, widget).catch(e => logError(e, `[widget-center] prefs: opening requested settings for "${widget.id}" failed`));
            return GLib.SOURCE_REMOVE;
        });
    }
    _buildWidgetRow(window, settings, storage, widget, isDisabled) {
        const row = new Adw.SwitchRow({
            title: widget.name,
            subtitle: widget.description,
            active: !isDisabled
        });
        this._loadWidgetI18n(widget).then(translations => {
            row.title = this._t(translations, "meta.name", widget.name);
            row.subtitle = this._t(translations, "meta.description", widget.description);
        }).catch(() => {});
        const handlerId = row.connect("notify::active", () => {
            const ok = this._setWidgetEnabled(settings, widget.id, row.active);
            if (!ok) {
                row.block_signal_handler(handlerId);
                row.active = !row.active;
                row.unblock_signal_handler(handlerId);
            }
        });
        if (widget.hasConfigJson || widget.hasPrefs || widget.hasSettingsSchema || widget.metadata?.["themeable"]) {
            const settingsButton = new Gtk.Button({
                icon_name: "go-next-symbolic",
                valign: Gtk.Align.CENTER,
                css_classes: [ "flat" ],
                tooltip_text: `${widget.name} settings`
            });
            settingsButton.connect("clicked", () => {
                this._openWidgetPrefs(window, storage, widget).catch(e => logError(e, `[widget-center] prefs: opening settings for "${widget.id}" failed`));
            });
            row.add_suffix(settingsButton);
        }
        return row;
    }
    _loadWidgetI18n(widget) {
        const languageOverride = this._settings?.isReady ? this._settings.getGlobalValue("language") || undefined : undefined;
        return loadTranslations(GLib.build_filenamev([ widget.path, "i18n" ]), languageOverride).catch(() => ({}));
    }
    _t(translations, key, fallback) {
        return pickTranslation(translations, key, fallback);
    }
    _setWidgetEnabled(settings, widgetId, enabled) {
        if (!settings.isReady) {
            logError(new Error(`SettingsService not ready — could not ${enabled ? "enable" : "disable"} "${widgetId}"`));
            return false;
        }
        try {
            const current = new Set(settings.getGlobalValue("disabled-widgets"));
            if (enabled) current.delete(widgetId); else current.add(widgetId);
            settings.setGlobalValue("disabled-widgets", Array.from(current));
            return true;
        } catch (e) {
            logError(e, `could not ${enabled ? "enable" : "disable"} "${widgetId}"`);
            return false;
        }
    }
    async _openWidgetPrefs(window, storage, widget) {
        const translations = await this._loadWidgetI18n(widget);
        const title = this._t(translations, "meta.name", widget.name);
        if (widget.hasConfigJson) {
            const {config: config, errors: errors} = readWidgetConfig(widget.path);
            if (config) {
                const settingsHandle = WidgetSettings.load(widget.id, storage);
                const prefsPage = buildConfigPage(config, settingsHandle, title, widget.path, translations);
                this._appendWidgetAppearanceGroup(prefsPage, widget);
                this._presentPrefsPage(window, widget, prefsPage);
                return;
            }
            logError(new Error(`config.json for "${widget.id}" invalid: ${errors.map(e => e.message).join("; ")}`));
        }
        if (widget.hasPrefs) {
            this._openHandWrittenPrefs(window, storage, widget);
            return;
        }
        if (widget.hasSettingsJs) {
            this._openWidgetSettingsJsPrefs(window, widget, title);
            return;
        }
        const settingsHandle = WidgetSettings.load(widget.id, storage);
        const prefsPage = buildSettingsPage(widget.metadata.settings ?? [], settingsHandle, title);
        this._appendWidgetAppearanceGroup(prefsPage, widget);
        this._presentPrefsPage(window, widget, prefsPage);
    }
    _openWidgetSettingsJsPrefs(window, widget, title) {
        const entryPath = GLib.build_filenamev([ widget.path, "settings.js" ]);
        if (!fileExists(entryPath)) {
            logError(new Error(`settings.js not found for "${widget.id}"`));
            return;
        }
        import(`file://${entryPath}`).then(module => {
            if (typeof module.defineSettings !== "function") throw new Error(`settings.js for "${widget.id}" has no defineSettings() export`);
            const gwc = createGwcContext(widget.id);
            module.defineSettings(gwc);
            const schema = gwc.settings.build();
            validateSchema(schema);
            const store = new SettingsStore(widget.id, schema.fields);
            const prefsPage = new Adw.PreferencesPage({
                title: title
            });
            for (const group of buildSettingsJsGroup(schema, store, {
                title: title
            })) prefsPage.add(group);
            this._appendWidgetAppearanceGroup(prefsPage, widget);
            this._presentPrefsPage(window, widget, prefsPage, () => store.destroy());
        }).catch(e => {
            logError(e, `[widget-center] prefs: failed to open settings.js for "${widget.id}"`);
        });
    }
    _appendWidgetAppearanceGroup(prefsPage, widget) {
        if (!widget.metadata?.["themeable"]) return;
        const theme = new ThemeService;
        theme.init();
        const global = theme.getGlobalTheme();
        const {config: config} = theme.getWidgetTheme(widget.id);
        const widgetBackground = config.background ?? {};
        const widgetCornerRadius = config.cornerRadius ?? {};
        const group = new Adw.PreferencesGroup({
            title: "Appearance",
            description: "This widget's own background and corner radius. Set in the " + 'Control Center\'s Appearance page, "Force" can override these for every widget.'
        });
        prefsPage.add(group);
        const bgForced = !!global.background.force;
        const transparentRow = new Adw.SwitchRow({
            title: "Transparent",
            active: bgForced ? !!global.background.transparent : !!widgetBackground.transparent,
            sensitive: !bgForced,
            subtitle: bgForced ? "Forced by the global Appearance settings." : null
        });
        group.add(transparentRow);
        const colorRow = new Adw.ActionRow({
            title: "Background color",
            sensitive: !bgForced
        });
        const rgba = new Gdk.RGBA;
        rgba.parse((bgForced ? global.background.color : widgetBackground.color) ?? "#1e1e2e");
        const colorButton = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog,
            rgba: rgba,
            valign: Gtk.Align.CENTER,
            sensitive: !bgForced
        });
        colorRow.add_suffix(colorButton);
        colorRow.set_activatable_widget(colorButton);
        group.add(colorRow);
        if (!bgForced) {
            const saveBackground = () => {
                theme.setWidgetTheme(widget.id, {
                    config: {
                        background: {
                            transparent: transparentRow.active,
                            color: rgbaToHex(colorButton.rgba)
                        }
                    }
                });
            };
            transparentRow.connect("notify::active", saveBackground);
            colorButton.connect("notify::rgba", saveBackground);
        }
        const radiusForced = !!global.cornerRadius.force;
        const radiusRow = new Adw.SpinRow({
            title: "Corner radius",
            subtitle: radiusForced ? "Forced by the global Appearance settings." : "0–64 px",
            adjustment: new Gtk.Adjustment({
                lower: 0,
                upper: 64,
                step_increment: 1,
                value: (radiusForced ? global.cornerRadius.value : widgetCornerRadius.value) ?? 12
            }),
            sensitive: !radiusForced
        });
        group.add(radiusRow);
        if (!radiusForced) {
            radiusRow.connect("notify::value", () => {
                theme.setWidgetTheme(widget.id, {
                    config: {
                        cornerRadius: {
                            value: radiusRow.value
                        }
                    }
                });
            });
        }
    }
    _presentPrefsPage(window, widget, prefsPage, onClose = () => {}) {
        const actionsGroup = new Adw.PreferencesGroup;
        const buttonBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8,
            halign: Gtk.Align.END
        });
        const saveButton = new Gtk.Button({
            label: "Save & Close",
            css_classes: [ "suggested-action" ]
        });
        saveButton.connect("clicked", () => {
            WidgetSettings.flush(widget.id);
            onClose();
            window.close_subpage();
        });
        buttonBox.append(saveButton);
        actionsGroup.add(buttonBox);
        prefsPage.add(actionsGroup);
        window.present_subpage(prefsPage);
    }
    _openHandWrittenPrefs(window, storage, widget) {
        const entryPath = GLib.build_filenamev([ widget.path, widget.metadata.prefs ]);
        if (!fileExists(entryPath)) {
            logError(new Error(`prefs entry "${widget.metadata.prefs}" not found for "${widget.id}"`));
            return;
        }
        import(`file://${entryPath}`).then(module => {
            if (typeof module.default !== "function") throw new Error(`${widget.metadata.prefs} has no default export class`);
            const settingsHandle = WidgetSettings.load(widget.id, storage);
            const prefsInstance = new module.default(settingsHandle);
            const prefsPage = prefsInstance.buildPrefsWidget();
            this._appendWidgetAppearanceGroup(prefsPage, widget);
            this._presentPrefsPage(window, widget, prefsPage);
        }).catch(e => {
            logError(e, `[widget-center] prefs: failed to open settings for "${widget.id}"`);
        });
    }
};