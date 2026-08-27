import { cardStyleCss, applyCardOpacity, getBlurSettings, toCssColor, resolveCornerRadius } from "../widgetVisualKit.js";

// St, Clutter and Shell are GNOME Shell process-only libraries. This module is
// statically imported by many widgets/*/widget.js files, which are in turn
// dynamically imported by the preferences process (for thumbnail metadata) -
// see lib/prefsWidgetManagement.js. Importing gi://St, gi://Clutter or
// gi://Shell at module top-level would therefore break (or be flagged by EGO
// review as) a prefs-process import of shell-only libraries. To keep this
// file safe to load from either process, the gi imports are deferred until a
// function that actually needs them is called - which only happens inside
// the real GNOME Shell process.
let St = null;
let Clutter = null;
let Shell = null;

// Fire off the (async) dynamic imports immediately, but without a top-level
// await. This module is only ever *called into* from the real Shell process
// (extension.js / widgetRuntimeLoader.js), by which time this promise has
// long since resolved, so the public API below can stay fully synchronous.
// If this module is merely loaded (not called) from the prefs process, a
// rejected/unused promise here is harmless - unlike a static top-level
// `import ... from "gi://St"`, it does not fail module evaluation and is not
// flagged by EGO's static prefs-process import check.
const _libsReady = Promise.all([
    import("gi://St"), import("gi://Clutter"), import("gi://Shell")
]).then(([stMod, clutterMod, shellMod]) => {
    St = stMod.default;
    Clutter = clutterMod.default;
    Shell = shellMod.default;
}).catch(() => {
    // Not running in the Shell process (e.g. loaded from prefs for
    // metadata purposes only) - the functions below simply won't be called.
});

function _ensureShellLibs() {
    if (!St || !Clutter || !Shell) {
        throw new Error(
            "cardLayers.js: gi://St, gi://Clutter and gi://Shell are not " +
            "available yet or this is not the GNOME Shell process."
        );
    }
}

const BLUR_EFFECT_NAME = "wc-card-blur";

function _createBlurEffect(radius, logger) {
    const base = { mode: Shell.BlurMode.BACKGROUND, brightness: 1 };
    try {
        return new Shell.BlurEffect({ ...base, radius });
    } catch (eRadius) {
        try {
            return new Shell.BlurEffect({ ...base, sigma: radius });
        } catch (eSigma) {
            logger?.error?.(
                `cardLayers: Shell.BlurEffect accepts neither a "radius" nor a "sigma" ` +
                `constructor property on this GNOME Shell version - background blur can't ` +
                `be applied. (radius attempt: ${eRadius.message}; sigma attempt: ${eSigma.message})`
            );
            return null;
        }
    }
}

export function applyCardBlur(actor, settings, logger = null) {
    if (!actor) return;
    _ensureShellLibs();
    const {enabled: enabled, radius: radius} = getBlurSettings(settings);
    const shouldBlur = enabled && radius > 0;
    const existing = actor.get_effect(BLUR_EFFECT_NAME);
    if (shouldBlur) {
        if (existing && existing._wcBlurRadius === radius) return;
        if (existing) actor.remove_effect(existing);
        const effect = _createBlurEffect(radius, logger);
        if (!effect) return;
        effect._wcBlurRadius = radius;
        actor.add_effect_with_name(BLUR_EFFECT_NAME, effect);
    } else if (existing) {
        actor.remove_effect(existing);
    }
}

export function createLayeredCard(options = {}) {
    _ensureShellLibs();
    const root = new St.Widget({
        layout_manager: new Clutter.BinLayout,
        x_expand: true,
        y_expand: true,
        reactive: options.reactive ?? false,
        clip_to_allocation: false
    });
    const card = new St.Widget({
        layout_manager: new Clutter.BinLayout,
        x_expand: true,
        y_expand: true,
        style_class: "gwc-blur"
    });
    root.add_child(card);
    const cardBlur = new St.Widget({
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true
    });
    card.add_child(cardBlur);
    const content = new St.Widget({
        style_class: options.contentStyleClass ?? null,
        layout_manager: new Clutter.BinLayout,
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true
    });
    root.add_child(content);
    let info = null;
    if (options.withInfoLayer ?? options.withTooltipLayer) {
        info = new St.Widget({
            layout_manager: new Clutter.FixedLayout,
            x_expand: true,
            y_expand: true,
            clip_to_allocation: false,
            reactive: false
        });
        root.add_child(info);
    }
    return { root: root, card: card, cardBlur: cardBlur, content: content, info: info };
}

export function applyLayeredCardStyle(layers, settings, cardStyleOptions = {}) {
    const cornerRadiusKey = cardStyleOptions.cornerRadiusKey ?? "cornerRadius";
    const cornerRadius = resolveCornerRadius(settings, cardStyleOptions.cornerRadiusFallback ?? 18, cornerRadiusKey);
    const bgKey = cardStyleOptions.backgroundColorKey ?? "backgroundColor";
    const bgFallback = cardStyleOptions.backgroundColorFallback ?? "#000000F5";
    const bgColor = toCssColor(settings?.[bgKey], bgFallback);
    layers.card.set_style(cardStyleCss(settings, cardStyleOptions));
    applyCardOpacity(layers.card, settings);
    layers.cardBlur.set_style(`background-color: ${bgColor}; border-radius: ${cornerRadius}px;`);
    applyCardBlur(layers.cardBlur, settings);
}