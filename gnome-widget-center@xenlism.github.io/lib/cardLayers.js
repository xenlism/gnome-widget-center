// products/extension/lib/cardLayers.js
//
// Splits a widget's "card" root into two Clutter.BinLayout-stacked St
// actors — a BACKGROUND layer (behind) and a CONTENT layer (in front) —
// instead of the older pattern of styling/blurring ONE root actor that
// also directly holds the widget's own labels/icons/drawing areas.
//
// Why this needed to exist (2026-08-06 bug report): the older
// applyCardBlur() (a prior version of the function now defined further
// down in THIS file - see that note below for its 2026-08-09 history)
// adds a real `Clutter.BlurEffect` to whatever actor it's given — and a
// Clutter effect blurs "the actor's whole paint, itself + children" (see
// that function's own doc comment). Every bundled widget used to call
// `_applyCardBlur(this._actor, settings)` with `this._actor` being the
// SAME actor its text/icons/drawing areas were children of, so turning
// on a widget's blur setting blurred its own readout along with the
// background fill behind it — not what "blur the background" means to a
// user (reported as "blur button blur, I need widget background blur
// not widget object"). createLayeredCard() below gives a widget a
// background actor to style+blur that's a full-size SIBLING of its
// content, never a PARENT of it, so the two never share a single paint
// pass.
//
// SHELL-PROCESS ONLY — this file imports St/Clutter directly, so never
// import it from prefs.js/widget-center-prefs-app.js or anything under
// prefsWindowControllerBase.js's dependency tree (development/docs/
// WIDGET_API.md §4). That's also exactly why applyCardBlur() (below)
// lives in THIS file rather than in widgetVisualKit.js — widgetVisualKit.js
// IS loaded by the Prefs process too (prefsPageBuilders.js imports
// SHADOW_ANGLE_STEPS from it) and has no Clutter typelib there. A
// widget.js file itself is Shell-only already (never dynamically
// imported by the Prefs process — only a widget's optional settings.js/
// autocomplete.js are), so importing this file from a widget.js is
// always safe.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import {cardStyleCss, applyCardOpacity, BLUR_DEFAULTS, getForceAwareBlurSettings} from './widgetVisualKit.js';

// --- applyCardBlur() (2026-08-09 bug fix, 2026-08-09 force-aware update) ---
//
// Defined HERE in cardLayers.js (not in widgetVisualKit.js) because it needs
// a real `Clutter.BlurEffect` (gi://Clutter) - and widgetVisualKit.js is loaded
// by the Prefs process too (see this file's own header comment above),
// which has no Clutter typelib. cardLayers.js is already SHELL-PROCESS
// ONLY and already imports Clutter directly, so this is the correct
// home for it. Now uses getForceAwareBlurSettings() to respect force blur
// state, so blur force settings now work correctly.
//
// IMPORTANT CAVEAT, confirmed against Mutter's own API reference for
// Clutter.BlurEffect: it exposes NO properties of its own beyond the
// enabled/name/actor ones it inherits from ClutterActorMeta - no
// sigma/radius/strength knob exists on this class at all;
// `clutter_blur_effect_new()` is a single fixed-strength blur. That
// means a widget's `blurRadius` setting (and the Force system's
// `force-background-blur` GSettings value once wired in) can only ever
// be treated as ON/OFF here (radius > 0 vs not) - there is no way to
// make this particular blur stronger/weaker, because the effect has no
// property to carry that number to. If a variable-strength blur is
// actually wanted, GNOME Shell's own private `Shell.BlurEffect` (gi://Shell)
// does expose a `radius` property and would be the one to use instead -
// flagging this clearly rather than silently having the "Blur radius"
// spin row in Prefs quietly stop mattering.
//
// RESOLVED 2026-08-09 (confirmed with user): Clutter.BlurEffect wins,
// CSS `-st-background-blur` does not actually render in the target
// environment. applyLayeredCardStyle() below now passes
// `includeBlur: false` to cardStyleCss() so that CSS declaration is
// never emitted on the layered-card path — this file's applyCardBlur()
// (Clutter.BlurEffect) is the ONLY blur mechanism for any widget using
// createLayeredCard()/applyLayeredCardStyle().
//
// Scope note: this only fixes the layered-card path — no widget
// actually calls createLayeredCard()/applyLayeredCardStyle() yet (see
// HANDOVER_FORCE_SETTINGS.md), so this was a dormant bug, not a live
// one. Separately, ~24 widgets (circles-*, media-player-*,
// calendar-modern, power-menu-bar, settings-control-bar, switches) call
// widgetVisualKit.js's cardStyleCss() DIRECTLY on their own single root
// actor (not through this file at all) and rely solely on that same CSS
// `-st-background-blur` declaration for their blur setting — if it
// doesn't render, those widgets' blur is currently a no-op too, but
// switching them to Clutter.BlurEffect isn't a one-line fix: their
// content (labels/icons) is a CHILD of that same root actor, so adding
// applyCardBlur() to it directly would blur their own readout as well —
// the exact bug this file's own header comment describes migrating
// away from. Fixing those widgets for real means moving each one to
// createLayeredCard() first (separate background/content actors), which
// is out of scope for this pass — flagging clearly rather than
// papering over it.
const BLUR_EFFECT_NAME = 'wc-card-blur';

/**
 * Adds (or removes) a `Clutter.BlurEffect` on `actor`, driven by a
 * widget's own `blurEnabled`/`blurRadius` settings - see the caveat
 * above about `radius` only ever being ON/OFF for this specific effect
 * class.
 * @param {Clutter.Actor} actor
 * @param {object} settings
 */
export function applyCardBlur(actor, settings) {
    if (!actor)
        return;

    const {enabled, radius} = getForceAwareBlurSettings(settings);
    const shouldBlur = enabled && radius > 0;

    const existing = actor.get_effect(BLUR_EFFECT_NAME);
    if (shouldBlur) {
        if (!existing)
            actor.add_effect_with_name(BLUR_EFFECT_NAME, new Clutter.BlurEffect());
    } else if (existing) {
        actor.remove_effect(existing);
    }
}

/**
 * Builds an empty layered card: `root` (what buildActor() should return
 * and store as `this._actor`) containing two full-size, stacked
 * children — `background` and `content`, in that paint order. Add a
 * widget's actual UI (labels, icons, St.DrawingArea, ...) to `content`;
 * never add widget UI directly to `root` or `background`.
 *
 * IMPORTANT: `clip_to_allocation: false` is set on root to allow
 * box-shadow to render outside the card's bounds (2026-08-09 fix).
 * Without this, any shadow configured on the widget would be clipped
 * inside the card rectangle. If your widget needs a different clip
 * behavior, adjust it on specific actors, not on root.
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
        clip_to_allocation: false,  // Allow shadow to render outside card bounds
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
 * `applyCardBlur(this._actor, settings)` pair.
 *
 * Opacity is deliberately applied to `background` here (not `root`),
 * so a widget's own text/icons stay fully legible even while its
 * background fades toward transparent — the more common intent behind
 * an "opacity" slider on a card. If a widget specifically wants its
 * ENTIRE rendering (background AND content) to fade together instead,
 * call `applyCardOpacity(layers.root, settings)` directly rather than
 * using this function for that case.
 *
 * `cardStyleOptions.includeBlur` is forced to `false` regardless of what
 * the caller passes — see this file's header comment (2026-08-09):
 * `applyCardBlur()` just below (Clutter.BlurEffect) is this path's ONE
 * blur mechanism, so cardStyleCss()'s own CSS `-st-background-blur`
 * declaration is deliberately never emitted here, to avoid stacking
 * both on the same actor.
 * @param {{background: St.Widget}} layers - a createLayeredCard() result
 * @param {object} settings
 * @param {object} [cardStyleOptions] - forwarded to cardStyleCss(), minus `includeBlur` (always false here)
 */
export function applyLayeredCardStyle(layers, settings, cardStyleOptions = {}) {
    layers.background.set_style(cardStyleCss(settings, {...cardStyleOptions, includeBlur: false}));
    applyCardBlur(layers.background, settings);
    applyCardOpacity(layers.background, settings);
}
