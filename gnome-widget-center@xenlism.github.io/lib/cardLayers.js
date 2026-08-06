// products/extension/lib/cardLayers.js
//
// Splits a widget's "card" root into two Clutter.BinLayout-stacked St
// actors — a BACKGROUND layer (behind) and a CONTENT layer (in front) —
// instead of the older pattern of styling/blurring ONE root actor that
// also directly holds the widget's own labels/icons/drawing areas.
//
// Why this needed to exist (2026-08-06 bug report): widgetVisualKit.js's
// applyCardBlur() adds a real `Clutter.BlurEffect` to whatever actor
// it's given — and a Clutter effect blurs "the actor's whole paint,
// itself + children" (see that function's own doc comment). Every
// bundled widget used to call `_applyCardBlur(this._actor, settings)`
// with `this._actor` being the SAME actor its text/icons/drawing areas
// were children of, so turning on a widget's blur setting blurred its
// own readout along with the background fill behind it — not what
// "blur the background" means to a user (reported as "blur button blur,
// I need widget background blur not widget object"). createLayeredCard()
// below gives a widget a background actor to style+blur that's a
// full-size SIBLING of its content, never a PARENT of it, so the two
// never share a single paint pass.
//
// SHELL-PROCESS ONLY — this file imports St/Clutter directly, so never
// import it from prefs.js/widget-center-prefs-app.js or anything under
// prefsWindowController.js's dependency tree (development/docs/
// WIDGET_API.md §4). That's also exactly why this is its own file
// instead of just adding St/Clutter to widgetVisualKit.js directly —
// widgetVisualKit.js IS loaded by the Prefs process (prefsPageBuilders.js
// imports SHADOW_ANGLE_STEPS from it) and has no Clutter typelib there;
// see that file's own setClutterBackend() doc comment for the full
// story. A widget.js file itself is Shell-only already (never
// dynamically imported by the Prefs process — only a widget's optional
// settings.js/autocomplete.js are), so importing this file from a
// widget.js is always safe.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {cardStyleCss, applyCardBlur, applyCardOpacity} from './widgetVisualKit.js';

/**
 * Builds an empty layered card: `root` (what buildActor() should return
 * and store as `this._actor`) containing two full-size, stacked
 * children — `background` and `content`, in that paint order. Add a
 * widget's actual UI (labels, icons, St.DrawingArea, ...) to `content`;
 * never add widget UI directly to `root` or `background`.
 *
 * @param {object} [options]
 * @param {string} [options.contentStyleClass] - forwarded to the
 *   CONTENT layer only, so a widget's existing
 *   `.some-widget-root { padding: ...}` stylesheet.css selector keeps
 *   matching after switching a widget over to this helper — layout/
 *   padding stays a CONTENT concern, only background-color/border/
 *   corner-radius/shadow/blur/opacity move to the background layer (see
 *   applyLayeredCardStyle() below). If a widget's stylesheet.css rule
 *   instead targeted the *card's outer edge* (e.g. a border drawn via
 *   CSS on the old root), move that rule to target `.wc-card-background`
 *   (or pass a class here and target that) instead.
 * @param {boolean} [options.reactive=false] - set on `root`. Most
 *   widgets should instead set `content.reactive = true` (or a specific
 *   child) so hit-testing follows the actual visible/clickable UI, not
 *   the full background rectangle.
 * @returns {{root: St.Widget, background: St.Widget, content: St.Widget}}
 */
export function createLayeredCard(options = {}) {
    const root = new St.Widget({
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
        reactive: options.reactive ?? false,
    });

    // Full-size, no style_class of its own by default — cardStyleCss()'s
    // output is applied straight via set_style() in
    // applyLayeredCardStyle() below, same as the old single-actor
    // pattern did, just aimed at this actor instead of `root`.
    const background = new St.Widget({x_expand: true, y_expand: true});
    root.add_child(background);

    const content = new St.Widget({
        style_class: options.contentStyleClass,
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
    });
    root.add_child(content);

    return {root, background, content};
}

/**
 * Applies a widget's settings-driven background/border/corner-radius/
 * shadow (cardStyleCss), blur (applyCardBlur), and opacity
 * (applyCardOpacity) to the BACKGROUND layer of a createLayeredCard()
 * result. This is the one call a widget's own _render()/
 * onSettingsChanged() should make instead of the old
 * `this._actor.set_style(cardStyleCss(...))` +
 * `_applyCardBlur(this._actor, settings)` pair.
 *
 * Opacity is deliberately applied to `background` here (not `root`),
 * so a widget's own text/icons stay fully legible even while its
 * background fades toward transparent — the more common intent behind
 * an "opacity" slider on a card. If a widget specifically wants its
 * ENTIRE rendering (background AND content) to fade together instead,
 * call `applyCardOpacity(layers.root, settings)` directly rather than
 * using this function for that case.
 *
 * @param {{background: St.Widget}} layers - a createLayeredCard() result
 * @param {object} settings
 * @param {object} [cardStyleOptions] - forwarded as-is to cardStyleCss()
 */
export function applyLayeredCardStyle(layers, settings, cardStyleOptions = {}) {
    layers.background.set_style(cardStyleCss(settings, cardStyleOptions));
    applyCardBlur(layers.background, settings);
    applyCardOpacity(layers.background, settings);
}
