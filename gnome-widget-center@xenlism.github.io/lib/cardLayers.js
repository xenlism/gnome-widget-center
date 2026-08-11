import St from "gi://St";

import Clutter from "gi://Clutter";

import Shell from "gi://Shell";

import { cardStyleCss, applyCardOpacity, BLUR_DEFAULTS, getForceAwareBlurSettings } from "./widgetVisualKit.js";

const BLUR_EFFECT_NAME = "wc-card-blur";

export function applyCardBlur(actor, settings, ignoreForce = false) {
    if (!actor) return;
    const {enabled: enabled, radius: radius} = getForceAwareBlurSettings(settings, ignoreForce);
    const shouldBlur = enabled && radius > 0;
    const existing = actor.get_effect(BLUR_EFFECT_NAME);
    if (shouldBlur) {
        let effect = existing;
        if (!effect) {
            effect = new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                brightness: 1
            });
            actor.add_effect_with_name(BLUR_EFFECT_NAME, effect);
        }
        if (effect.set_radius) {
            effect.set_radius(radius);
        } else if (effect.radius !== undefined) {
            effect.radius = radius;
        }
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
    const background = new St.Widget({
        x_expand: true,
        y_expand: true,
        style_class: "gwc-blur"
    });
    root.add_child(background);
    const content = new St.Widget({
        style_class: options.contentStyleClass,
        layout_manager: new Clutter.BinLayout,
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true
    });
    root.add_child(content);
    return {
        root: root,
        background: background,
        content: content
    };
}

export function applyLayeredCardStyle(layers, settings, cardStyleOptions = {}, ignoreForce = false) {
    layers.background.set_style(cardStyleCss(settings, {
        ...cardStyleOptions,
        includeBlur: false
    }));
    applyCardBlur(layers.background, settings, ignoreForce);
    applyCardOpacity(layers.background, settings, ignoreForce);
}