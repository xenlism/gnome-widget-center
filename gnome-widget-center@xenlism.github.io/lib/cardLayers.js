import St from "gi://St";

import Clutter from "gi://Clutter";

import Shell from "gi://Shell";

import { cardStyleCss, applyCardOpacity, getBlurSettings, toCssColor } from "./widgetVisualKit.js";

const BLUR_EFFECT_NAME = "wc-card-blur";

// Builds a fresh Shell.BlurEffect with every relevant property set at
// construction time, not via a property assignment on an existing
// instance afterward. Two independent reasons for that:
//
// 1. Property name uncertainty: different GNOME Shell releases have
//    used different names for the blur strength property on this
//    effect (older/experimental builds: "sigma"; current: "radius").
//    The previous version of this function only ever tried "radius"
//    (via a set_radius() method that doesn't exist, or a plain
//    property write) and silently did nothing if that name wasn't
//    right for the running Shell - the effect got attached with
//    whatever its internal default blur strength is (frequently 0,
//    i.e. a no-op passthrough), which looks identical to "blur is
//    off" even though the effect object is very much there.
// 2. Constructor-time vs post-construction property writes aren't
//    guaranteed equivalent for a Clutter/Cogl effect that builds its
//    shader/pipeline once at construction - somewhat version/
//    implementation dependent, so setting every property up front is
//    the safer bet regardless.
//
// So: try constructing with "radius" first (the current, documented
// property - see e.g. the gnome-rounded-blur compatibility library,
// which is explicitly "a copy of ShellBlurEffect"), and if that
// constructor throws (property doesn't exist under that name on this
// Shell version), fall back to "sigma". If BOTH fail, log it clearly
// instead of ending up with a silently-attached, silently-inert
// effect - "blur toggle does nothing and there's no error anywhere"
// is exactly the bug being fixed here.
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
    const {enabled: enabled, radius: radius} = getBlurSettings(settings);
    const shouldBlur = enabled && radius > 0;
    const existing = actor.get_effect(BLUR_EFFECT_NAME);
    if (shouldBlur) {
        // Re-create rather than mutate-in-place whenever the radius the
        // existing effect was built with no longer matches - see the
        // constructor-time note above. Cheap: this only re-runs when the
        // user actually changes the blur radius setting, not every frame.
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
    // Blur lives on this child, not on `card` itself - see
    // applyLayeredCardStyle() below for the full reasoning. Sized to
    // fill `card` exactly (variant "A" from extension.js's Layer Lab
    // comparison) rather than inset by a margin - clip_to_allocation
    // here keeps the blur's rectangular output from spilling past the
    // card's own bounds; its corners stay square regardless, an
    // accepted tradeoff (see applyLayeredCardStyle()).
    const cardBlur = new St.Widget({
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true
    });
    card.add_child(cardBlur);
    const content = new St.Widget({
        // options.contentStyleClass is optional - media-player-wide (and
        // any future caller) may call createLayeredCard({}) with no style
        // class at all. GJS's object-initializer throws on an explicit
        // `undefined` for style-class (unlike a plain property assignment,
        // which tolerates it), so this must resolve to `null`, never be
        // left as `undefined`.
        style_class: options.contentStyleClass ?? null,
        layout_manager: new Clutter.BinLayout,
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true
    });
    root.add_child(content);
    // Info Layer - a third sibling of Card/Content, added last so it
    // paints on top. Never clipped, so tooltips are free to overflow the
    // card's bounds (e.g. a tooltip above a cell near the top edge).
    // Uses FixedLayout (not BinLayout) so info children can be positioned
    // with explicit set_position() calls - BinLayout would re-align/ignore
    // that in favor of x_align/y_align. Widgets don't add children here
    // directly - see lib/widgetTooltip.js's attachTooltip(), which owns
    // this layer for tooltip labels.
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
    // Card A (see extension.js's Layer Lab, v5/v6): `cardBlur` fills
    // `card` exactly - no inset margin - and carries the SAME
    // border-radius as `card`, with clip_to_allocation keeping its
    // blur's rectangular output from spilling past the card's bounds.
    //
    // Shell.BlurEffect (applyCardBlur(), above) has no idea about CSS
    // `border-radius` - it blurs its actor's own full rectangular
    // bounds, corners included, regardless of what shape that actor's
    // background is themed to, so the live-blur corners come out
    // square no matter what clip/radius the actor carrying it has.
    // GNOME Shell has no built-in rounded-corner background blur
    // (getting one means an external compatibility library - see e.g.
    // the "gnome-rounded-blur" project - or a hand-rolled Cogl/GLSL
    // stencil mask, neither of which this codebase can safely take
    // on/verify). A prior version of this function tried to hide that
    // by insetting `cardBlur` by a corner-radius-wide margin so its
    // square corners never got near `card`'s rounded ones - but that
    // margin band read as its own visible seam (a "double border")
    // once a border was drawn on `card`, especially at larger corner
    // radii. Side-by-side comparison across three blur techniques (see
    // extension.js's history) found no rounded-corner live-blur option
    // available here without a shader or a native library, so the
    // square corners are simply accepted now rather than papered over.
    const cornerRadiusKey = cardStyleOptions.cornerRadiusKey ?? "cornerRadius";
    const cornerRadiusRaw = settings?.[cornerRadiusKey];
    const cornerRadius = Number.isFinite(cornerRadiusRaw) ? cornerRadiusRaw : (cardStyleOptions.cornerRadiusFallback ?? 18);
    const bgKey = cardStyleOptions.backgroundColorKey ?? "backgroundColor";
    const bgFallback = cardStyleOptions.backgroundColorFallback ?? "#000000F5";
    const bgColor = toCssColor(settings?.[bgKey], bgFallback);
    layers.card.set_style(cardStyleCss(settings, cardStyleOptions));
    applyCardOpacity(layers.card, settings);
    layers.cardBlur.set_style(`background-color: ${bgColor}; border-radius: ${cornerRadius}px;`);
    applyCardBlur(layers.cardBlur, settings);
}