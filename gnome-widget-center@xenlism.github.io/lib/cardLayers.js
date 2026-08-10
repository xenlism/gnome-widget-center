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
// SHELL-PROCESS ONLY — this file imports St/Clutter/Shell directly, so never
// import it from prefs.js/widget-center-prefs-app.js or anything under
// prefsWindowControllerBase.js's dependency tree (development/docs/
// WIDGET_API.md §4). That's also exactly why applyCardBlur() (below)
// lives in THIS file rather than in widgetVisualKit.js — widgetVisualKit.js
// IS loaded by the Prefs process too (prefsPageBuilders.js imports
// SHADOW_ANGLE_STEPS from it) and has no Clutter/Shell typelib there. A
// widget.js file itself is Shell-only already (never dynamically
// imported by the Prefs process — only a widget's optional settings.js/
// autocomplete.js are), so importing this file from a widget.js is
// always safe.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell'; // เพิ่มการ import Shell เข้ามา
import {cardStyleCss, applyCardOpacity, BLUR_DEFAULTS, getForceAwareBlurSettings} from './widgetVisualKit.js';

// --- applyCardBlur() (2026-08-09 bug fix, 2026-08-10 GNOME 50 Shell.BlurEffect update) ---
//
// Defined HERE in cardLayers.js (not in widgetVisualKit.js) because it needs
// a real `Shell.BlurEffect` (gi://Shell) - and widgetVisualKit.js is loaded
// by the Prefs process too (see this file's own header comment above),
// which has no Clutter/Shell typelib. cardLayers.js is already SHELL-PROCESS
// ONLY and already imports Clutter/Shell directly, so this is the correct
// home for it. Now uses getForceAwareBlurSettings() to respect force blur
// state, so blur force settings now work correctly.
//
// 2026-08-10 UPDATE (GNOME 50): Switched from `Clutter.BlurEffect` to 
// `Shell.BlurEffect`. `Clutter.BlurEffect` only blurs the actor's own paint 
// (itself + children) and has no radius property. `Shell.BlurEffect` with 
// `mode: Shell.BlurMode.BACKGROUND` correctly blurs what is *behind* the actor 
// (true background blur) and exposes a `radius` property (or `set_radius` in 
// older GNOME 40-44), allowing the widget's `blurRadius` setting to actually 
// control the blur strength.
//
// RESOLVED 2026-08-09 (confirmed with user): Clutter.BlurEffect wins,
// CSS `-st-background-blur` does not actually render in the target
// environment. applyLayeredCardStyle() below now passes
// `includeBlur: false` to cardStyleCss() so that CSS declaration is
// never emitted on the layered-card path — this file's applyCardBlur()
// (now Shell.BlurEffect) is the ONLY blur mechanism for any widget using
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
// switching them to Shell.BlurEffect isn't a one-line fix: their
// content (labels/icons) is a CHILD of that same root actor, so adding
// applyCardBlur() to it directly would blur their own readout as well —
// the exact bug this file's own header comment describes migrating
// away from. Fixing those widgets for real means moving each one to
// createLayeredCard() first (separate background/content actors), which
// is out of scope for this pass — flagging clearly rather than
// papering over it.
const BLUR_EFFECT_NAME = 'wc-card-blur';

/**
 * Adds (or removes) a `Shell.BlurEffect` on `actor`, driven by a
 * widget's own `blurEnabled`/`blurRadius` settings.
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
        let effect = existing;
        if (!effect) {
            // สร้าง Shell.BlurEffect แบบโหมดเบลอพื้นหลังด้านหลัง
            effect = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                brightness: 1.0,
            });
            actor.add_effect_with_name(BLUR_EFFECT_NAME, effect);
        }
        
        // ตั้งค่ารัศมีการเบลอ (รองรับทั้ง GNOME 40-44 ที่ใช้ set_radius และ GNOME 46+ ที่ใช้ property)
        if (effect.set_radius) {
            effect.set_radius(radius);
        } else if (effect.radius !== undefined) {
            effect.radius = radius;
        }
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

    // Full-size — cardStyleCss()'s output is applied straight via
    // set_style() in applyLayeredCardStyle() below, same as the old
    // single-actor pattern did, just aimed at this actor instead of
    // `root`. ALSO carries the fixed `gwc-blur` style_class (2026-08-09,
    // handover v3) alongside any per-widget class this actor may pick up
    // later — this is a marker class only, no stylesheet.css rule needed
    // for it: it exists purely so the system's `blur-my-shell` GNOME
    // Shell extension (which lets a user list CSS class names to blur in
    // ITS OWN settings) has something stable to target on every card's
    // background layer, independent of this extension's own
    // Shell.BlurEffect-based blur (applyCardBlur() below). The two are
    // unrelated mechanisms that both happen to affect this same actor.
    const background = new St.Widget({x_expand: true, y_expand: true, style_class: 'gwc-blur'});
    root.add_child(background);

    // clip_to_allocation: true (2026-08-09, handover v3 overflow fix) —
    // content (ring/label/icon actors) must never paint past the card's
    // own rectangle: unlike `root` (left unclipped above so a shadow can
    // bleed outside the card on purpose), anything drawn here escaping
    // the card reads as a rendering bug, not a design choice - see
    // widgets/circles-battery-half/widget.js's header note on the
    // ring-column translation this was clipping against.
    const content = new St.Widget({
        style_class: options.contentStyleClass,
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true,
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
 * `applyCardBlur()` just below (Shell.BlurEffect) is this path's ONE
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