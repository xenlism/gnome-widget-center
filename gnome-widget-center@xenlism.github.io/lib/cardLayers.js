import St from "gi://St";

import Clutter from "gi://Clutter";

import Shell from "gi://Shell";

import { cardStyleCss, applyCardOpacity, getBlurSettings, toCssColor, resolveCornerRadius } from "./widgetVisualKit.js";

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