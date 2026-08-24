// widgets/_template/widget.js
//
// Starting point for a new bundled widget. Copy this whole
// widgets/_template/ folder, rename it, and edit metadata.json's "id"/
// "name" plus the style_class strings below to match.
//
// This scaffolds the current layered-card architecture (see
// HANDOVER_2026-08-12-widget-layer-rules.md's rule table, reproduced
// here since it's the thing most likely to drift out of sync with a
// template if it only lived in a handover doc). There's no more
// "themeable"/"forceSettingsAware" split — every widget always paints
// its own card, always the same way (R2 below):
//
//   R1  _content is sized by layers.content's own BinLayout (x_expand/
//       y_expand below) - createLayeredCard() guarantees this, nothing
//       to add yourself.
//   R2  paint your own card via applyLayeredCardStyle(this._layers,
//       this._settings, {...}) inside _render() - every widget does
//       this the same way now, reading background color/blur/shadow/
//       border/opacity straight from its own settings (see
//       lib/widgetVisualKit.js). The one shared global value is the
//       shadow's angle/distance (lib/globalShadowHelper.js); everything
//       else about the card always comes from this widget's own
//       config.json.
//   R4  layers.content always has clip_to_allocation: true -
//       createLayeredCard() guarantees this, nothing to add yourself.
//   R5  never call layers.content.set_style() - card styling (R2/R3)
//       goes on layers.card; padding/layout on your own this._content
//       wrapper (a plain child, not the Content Layer itself) is fine.
//   R6  any background color you pass to cardStyleCss/
//       applyLayeredCardStyle must be 8-char hex (#rrggbbaa), always,
//       even at full opacity (#ffffffff, not #ffffff).
//   R7  tooltips (if you add one) attach via lib/widgetTooltip.js's
//       attachTooltip(button, this._layers, text) - never parent a
//       tooltip actor inside this._content, it'll get clipped.
//
// Settings/prefs: this template ships only config.json (the current
// default - the Preferences window auto-generates a UI from it, no
// prefs.js needed). Two other mechanisms still work in the loader
// (hand-written prefs.js, and settings.js's defineSettings() DSL) but
// config.json always wins if present - see
// lib/prefsWidgetManagement.js's _openWidgetPrefs() priority order - so
// only add prefs.js/settings.js if you delete config.json first, never
// alongside it. If you need custom prefs UI beyond what config.json's
// field types support, copy an existing widget's prefs.js (e.g.
// widgets/calendar-modern/prefs.js) instead of writing one from
// scratch, and remove config.json.

import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import {createLayeredCard, applyLayeredCardStyle} from "../../lib/cardLayers.js";
import {configJsonDefaults} from "../../lib/widgetConfigDefaults.js";

export default class TemplateWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._logger = api.logger;
        this._timeoutId = null;
    }

    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "template-widget-root"
        });
        this._actor = this._layers.root;

        // this._content is a plain padding/layout wrapper - a child of
        // layers.content, not the Content Layer itself (R5). x_expand/
        // y_expand let layers.content's BinLayout size it to the full
        // card automatically (R1) - no manual constraint needed.
        this._content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._layers.content.add_child(this._content);

        this._label = new St.Label({
            style_class: "template-widget-label",
            text: "template widget",
        });
        this._content.add_child(this._label);

        this._render();
        return this._actor;
    }

    enable() {
        this._render();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 60, () => {
            this._logger.info("template widget tick");
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    onSettingsChanged() {
        this._render();
    }

    _render() {
        if (!this._actor) return;
        // R2: every widget always paints its own card, straight from
        // its own settings (background color/blur/shadow/border/
        // opacity). See lib/cardLayers.js / lib/widgetVisualKit.js.
        applyLayeredCardStyle(this._layers, this._settings);
        this._label.set_text(this._settings.labelText ?? "template widget");
    }

    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
        };
    }
}
