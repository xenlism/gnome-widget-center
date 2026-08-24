// Shared hover-tooltip behavior for any child actor living in a widget's
// Content Layer. A widget never touches the Info Layer directly - it calls
// attachTooltip() once per actor, and everything about showing, positioning,
// and cleaning up the tooltip label is owned here.
//
// Usage in a widget's buildActor():
//     const button = new St.Button({...});
//     this._layers.content.add_child(button);
//     attachTooltip(button, this._layers, "Power Off");
// `button.setTooltip("New Text")` can be called later to change what shows
// on the next hover (e.g. settings-control's airplane-mode button, whose
// tooltip text depends on live network state).

import GLib from "gi://GLib";
import Clutter from "gi://Clutter";
import St from "gi://St";

import { isMappedActor, hasAllocation } from "./actorLifecycle.js";

const TOOLTIP_SHOW_DELAY_MS = 400;

/**
 * @param {Clutter.Actor} actor - the hoverable child (button, cell, bin...).
 *   Must already be a descendant of `layers.root` (normally added to
 *   `layers.content`) by the time the user hovers it.
 * @param {{root: Clutter.Actor, info: Clutter.Actor}} layers - the widget's
 *   createLayeredCard() result. Tooltip labels are added to `layers.info`
 *   and positioned relative to `layers.root`.
 * @param {string|(() => string)} textOrFn - tooltip text, or a function
 *   returning it at hover-time for text that depends on live state.
 * @returns {{hide: () => void, destroy: () => void}} `destroy()` disconnects
 *   every signal this attached and hides any visible label; call it from
 *   the widget's own destroy(). `hide()` alone dismisses a visible label
 *   without disconnecting (used when a widget re-renders its buttons).
 */
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

            // Positions are computed via transformed (absolute) coords then
            // converted back to root-relative, rather than trusting
            // get_position() at this nesting depth.
            const [actorAbsX, actorAbsY] = actor.get_transformed_position();
            const [rootAbsX, rootAbsY] = layers.root.get_transformed_position();
            const actorX = actorAbsX - rootAbsX;
            const actorY = actorAbsY - rootAbsY;
            const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
            const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
            const [cardWidth, cardHeight] = layers.root.get_size();

            // Prefer just above the actor, but the widget layer clips each
            // widget to its own allocated card - anything positioned
            // outside [0, cardWidth] x [0, cardHeight] is simply invisible
            // rather than floating over neighboring widgets, so both axes
            // are clamped to stay fully on-card.
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
    // button-press-event exists on every actor type (St.Bin, St.Button,
    // St.Widget), unlike St.Button's "clicked" - one dismiss signal works
    // for every call site regardless of what kind of actor is passed in.
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
