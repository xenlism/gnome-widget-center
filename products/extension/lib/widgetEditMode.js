// products/extension/lib/widgetEditMode.js
//
// Task 12 — Widget Edit Mode. Right-click a widget to flip it to a back
// side showing Settings/Reset/Remove/Uninstall actions; right-click or
// ESC flips it back. Per development/architecture/specs/ui/widget-edit-mode.md.
//
// State machine (per widget, independent of every other widget — there is
// no "one edit mode for the whole desktop", each widget flips on its own):
//
//   NORMAL --(pointer enter)--> HOVER --(pointer leave)--> NORMAL
//   NORMAL/HOVER --(right-click)--> EDIT --(right-click / ESC)--> NORMAL
//   EDIT --(task 13 drag-start)--> DRAGGING --(drop)--> EDIT
//
// This module owns NORMAL/HOVER/EDIT and the EDIT<->DRAGGING transition
// points (enterDragging()/exitDragging() below), but does not implement
// the drag itself — EditModeDragController (task 13) calls those two
// hooks and does the pointer tracking/grid-snap/persistence. Kept split
// the same way task 04's DragController is split from WidgetLayer: this
// file only knows about ONE widget's flip/back-side chrome, never about
// pointer grabs on `global.stage`.
//
// Widget content is disabled while EDIT (and therefore also DRAGGING) is
// active, per spec — `actor.reactive = false` on the front content so
// clicks can't reach whatever the widget itself put there (e.g. the
// media-player widget's own play/pause button) while its back side is
// showing instead.
//
// Resize is explicitly NOT supported (see spec's Non-Goals) — nothing
// here ever changes a widget actor's width/height, only its rotation/
// opacity and position (the latter is task 13's job, not this file's).

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

export const EditModeState = Object.freeze({
    NORMAL: 'normal',
    HOVER: 'hover',
    EDIT: 'edit',
    DRAGGING: 'dragging',
});

// Half of a full flip (180°) — the point at which the front content
// becomes edge-on and it's safe to swap in the back actor without an
// visible pop, matching the classic "card flip" trick of swapping
// visibility at the 90° mark rather than crossfading.
const FLIP_HALFWAY_DEGREES = 90;
const FLIP_DURATION_MS = 250;

// How long the pointer has to sit still over a back-side icon button
// before its tooltip label appears. St has no built-in tooltip widget
// (unlike Gtk's tooltip-text — see prefs.js for that side), so this file
// rolls its own: a plain St.Label shown/hidden on enter-event/leave-event,
// same technique most Shell extensions use since imports.ui.tooltips was
// removed upstream.
const TOOLTIP_SHOW_DELAY_MS = 500;

export class WidgetEditMode {
    /**
     * @param {StorageService} storageService - used by the Reset action
     *   (resetWidgetSettings()/removeWidgetLayoutEntry(), added in this
     *   same change) and nothing else here — Settings/Remove/Uninstall
     *   are handed back to the caller via the callbacks below instead of
     *   this module reaching into SettingsService/WidgetLoader directly,
     *   since those are extension.js-level concerns (task 05's Control
     *   Center wiring, WidgetLoader's unload/discover) that this module
     *   shouldn't need to know how to drive.
     * @param {object} callbacks
     * @param {(widgetId:string)=>void} callbacks.onSettings - "Settings"
     *   back-side action. Typically opens the Control Center to this
     *   widget's prefs page (task 05) — left to the caller since
     *   WidgetEditMode has no access to the (separate-process) prefs UI.
     * @param {(widgetId:string)=>void} callbacks.onRemove - "Remove"
     *   back-side action. Typically the same effect as switching the
     *   widget off in the Control Center (task 05's disabled-widgets
     *   GSettings key) — left to the caller for the same reason.
     * @param {(widgetId:string, isUserInstalled:boolean)=>void} [callbacks.onUninstall] -
     *   "Uninstall" back-side action. Only meaningful for user-installed
     *   widgets (deleting a bundled widget's folder makes no sense) — see
     *   attach()'s `isUserInstalled` option. Optional; if omitted the
     *   Uninstall button is not shown at all.
     */
    constructor(storageService, callbacks = {}) {
        this._storage = storageService;
        this._onSettings = callbacks.onSettings ?? (() => {});
        this._onRemove = callbacks.onRemove ?? (() => {});
        this._onUninstall = callbacks.onUninstall ?? null;

        /** @private {Map<string, object>} widgetId -> per-widget flip state */
        this._widgets = new Map();
    }

    /**
     * @method attach
     * @description Wires right-click/hover/ESC handling onto a single
     * widget actor. Call once per widget right after it's placed in the
     * layer, same timing as DragController.attach() (task 04) — this and
     * task 04's Super+drag coexist on the same actor without conflict
     * since task 04 only ever fires on Super+left-click, this only on
     * plain right-click.
     * @param {string} widgetId
     * @param {Clutter.Actor} actor - the widget's own front-side actor
     *   (from buildActor()) — never replaced or reparented, only
     *   rotated/hidden.
     * @param {{isUserInstalled?: boolean}} [options] - isUserInstalled
     *   gates whether the Uninstall button appears at all (see
     *   constructor's onUninstall doc) — bundled widgets never get one.
     */
    attach(widgetId, actor, options = {}) {
        if (this._widgets.has(widgetId))
            return;

        // A flip that visibly rotates needs perspective depth and a
        // pivot at the actor's own center, not its top-left corner (the
        // Clutter default) — otherwise it looks like it's swinging on a
        // hinge at the corner instead of spinning in place.
        actor.set_pivot_point(0.5, 0.5);

        const rightClickId = actor.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;

            this.toggle(widgetId);
            return Clutter.EVENT_STOP;
        });

        const enterId = actor.connect('enter-event', () => {
            this._setState(widgetId, EditModeState.HOVER, {ifCurrently: EditModeState.NORMAL});
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = actor.connect('leave-event', () => {
            this._setState(widgetId, EditModeState.NORMAL, {ifCurrently: EditModeState.HOVER});
            return Clutter.EVENT_PROPAGATE;
        });

        this._widgets.set(widgetId, {
            actor,
            state: EditModeState.NORMAL,
            back: null, // St.Widget, built lazily on first flip - see _buildBackActor()
            isUserInstalled: options.isUserInstalled ?? false,
            escId: null, // connected only while state === EDIT, see _enterEdit()/_exitEdit()
            signalIds: {rightClickId, enterId, leaveId},
        });
    }

    /**
     * @method toggle
     * @description Flips a widget between NORMAL/HOVER and EDIT. No-op if
     * the widget is currently DRAGGING (task 13 owns exiting that state
     * via exitDragging(), a bare right-click mid-drag shouldn't also
     * try to flip the card back).
     * @param {string} widgetId
     */
    toggle(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state === EditModeState.DRAGGING)
            return;

        if (entry.state === EditModeState.EDIT)
            this._exitEdit(widgetId);
        else
            this._enterEdit(widgetId);
    }

    /**
     * @method getState
     * @param {string} widgetId
     * @returns {string|null} one of EditModeState, or null if not attached
     */
    getState(widgetId) {
        return this._widgets.get(widgetId)?.state ?? null;
    }

    /**
     * @method isEditing
     * @description Convenience for EditModeDragController (task 13): a
     * drag is only allowed to start while the widget is in EDIT, per
     * spec ("Drag is available only while Edit Mode is active").
     * @param {string} widgetId
     * @returns {boolean}
     */
    isEditing(widgetId) {
        const state = this.getState(widgetId);
        return state === EditModeState.EDIT || state === EditModeState.DRAGGING;
    }

    /**
     * @method enterDragging
     * @description Task 13 calls this on drag-start (button-press while
     * isEditing() is true). Marks the widget DRAGGING so a stray
     * right-click or ESC during the drag itself doesn't also try to flip
     * the card back mid-motion — task 13's own release handler is what
     * calls exitDragging() to return to EDIT once the drop completes.
     * @param {string} widgetId
     */
    enterDragging(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state !== EditModeState.EDIT)
            return;
        entry.state = EditModeState.DRAGGING;
    }

    /**
     * @method exitDragging
     * @description Task 13 calls this once on drop, returning the widget
     * to EDIT (still flipped, back side still showing — a single drag
     * doesn't imply the user is done editing, per spec's Non-Goals
     * ("Multiple preference windows" etc. don't apply here, but the
     * general MVP principle of "one explicit action per intent" does:
     * exiting Edit Mode is still only ever right-click or ESC).
     * @param {string} widgetId
     */
    exitDragging(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state !== EditModeState.DRAGGING)
            return;
        entry.state = EditModeState.EDIT;
    }

    /** @private */
    _enterEdit(widgetId) {
        const entry = this._widgets.get(widgetId);
        entry.state = EditModeState.EDIT;

        if (!entry.back)
            entry.back = this._buildBackActor(widgetId, entry);

        this._flip(entry, true);

        // ESC only listened for while flipped - a global stage-level key
        // handler left connected all the time would be one more thing to
        // remember to disconnect in destroy() for zero benefit.
        entry.escId = global.stage.connect('key-press-event', (_stage, event) => {
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this._exitEdit(widgetId);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
    }

    /** @private */
    _exitEdit(widgetId) {
        const entry = this._widgets.get(widgetId);
        entry.state = EditModeState.NORMAL;

        if (entry.escId != null) {
            global.stage.disconnect(entry.escId);
            entry.escId = null;
        }

        this._flip(entry, false);
    }

    /** @private drives the actual rotation_angle_y tween and swaps which
     * side is reactive/visible at the halfway point, per file header. */
    _flip(entry, toBack) {
        const {actor, back} = entry;
        const fromAngle = toBack ? 0 : 180;
        const toAngle = toBack ? 180 : 0;

        actor.reactive = false; // spec: "Widget content is disabled while Edit Mode is active"
        back.reactive = toBack;
        back.visible = true; // hidden again once the tween settles on the NORMAL side, below

        actor.rotation_angle_y = fromAngle;
        actor.ease({
            rotation_angle_y: toAngle,
            duration: FLIP_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
            onComplete: () => {
                if (!toBack) {
                    back.visible = false;
                    actor.reactive = true; // content re-enabled once fully back to NORMAL
                }
            },
        });

        // Swap which actor is actually drawn right at the 90° edge-on
        // point, same trick the file header describes - avoids ever
        // showing the BACK of the front actor's own content (St actors
        // have no real double-sided rendering, so without this the
        // front content would appear mirrored for the second half of
        // the flip instead of being replaced by `back`).
        const midpointId = actor.connect('notify::rotation-angle-y', () => {
            const angle = Math.abs(actor.rotation_angle_y % 360);
            const pastHalfway = angle > FLIP_HALFWAY_DEGREES && angle < 360 - FLIP_HALFWAY_DEGREES;
            actor.visible = toBack ? !pastHalfway : pastHalfway;
            if ((toBack && pastHalfway) || (!toBack && !pastHalfway)) {
                actor.disconnect(midpointId);
            }
        });
    }

    /** @private builds the back-side St.Widget with up to four action
     * icons laid out in a single horizontal row, sized to match the
     * front actor EXACTLY (same width AND height — the widget's on-screen
     * footprint never changes between front/back). Built lazily (only
     * once, on first flip) rather than in attach() for every widget up
     * front - most widgets may never be right-clicked in a session, so
     * this avoids a St.BoxLayout + 4 St.Buttons per widget that never get
     * used.
     *
     * Real-hardware bug (2026-07-18): this used to be a VERTICAL stack of
     * full-width buttons, forced into a box the same height as the front
     * actor. Three-plus stacked buttons need more height than small
     * widgets (e.g. clock's ~90px) have to give, and St.BoxLayout doesn't
     * clip overflowing children by default, so the last button rendered
     * outside/below the visible card with no background behind it —
     * looked like a stray icon floating under the widget. A horizontal
     * row of icon-only buttons needs far less height than a vertical
     * stack of labeled ones (one icon row vs N stacked rows), so it fits
     * comfortably inside every bundled widget's front size without
     * growing the card at all. */
    _buildBackActor(widgetId, entry) {
        const [width, height] = entry.actor.get_size();

        const back = new St.BoxLayout({
            style_class: 'widget-edit-mode-back',
            vertical: false, // single horizontal row of icons, not stacked
            reactive: false, // flipped to true only while actually showing, see _flip()
            width, height, // exactly the front actor's footprint - never grows
            visible: false,
        });

        // Icon-only (no visible text label) so a row of 4 fits inside
        // even a small widget's width without wrapping/clipping.
        // `accessible_name` is set explicitly on every button below so
        // screen readers still get the full label even though nothing
        // visible spells it out — this is also what closes the
        // accessibility gap the spec previously flagged ("plain
        // St.Button with a text label only, no explicit
        // accessible_name").
        entry.tooltipCleanups = [];
        const addButton = (iconName, label, styleClass, onClicked) => {
            const button = new St.Button({
                style_class: `widget-edit-mode-action ${styleClass}`,
                accessible_name: label,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    icon_name: iconName,
                    style_class: 'widget-edit-mode-action-icon',
                }),
            });
            button.connect('clicked', onClicked);
            back.add_child(button);
            entry.tooltipCleanups.push(this._attachTooltip(button, back, label));
        };

        addButton('preferences-system-symbolic', 'Settings',
            'widget-edit-mode-action-settings', () => this._onSettings(widgetId));

        addButton('view-refresh-symbolic', 'Reset', 'widget-edit-mode-action-reset', () => {
            this._storage?.resetWidgetSettings(widgetId);
            this._storage?.removeWidgetLayoutEntry(widgetId);
            this._exitEdit(widgetId);
        });

        addButton('window-close-symbolic', 'Remove',
            'widget-edit-mode-action-remove', () => this._onRemove(widgetId));

        if (this._onUninstall && entry.isUserInstalled) {
            addButton('user-trash-symbolic', 'Uninstall', 'widget-edit-mode-action-uninstall',
                () => this._onUninstall(widgetId, entry.isUserInstalled));
        }

        // Placed as a SIBLING of the front actor (same parent, same
        // position) rather than a child - a child would rotate along
        // with the front actor's own rotation_angle_y and end up
        // mirrored too, exactly the problem this back actor exists to
        // avoid.
        const parent = entry.actor.get_parent();
        parent?.insert_child_above(back, entry.actor);
        back.set_position(entry.actor.get_x(), entry.actor.get_y());
        back.set_pivot_point(0.5, 0.5);

        return back;
    }

    /**
     * @private builds hover-tooltip behavior for a single back-side
     * button. Returns `{destroy()}` so the caller (entry.tooltipCleanups,
     * consumed by detach()) can tear it down along with everything else
     * for that widget — mirrors the disposal pattern the rest of this
     * class already uses for signal ids.
     * @param {St.Button} button
     * @param {St.Widget} back - the back-side actor the tooltip label is
     *   parented into (same actor the button itself lives in), so it
     *   flips/hides/gets destroyed together with everything else on the
     *   back side rather than needing separate lifecycle tracking.
     * @param {string} text
     */
    _attachTooltip(button, back, text) {
        let showTimeoutId = null;
        let tooltipLabel = null;

        const hide = () => {
            if (showTimeoutId != null) {
                GLib.source_remove(showTimeoutId);
                showTimeoutId = null;
            }
            tooltipLabel?.destroy();
            tooltipLabel = null;
        };

        const enterId = button.connect('enter-event', () => {
            showTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TOOLTIP_SHOW_DELAY_MS, () => {
                showTimeoutId = null;
                tooltipLabel = new St.Label({
                    style_class: 'widget-edit-mode-tooltip',
                    text,
                });
                back.insert_child_above(tooltipLabel, button);

                // Position above the button, centered — read after
                // insertion so the label has a real preferred size to
                // measure instead of guessing a fixed offset.
                const [buttonX, buttonY] = button.get_position();
                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                tooltipLabel.set_position(
                    buttonX + (button.width - labelWidth) / 2,
                    buttonY - labelHeight - 4
                );

                return GLib.SOURCE_REMOVE;
            });
            return Clutter.EVENT_PROPAGATE;
        });
        const leaveId = button.connect('leave-event', () => {
            hide();
            return Clutter.EVENT_PROPAGATE;
        });
        // A click flips the card away immediately (Settings/Remove) or
        // resets/exits (Reset) — either way the tooltip must not be left
        // dangling on an actor that's about to be hidden/rebuilt.
        const clickedId = button.connect('clicked', hide);

        return {
            destroy() {
                hide();
                try {
                    button.disconnect(enterId);
                    button.disconnect(leaveId);
                    button.disconnect(clickedId);
                } catch (e) {
                    // button may already be destroyed by the caller (back
                    // actor teardown in detach()) - same defensive pattern
                    // used elsewhere in this file.
                }
            },
        };
    }

    /** @private only transitions HOVER<->NORMAL, never touches EDIT or
     * DRAGGING - a pointer leaving the actor while its back side is
     * showing (e.g. moving to click a back-side button, which is a
     * different actor) must not silently drop out of Edit Mode. */
    _setState(widgetId, next, {ifCurrently}) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state !== ifCurrently)
            return;
        entry.state = next;
    }

    /**
     * @method detach
     * @description Disconnects all signals and destroys the back actor
     * for a single widget - call right before
     * WidgetLayer.removeWidgetActor() when a widget is unloaded (mirrors
     * DragController.detach()'s ordering rule). Safe to call for a
     * widgetId that isn't attached (no-op).
     * @param {string} widgetId
     */
    detach(widgetId) {
        const entry = this._widgets.get(widgetId);
        if (!entry)
            return;

        if (entry.escId != null)
            global.stage.disconnect(entry.escId);

        const {rightClickId, enterId, leaveId} = entry.signalIds;
        try {
            entry.actor.disconnect(rightClickId);
            entry.actor.disconnect(enterId);
            entry.actor.disconnect(leaveId);
        } catch (e) {
            // Actor may already be destroyed by the caller - nothing
            // left to disconnect from, same defensive pattern as
            // WidgetLayer.removeWidgetActor().
        }

        for (const cleanup of entry.tooltipCleanups ?? [])
            cleanup.destroy();

        entry.back?.destroy();
        this._widgets.delete(widgetId);
    }

    /**
     * @method destroy
     * @description Detaches every currently-attached widget. Call from
     * extension.js disable() BEFORE the loader destroys the actors, same
     * ordering rule as DragController.destroy().
     */
    destroy() {
        for (const widgetId of Array.from(this._widgets.keys()))
            this.detach(widgetId);
    }
}
