import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import St from "gi://St";

import { isMappedActor, hasAllocation } from "./actorLifecycle.js";

const TOOLTIP_SHOW_DELAY_MS = 400;

export function attachTooltip(actor, layers, textOrFn) {
    let showTimeoutId = null;
    let tooltipLabel = null;
    let currentTextOrFn = textOrFn;

    const hide = () => {
        if (showTimeoutId != null) {
            GLib.source_remove(showTimeoutId);
            showTimeoutId = null;
        }
        tooltipLabel?.destroy();
        tooltipLabel = null;
    };

    const enterId = actor.connect("enter-event", () => {
        showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
            showTimeoutId = null;
            const stage = layers.root?.get_stage?.();
            const text = typeof currentTextOrFn === "function" ? currentTextOrFn() : currentTextOrFn;
            if (!text || !stage || !isMappedActor(actor, stage) ||
                !hasAllocation(layers.root) || !hasAllocation(actor) ||
                !isMappedActor(layers.info, stage))
                return GLib.SOURCE_REMOVE;

            tooltipLabel = new St.Label({
                style_class: "wc-widget-tooltip",
                text
            });
            tooltipLabel.set_style(
                "background-color: rgba(20, 20, 20, 0.95); color: #fff; " +
                "font-size: 12px; padding: 4px 8px; border-radius: 6px;"
            );
            layers.info.add_child(tooltipLabel);

            const [actorAbsX, actorAbsY] = actor.get_transformed_position();
            const [rootAbsX, rootAbsY] = layers.root.get_transformed_position();
            const actorX = actorAbsX - rootAbsX;
            const actorY = actorAbsY - rootAbsY;
            const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
            const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
            const [cardWidth, cardHeight] = layers.root.get_size();

            const idealX = actorX + (actor.width - labelWidth) / 2;
            const idealY = actorY - labelHeight - 6;
            tooltipLabel.set_position(
                Math.max(0, Math.min(idealX, cardWidth - labelWidth)),
                Math.max(0, Math.min(idealY, cardHeight - labelHeight))
            );
            return GLib.SOURCE_REMOVE;
        });
        return Clutter.EVENT_PROPAGATE;
    });
    const leaveId = actor.connect("leave-event", () => {
        hide();
        return Clutter.EVENT_PROPAGATE;
    });
    const pressId = actor.connect("button-press-event", hide);

    actor.setTooltip = newTextOrFn => {
        currentTextOrFn = newTextOrFn;
    };

    return {
        hide,
        destroy() {
            hide();
            try {
                actor.disconnect(enterId);
                actor.disconnect(leaveId);
                actor.disconnect(pressId);
            } catch (e) {}
        }
    };
}
