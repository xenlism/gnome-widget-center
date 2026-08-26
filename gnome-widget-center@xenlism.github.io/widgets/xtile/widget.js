import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import St from "gi://St";

import { ModalDialog } from "resource:///org/gnome/shell/ui/modalDialog.js";

import { readTextFile } from "../../lib/fsUtils.js";
import { createChildWidgetFromParent } from "../../lib/architectWidgetKit.js";
import { findAppInfoByQuery, getAppInfoFromFilename } from "../../lib/utils.js";
import {
    parseFontDescription as _parseFontDescription,
    toCssColor as _toCssColor,
    deferUntilMapped as _deferUntilMapped
} from "../../lib/widgetVisualKit.js";
import { createLayeredCard, applyLayeredCardStyle } from "../../lib/cardLayers.js";
import { getAccentColorForApp } from "../../lib/iconAccentColor.js";
import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";

const CARD_PADDING = 14;
const DEFAULT_ICON_SIZE = 64;
// Neutral dark slate - used whenever accent extraction can't produce a
// color at all (no app selected, icon not found, decode failure).
const FALLBACK_ACCENT = "#2E3436F0";

// Base widget of the Xtile series. Holds all real behavior - layout,
// click-to-launch, accent-color rendering. This used to live in
// widgets/xtile-firefox/widget.js and get imported back into this
// Architect widget, which meant xtile-firefox had to be installed
// just for xtile to load at all. It now lives here instead, so this
// widget - the generic "Add Widget"-capable Architect - is fully
// self-contained. xtile-firefox (and any other sibling tile: chrome,
// terminal, gimp, inkscape, ...) imports it FROM here:
//
//   import { XtileBaseWidget } from "../xtile/widget.js";
//   import { configJsonDefaults } from "../../lib/widgetConfigDefaults.js";
//
//   export default class XtileChromeWidget extends XtileBaseWidget {
//       getDefaultSettings() {
//           return { ...configJsonDefaults(import.meta.url) };
//       }
//   }
//
// That override is required (not boilerplate you can skip) because
// import.meta.url is resolved per *file*, not per *class instance* -
// if a sibling only inherited getDefaultSettings() from this file
// unchanged, configJsonDefaults() would read THIS folder's
// config.json instead of the sibling's own. Everything else - which
// app launches, its icon size, its label, its accent color - is
// controlled entirely by that sibling's own config.json, never by
// editing widget.js again.
export class XtileBaseWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._pressId = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "xtile-root",
            reactive: true
        });
        this._actor = this._layers.root;

        // this._content is a plain padding/layout wrapper - a child of
        // layers.content, not the Content Layer itself (R5).
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true
        });
        this._layers.content.add_child(this._content);

        // Icon: wrapped in a y_expand Bin so it centers in whatever
        // space is left above the label (which sizes to its own
        // natural height and sits last, i.e. at the bottom).
        const iconBin = new St.Bin({
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER
        });
        this._icon = new St.Icon({
            icon_size: DEFAULT_ICON_SIZE
        });
        iconBin.set_child(this._icon);
        this._content.add_child(iconBin);

        this._label = new St.Label({
            text: "",
            x_align: Clutter.ActorAlign.CENTER
        });
        this._content.add_child(this._label);

        this._pressId = this._actor.connect("button-press-event", (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) return Clutter.EVENT_PROPAGATE;
            if (event.get_state() & Clutter.ModifierType.MOD4_MASK) return Clutter.EVENT_PROPAGATE;
            this._launch();
            return Clutter.EVENT_STOP;
        });

        this._render();
        return this._actor;
    }

    enable() {}

    disable() {
        if (this._actor && this._pressId !== null) {
            try {
                this._actor.disconnect(this._pressId);
            } catch (e) {}
        }
        this._pressId = null;
    }

    onSettingsChanged() {
        this._render();
    }

    // Every Xtile sibling MUST override this one method - see the file
    // header. This base implementation would otherwise read THIS
    // folder's config.json for every subclass, which is wrong for all
    // of them but the Architect widget itself.
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url)
        };
    }

    _desktopPath() {
        const apps = Array.isArray(this._settings.app) ? this._settings.app : [];
        return apps[0] ?? null;
    }

    _appInfo() {
        const path = this._desktopPath();
        if (!path) return null;
        try {
            return getAppInfoFromFilename(path);
        } catch (e) {
            this._api.logger.info(`xtile: could not read ${path}: ${e}`);
            return null;
        }
    }

    _launch() {
        const appInfo = this._appInfo();
        if (!appInfo) {
            this._api.logger.info("xtile: no application configured for this tile");
            return;
        }
        try {
            appInfo.launch([], null);
        } catch (e) {
            this._api.logger.info(`xtile: failed to launch app: ${e}`);
        }
    }

    _render() {
        if (!this._actor) return;
        const settings = this._settings;
        const appInfo = this._appInfo();

        // Icon
        const iconSize = Number.isFinite(settings.iconSize) ? settings.iconSize : DEFAULT_ICON_SIZE;
        this._icon.icon_size = iconSize;
        const gicon = appInfo?.get_icon();
        if (gicon) this._icon.set_gicon(gicon); else this._icon.set_icon_name("application-x-executable-symbolic");

        // Label
        const showLabel = settings.showLabel ?? true;
        if (showLabel) {
            const custom = (settings.labelText ?? "").trim();
            const name = custom || appInfo?.get_display_name() || appInfo?.get_name() || "No app selected";
            this._label.set_text(name);
            this._label.show();
            const font = _parseFontDescription(settings.labelFont ?? "Sans Bold 11", "Sans Bold", 11);
            const color = _toCssColor(settings.labelColor ?? "#FFFFFFFF", "#FFFFFFFF");
            this._label.set_style(`font-family: ${font.family}; font-size: ${font.size}px; color: ${color}; padding-top: 8px;`);
        } else {
            this._label.hide();
        }

        // Card background: auto-tint from the app icon unless the user
        // turned that off, in which case the Appearance tab's own
        // backgroundColor (already in `settings` via the merged
        // appearance fields) is used untouched.
        const useAccent = settings.useIconAccentColor ?? true;
        let effectiveSettings = settings;
        if (useAccent) {
            const strengthPct = Number.isFinite(settings.accentStrength) ? settings.accentStrength : 70;
            const accent = getAccentColorForApp(appInfo, FALLBACK_ACCENT, strengthPct / 100);
            effectiveSettings = {
                ...settings,
                backgroundColor: accent
            };
        }

        _deferUntilMapped(this._actor, () => {
            applyLayeredCardStyle(this._layers, effectiveSettings, {
                cornerRadiusFallback: 18
            });
            this._content.set_style(`padding: ${CARD_PADDING}px;`);
        });
    }
}

export default class XtileArchitectWidget extends XtileBaseWidget {
    constructor(api) {
        super(api);
        this._metadata = JSON.parse(readTextFile(GLib.build_filenamev([ api.path.me, "metadata.json" ])));

        if (this._metadata.parent) this._addChild = undefined;
    }

    getDefaultSettings() {
        return {};
    }

    async _addChild() {
        const result = await this._promptNameAndApp();
        if (!result) return;
        const { name, appInfo } = result;
        const desktopPath = appInfo.get_filename();
        if (!desktopPath) {
            this._api.logger.info("xtile: selected app has no .desktop file path, cannot create tile");
            return;
        }
        try {
            const { id } = createChildWidgetFromParent(this._api, this._metadata, name, {
                name,
                configOverrides: {
                    app: [ desktopPath ],
                    labelText: name
                }
            });
            this._api.logger.info(`xtile: created child "${id}" for ${desktopPath}`);
        } catch (e) {
            this._api.logger.error(`xtile: failed to create child: ${e.message}`);
        }
    }

    _promptNameAndApp() {
        return new Promise(resolve => {
            const dialog = new ModalDialog({
                styleClass: "xtile-architect-dialog"
            });
            const box = new St.BoxLayout({
                vertical: true,
                style_class: "xtile-architect-dialog-box"
            });

            const nameEntry = new St.Entry({
                style_class: "xtile-architect-name-entry",
                hint_text: "App name (e.g. \u201cDiscord\u201d)",
                can_focus: true
            });
            box.add_child(nameEntry);

            const resultLabel = new St.Label({
                style_class: "xtile-architect-app-result",
                text: ""
            });
            box.add_child(resultLabel);

            dialog.contentLayout.add_child(box);

            let matchedAppInfo = null;
            const updateMatch = () => {
                const query = nameEntry.get_text();
                matchedAppInfo = findAppInfoByQuery(query);
                if (matchedAppInfo) {
                    const displayName = matchedAppInfo.get_display_name() || matchedAppInfo.get_name() || query.trim();
                    resultLabel.set_text(`Found: ${displayName}`);
                } else {
                    resultLabel.set_text(query.trim() ? "No matching app" : "");
                }
            };
            nameEntry.clutter_text.connect("text-changed", updateMatch);

            let resolved = false;
            const finish = value => {
                if (resolved) return;
                resolved = true;
                dialog.close();
                resolve(value);
            };

            const confirm = () => {
                const name = nameEntry.get_text()?.trim();
                if (!name || !matchedAppInfo) return;
                finish({
                    name,
                    appInfo: matchedAppInfo
                });
            };

            dialog.setButtons([ {
                label: "Cancel",
                action: () => finish(null),
                key: Clutter.KEY_Escape
            }, {
                label: "Add",
                action: confirm,
                default: true
            } ]);

            nameEntry.clutter_text.connect("activate", confirm);

            dialog.open();
            global.stage.set_key_focus(nameEntry);
        });
    }
}
