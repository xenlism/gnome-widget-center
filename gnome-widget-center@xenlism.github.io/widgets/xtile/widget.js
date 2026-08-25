// widgets/xtile/widget.js
//
// Xtile: a single generic 1x1 app-launcher tile. Add it to the desktop
// as many times as you like - each instance gets its own settings
// (storageService.js keys settings by instance, not by widget id), so
// one becomes your Firefox tile, another your GIMP tile, etc.
//
// Previously this was five near-identical widget folders
// (xtile-firefox/chrome/terminal/gimp/inkscape) that only differed in
// their config.json defaults. That's gone - this is the only Xtile
// widget now.
//
// The app is chosen by typing its name (settings.appQuery, e.g.
// "firefox") rather than picking a .desktop file through a file-browse
// dialog: resolution goes through findAppInfoByQuery() in
// lib/utils.js, which uses Gio.DesktopAppInfo.search() - the same
// fuzzy app search GNOME Shell's own app grid uses. No Gtk.FileDialog
// involved anywhere in this widget.
//
// Card rendering follows this repo's current layered-card convention
// (see CLAUDE.md "Widget layer rules" / WIDGET_API.md §3): createLayeredCard()
// gives R1/R4/R5 for free, applyLayeredCardStyle() always self-paints
// the card from this widget's own settings. Background/Blur/Shadow/
// Border/Opacity fields are the ones lib/appearanceFieldsSchema.js
// auto-merges into every widget's config.json - not redeclared here.

import Clutter from "gi://Clutter";
import St from "gi://St";

import { findAppInfoByQuery } from "../../lib/utils.js";
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

export default class XtileWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._pressId = null;
        this._lastQuery = undefined;
        this._cachedAppInfo = undefined;
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

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url)
        };
    }

    // Resolved from a plain-text name (settings.appQuery), not a
    // .desktop path - see file header. Cached against the last query
    // string so typing elsewhere in settings doesn't re-run the app
    // search on every render.
    _appInfo() {
        const query = this._settings.appQuery ?? "";
        if (query === this._lastQuery && this._cachedAppInfo !== undefined) {
            return this._cachedAppInfo;
        }
        this._lastQuery = query;
        try {
            this._cachedAppInfo = findAppInfoByQuery(query);
        } catch (e) {
            this._api.logger.info(`xtile: could not resolve "${query}": ${e}`);
            this._cachedAppInfo = null;
        }
        return this._cachedAppInfo;
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
