// widgets/xtile-firefox/widget.js
//
// Base widget of the Xtile series. `XtileBaseWidget` (named export)
// holds all real behavior - layout, click-to-launch, accent-color
// rendering. A sibling tile (widgets/xtile-chrome, xtile-terminal,
// xtile-gimp, xtile-inkscape, ...) imports it and extends it with
// nothing but its own default export + a one-line getDefaultSettings()
// override:
//
//   import { XtileBaseWidget } from '../xtile-firefox/widget.js';
//   import { configJsonDefaults } from '../../lib/widgetConfigDefaults.js';
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
//
// Card rendering follows this repo's current layered-card convention
// (see CLAUDE.md "Widget layer rules" / WIDGET_API.md §3): createLayeredCard()
// gives R1/R4/R5 for free, applyLayeredCardStyle() always self-paints
// the card from this widget's own settings. Background/Blur/Shadow/
// Border/Opacity fields are the ones lib/appearanceFieldsSchema.js
// auto-merges into every widget's config.json - not redeclared here.

import Clutter from "gi://Clutter";
import St from "gi://St";

import { getAppInfoFromFilename } from "../../lib/utils.js";
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
    // of them but Firefox.
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

export default class XtileFirefoxWidget extends XtileBaseWidget {
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url)
        };
    }
}
