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
// Reposition-from-Edit-Mode (2026-07-19 fix, superseded 2026-07-21 — see
// below): the front actor is `reactive = false` for as long as EDIT is
// active (see below), so a drag can only ever start from whatever is
// actually showing at that point — the BACK actor's dedicated
// `dragHandle` child, not the front actor and, as of the 2026-07-21
// refactor below, not the back actor's toolbar buttons either. This
// module hands `back` AND `dragHandle` to EditModeDragController via the
// onBackActorReady callback the moment they're built (see
// _buildBackActor()); dragging works by pressing anywhere on the back
// side that isn't one of the toolbar's action icons, i.e. the empty
// padding around/between them — no Super key needed, same as before.
//
// Toolbar/DragHandle split (2026-07-21, handover "Bug Fix Proposal: Toolbar
// Icon Click vs Drag Conflict"): real-hardware reports showed toolbar
// icon clicks (Settings/Reset/Remove) being swallowed into a drag start
// instead of firing their action. Root cause: the whole back actor owned
// the drag button-press listener, and toolbar buttons only worked at all
// because St.Button happens to consume its own press before it bubbles
// up — an implicit ordering assumption rather than a real boundary
// between "click a button" and "start a drag". Fixed by design instead
// of event filtering/get_source() checks: `_buildBackActor()` now builds
// a dedicated, full-size `dragHandle` actor UNDER the toolbar row, and
// that is the ONLY actor EditModeDragController is ever allowed to arm a
// drag listener onto (see armDragHandle() in editModeDragController.js).
// `back` itself carries no drag-related listener anymore (only the
// right-click-to-exit one, an unrelated concern - see #1 below).
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
//
// Development Mode debug logging (2026-07-19): every state transition,
// right-click, and back-side button click below now goes through the
// optional `logger` (lib/logger.js) passed into the constructor — a
// no-op unless the Control Center's "Development Mode" switch is on.
// Added specifically so real-hardware Edit Mode reports (right-click
// not flipping back, icon clicks doing nothing, drag not starting) can
// be diagnosed from `journalctl` output instead of guessing.
//
// Flip-listener reentrancy fix (2026-07-19): `_flip()` used to leave its
// `notify::rotation-angle-y` listener as a bare local variable. If
// toggle() was called again (e.g. a fast double right-click) before the
// in-flight flip's listener had disconnected itself, the OLD listener
// stayed connected — a second, stale `notify::rotation-angle-y` handler
// now fought with the new one over `actor.visible` on every subsequent
// flip, which could leave the front actor (and/or the back actor,
// whichever handler ran last) stuck invisible — i.e. the widget
// appearing to just vanish instead of cleanly flipping. `_flip()` now
// tracks its listener id on `entry` and disconnects any previous one
// before connecting a new one, so at most one is ever live per widget.
//
// Flip finalize-timeout fix (2026-07-21, real-hardware bug reports:
// "right-click exits Edit Mode but the widget stays hidden" / "clicking
// the widget's own content does nothing" after that): the SAME class of
// bug as the reentrancy fix above, but hitting `_flip()`'s `actor.ease()`
// `onComplete` callback rather than its `notify::rotation-angle-y`
// listener — a second _flip() call replacing the in-flight
// `rotation_angle_y` transition silently drops the first call's
// `onComplete`, so `back.visible = false` / `actor.reactive = true`
// (the exit case's cleanup) could simply never run, permanently.
// `_flip()` now finalizes from a plain `GLib.timeout_add` tied to
// `FLIP_DURATION_MS` instead, guarded by a `flipGeneration` counter so
// only the most recent toggle's finalize actually takes effect. See
// `_flip()`'s own inline comment for the mechanics.

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
     * @param {(widgetId:string)=>void} [callbacks.onReset] - "Reset"
     *   back-side action, fired AFTER this module has already cleared the
     *   widget's settings file/layout entry via `storageService`. Default
     *   (if omitted) just calls `_exitEdit()`, i.e. the old behavior of
     *   flipping back to a widget that's still the same live actor/
     *   instance it was before Reset — which never actually shows the
     *   widget's defaults, since nothing reloads it (see 2026-07-20 fix:
     *   "click reset doesn't reload the widget"). The caller (extension.js)
     *   should instead rebuild the widget's instance/actor (mirroring the
     *   hot-reload path, task 08) so the reset takes visible effect
     *   immediately instead of only "on next load" as this module's own
     *   storage-layer doc comments describe.
     * @param {(widgetId:string, backActor:St.Widget, dragHandle:St.Widget)=>void} [callbacks.onBackActorReady] -
     *   fired once per widget, the first time its back-side actor is
     *   built (lazily, on first flip — see `_buildBackActor()`). Exists
     *   so EditModeDragController (task 13) can wire its drag
     *   button-press listener onto the dedicated `dragHandle` actor
     *   (2026-07-21 refactor) instead of the front actor or `backActor`
     *   as a whole — front content is `reactive = false` for the entire
     *   time Edit Mode is active (see `_flip()`), and `backActor` itself
     *   is deliberately given no drag-related listener at all anymore,
     *   so a toolbar button click can never be reinterpreted as a drag
     *   start. `backActor` is still passed too, since it's what actually
     *   needs to be moved/eased on screen during the drag — `dragHandle`
     *   is only the event surface, it moves along as `backActor`'s own
     *   child for free.
     */
    /**
     * @param {ThemeService} [themeService] - optional (lib/themeService.js).
     *   If supplied, the back-side card's background/drop-shadow is styled
     *   from `theme.json`'s global appearance settings via
     *   `applyGlobalStyle()` (see themeService.js) each time a widget's
     *   back actor is (lazily) built — a widget-specific `theme.json`
     *   entry, if any, is not consulted here on purpose: the flip card
     *   is host chrome, not widget content, so only the GLOBAL appearance
     *   applies to it, same as every other widget's back card. Omitting
     *   this parameter (or passing null) keeps the back card exactly as
     *   styled by `stylesheet.css`'s `.widget-edit-mode-back` class alone
     *   — i.e. fully optional, no behavior change for a caller that
     *   doesn't have a ThemeService instance to hand.
     */
    constructor(storageService, callbacks = {}, logger = null, themeService = null) {
        this._storage = storageService;
        this._theme = themeService;
        this._onSettings = callbacks.onSettings ?? (() => {});
        this._onRemove = callbacks.onRemove ?? (() => {});
        this._onUninstall = callbacks.onUninstall ?? null;
        // Defaulting to _exitEdit keeps this module usable standalone
        // (e.g. in tests) without a caller-supplied onReset — see the
        // constructor doc comment above for why extension.js supplies a
        // real one in production.
        this._onReset = callbacks.onReset ?? (widgetId => this._exitEdit(widgetId));
        this._onBackActorReady = callbacks.onBackActorReady ?? (() => {});
        // Optional (lib/logger.js) — debug() is a no-op if omitted, so
        // this module works unchanged for any caller that doesn't pass one.
        this._logger = logger ?? {debug() {}, warn() {}, error() {}};

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
        if (this._widgets.has(widgetId)) {
            this._logger.debug('edit-mode', `attach("${widgetId}") skipped — already attached`);
            return;
        }
        this._logger.debug('edit-mode', `attach("${widgetId}")`);

        // A flip that visibly rotates needs perspective depth and a
        // pivot at the actor's own center, not its top-left corner (the
        // Clutter default) — otherwise it looks like it's swinging on a
        // hinge at the corner instead of spinning in place.
        actor.set_pivot_point(0.5, 0.5);

        const rightClickId = actor.connect('button-press-event', (_actor, event) => {
            this._logger.debug('edit-mode',
                `front button-press("${widgetId}") button=${event.get_button()} state=${this.getState(widgetId)}`);
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
            flipListenerId: null, // live notify::rotation-angle-y listener, see _flip()
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
        if (!entry) {
            this._logger.warn('edit-mode', `toggle("${widgetId}") — no such widget attached`);
            return;
        }
        if (entry.state === EditModeState.DRAGGING) {
            this._logger.debug('edit-mode', `toggle("${widgetId}") ignored — currently DRAGGING`);
            return;
        }

        this._logger.debug('edit-mode', `toggle("${widgetId}") from state=${entry.state}`);
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
        this._logger.debug('edit-mode', `_enterEdit("${widgetId}") back-actor-exists=${!!entry.back}`);

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
        this._logger.debug('edit-mode', `_exitEdit("${widgetId}")`);

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

        this._logger.debug('edit-mode',
            `_flip(toBack=${toBack}) currentAngle=${actor.rotation_angle_y} -> ${fromAngle} -> ${toAngle}`);

        // Reentrancy fix (2026-07-19, real-hardware bug): a fast double
        // right-click (or toggle() called again before the previous
        // flip's tween/listener finished) used to leave the PREVIOUS
        // call's `notify::rotation-angle-y` listener still connected
        // below, fighting the new one over `actor.visible` and
        // occasionally leaving the widget stuck invisible. Disconnect
        // any listener from a prior _flip() call on this entry first, so
        // at most one is ever live.
        if (entry.flipListenerId != null) {
            try {
                actor.disconnect(entry.flipListenerId);
            } catch (e) {
                // Actor may already be mid-teardown - same defensive
                // pattern used throughout this file.
            }
            entry.flipListenerId = null;
        }

        actor.reactive = false; // spec: "Widget content is disabled while Edit Mode is active"
        back.reactive = toBack;
        back.visible = true; // hidden again once the tween settles on the NORMAL side, below

        actor.rotation_angle_y = fromAngle;
        actor.ease({
            rotation_angle_y: toAngle,
            duration: FLIP_DURATION_MS,
            mode: Clutter.AnimationMode.EASE_IN_OUT_QUAD,
        });

        // 2026-07-21 fix (real-hardware bug report: "right-click exits Edit
        // Mode but the widget never reappears" / "clicking the widget's own
        // content does nothing afterward"): this used to restore
        // `back.visible = false` / `actor.reactive = true` from the ease()'s
        // `onComplete` callback. That callback is silently DROPPED if a
        // second _flip() call replaces this same transition
        // (`actor.rotation_angle_y`) before it finishes — e.g. a fast
        // right-click-right-click, or Reset/Remove racing a still-animating
        // exit — which permanently left `back` visible (covering the widget)
        // and `actor.reactive` stuck `false`.
        //
        // SUPERSEDED (2026-07-21, later same day — real-hardware report:
        // "widget disappears entirely, both front and back, transparent"):
        // the GLib.timeout_add fix above finalized on a plain WALL-CLOCK
        // delay (`FLIP_DURATION_MS + 16`), completely decoupled from the
        // notify::rotation-angle-y listener below that actually drives
        // `actor.visible` off the REAL animated angle. Those are two
        // independent clocks for what should be one atomic transition: if
        // the real Clutter transition ever takes longer than the assumed
        // 266ms (dropped frames, a loaded compositor, many widgets
        // animating at once — exactly the kind of thing that only shows up
        // on real hardware, never in a read-through), the timeout fires
        // `back.visible = false` BEFORE the rotation has actually crossed
        // 90°, i.e. before the listener has set `actor.visible = true` —
        // both actors are momentarily invisible at once, and on unlucky
        // timing this is visible as the widget just vanishing.
        //
        // Fixed by removing the separate timer entirely and doing the
        // `back`/`actor.reactive` cleanup from INSIDE the same
        // notify::rotation-angle-y callback, at the exact moment it
        // determines the crossover has happened — one source of truth for
        // "is the flip actually done" instead of two clocks that can drift
        // apart. This doesn't reintroduce the original onComplete-drop bug
        // either: a second, overlapping `_flip()` call still disconnects
        // this listener up front (see the reentrancy guard above) before
        // it can ever fire a stale cleanup, so an interrupted transition's
        // old listener is cleanly discarded rather than racing the new one.

        // Swap which actor is actually drawn right at the 90° edge-on
        // point, same trick the file header describes - avoids ever
        // showing the BACK of the front actor's own content (St actors
        // have no real double-sided rendering, so without this the
        // front content would appear mirrored for the second half of
        // the flip instead of being replaced by `back`).
        // Bug fix (2026-07-20, "right-click doesn't flip back, widget just
        // disappears"): `pastHalfway` is a purely geometric fact — the
        // front actor's face points away from the viewer whenever the
        // angle is in the (90°, 270°) arc, full stop. The front actor
        // should be visible exactly when it's NOT in that arc, regardless
        // of which direction (toBack true or false) the flip is going.
        // The previous version used `toBack ? !pastHalfway : pastHalfway`,
        // which for the toBack=false (exit Edit Mode) case set
        // `actor.visible = pastHalfway` — backwards. That made the front
        // actor briefly (and wrongly) visible for the FIRST half of the
        // exit animation (180°→90°, while it's still edge-on/back-facing),
        // then, once the angle crossed below 90° (the point it should
        // finally become visible again), computed pastHalfway=false and
        // set `actor.visible = false` on that exact update — which is
        // also the update that disconnects this listener (see the
        // condition below), so the front actor was left permanently
        // invisible for the rest of the animation and beyond. That's the
        // "flips back but the widget just disappears" report. Using the
        // same `!pastHalfway` formula for both directions fixes both: it
        // already matched the toBack=true (enter) case exactly, and for
        // toBack=false now correctly stays false through the first half
        // and flips to true (and stays true) once the angle crosses back
        // under 90°.
        let finalized = false;
        const generation = (entry.flipGeneration = (entry.flipGeneration ?? 0) + 1);
        const finalize = () => {
            if (finalized)
                return;
            finalized = true;
            this._logger.debug('edit-mode', `_flip(toBack=${toBack}) finalize`);
            if (!toBack) {
                try {
                    back.visible = false;
                    actor.reactive = true; // content re-enabled once fully back to NORMAL
                } catch (e) {
                    // back/actor may have been destroyed out from under this
                    // in-flight flip (see the safety-net comment below) -
                    // nothing left to finalize onto.
                }
            }
        };
        entry.flipListenerId = actor.connect('notify::rotation-angle-y', () => {
            const angle = Math.abs(actor.rotation_angle_y % 360);
            const pastHalfway = angle > FLIP_HALFWAY_DEGREES && angle < 360 - FLIP_HALFWAY_DEGREES;
            actor.visible = !pastHalfway;
            if ((toBack && pastHalfway) || (!toBack && !pastHalfway)) {
                actor.disconnect(entry.flipListenerId);
                entry.flipListenerId = null;
                // Finalize cleanup lives HERE now (see 2026-07-21 comment
                // above) instead of a separate GLib timeout, so it can
                // never fire out of sync with the actual crossover.
                finalize();
            }
        });

        // Safety net (2026-07-21, real-hardware report: "Reset mid-exit
        // permanently freezes the widget"): the crossover above is the
        // normal path, but it depends on `actor`'s rotation transition
        // actually running to completion — if something else destroys or
        // replaces this widget's actor/back mid-flip (e.g. a toolbar button
        // click that itself triggers a rebuild, before the isEditing() guard
        // added alongside this fix existed/for any other future reason this
        // transition gets interrupted), the notify listener above simply
        // never fires again and the widget is stuck with no working
        // exit-path (back already non-reactive, ESC already disconnected by
        // `_exitEdit()`). A generous fallback timeout (3x the nominal
        // duration, well past any legitimate frame hiccup) forces the same
        // cleanup so the widget can never be PERMANENTLY stuck, even though
        // the crossover-based path above is what runs in the normal case.
        // `finalized`/`generation` make this a no-op if the real crossover
        // (or a newer, superseding `_flip()` call) already handled it.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, FLIP_DURATION_MS * 3, () => {
            if (entry.flipGeneration === generation)
                finalize();
            return GLib.SOURCE_REMOVE;
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
        this._logger.debug('edit-mode', `_buildBackActor("${widgetId}") frontSize=${width}x${height}`);
        if (width <= 0 || height <= 0) {
            this._logger.warn('edit-mode',
                `_buildBackActor("${widgetId}") built with a non-positive size (${width}x${height}) — ` +
                'the front actor likely has not been allocated yet; the back side may render invisibly. ' +
                'If icon clicks/right-click seem to do nothing, this is the first thing to check.');
        }

        // 2026-07-19 fix (real-hardware bug report): `back` used to BE the
        // St.BoxLayout the icons were added to directly, with every button
        // `x_expand: true` so the row filled the entire card. That left
        // almost no "empty space" (just the 8px padding / 6px spacing) for
        // EditModeDragController to grab a drag from, and made the row
        // reflow (see the tooltip note below) shove buttons around under
        // the pointer. Now `back` is a plain, non-layout-managed St.Widget
        // that owns 100% of the card's surface (right-click-to-exit
        // attaches to THIS actor), and the icons live in a separate,
        // content-sized `toolbar` centered inside it, itself layered on
        // top of a dedicated `dragHandle` actor (2026-07-21 refactor —
        // see this method's own inline comments below) that owns 100% of
        // the same surface for drag purposes instead — so everywhere
        // outside the toolbar's own small footprint is free, reliable
        // drag/empty space, exactly matching the "drag from empty space"
        // spec.
        const back = new St.Widget({
            style_class: 'widget-edit-mode-back',
            layout_manager: new Clutter.BinLayout(),
            reactive: false, // flipped to true only while actually showing, see _flip()
            width, height, // exactly the front actor's footprint - never grows
            visible: false,
        });

        // Icon-click-vs-drag design decision (2026-07-21 handover): drag
        // used to be armed on `back` as a whole, relying on St.Button
        // consuming its OWN button-press-event before it could bubble up
        // to back's drag-start handler. That's an implicit ordering
        // assumption, not a real boundary — hence real-hardware reports of
        // toolbar clicks instead being swallowed into a drag start. Fixed
        // at the architecture level instead: `dragHandle` is a dedicated,
        // full-size actor added FIRST (so it sits at the bottom of the
        // z-order) and is the ONLY actor EditModeDragController ever wires
        // a button-press listener onto (see armDragHandle() in
        // editModeDragController.js) — `back` itself no longer has any
        // drag-related listener at all. `toolbar` (below) is added on top
        // of it but is itself non-reactive, so a press anywhere in its
        // padding/gaps falls straight through to `dragHandle` beneath, the
        // same "drag from empty space" behavior as before — but a press on
        // one of `toolbar`'s St.Button children is consumed by that
        // button and never reaches `dragHandle` at all, by construction,
        // not by hoping propagation stops at the right point.
        const dragHandle = new St.Widget({
            style_class: 'widget-edit-mode-drag-handle',
            reactive: true, // only ever actually hit-tested while `back` is visible (EDIT/DRAGGING)
            x_expand: true,
            y_expand: true, // fills the entire card - moves as a child whenever `back` is repositioned
        });
        back.add_child(dragHandle);

        const toolbar = new St.BoxLayout({
            style_class: 'widget-edit-mode-icon-row widget-edit-mode-toolbar',
            vertical: false, // single horizontal row of icons, not stacked
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            // Deliberately NOT reactive and NEVER given a button-press
            // listener of its own - it exists purely to lay out the
            // buttons, and letting a press fall through to `dragHandle`
            // when it misses every button is what preserves "drag from
            // empty space around the icons".
        });
        back.add_child(toolbar);

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
                y_align: Clutter.ActorAlign.CENTER,
                child: new St.Icon({
                    icon_name: iconName,
                    style_class: 'widget-edit-mode-action-icon',
                }),
            });
            button.connect('clicked', () => {
                // Guard (2026-07-21, real-hardware bug report: "Reset mid-
                // exit permanently freezes the widget in Edit Mode"):
                // unlike dragHandle's press handler (which already checks
                // `isEditing()` before starting a drag), these buttons used
                // to fire unconditionally on 'clicked'. Each St.Button's own
                // `reactive` is independent of its `back` parent's — so for
                // the ~250ms the flip-out animation is still running (back
                // is still `visible`, only `back.reactive`/`entry.state`
                // have already flipped to NORMAL), a button here could still
                // be clicked even though Edit Mode is already exiting. If
                // that click was Reset, `_onReset` rebuilds the widget's
                // actor/back from scratch mid-animation, destroying the very
                // actor this in-flight `_flip()` still holds a transition on
                // — its notify::rotation-angle-y listener then never sees
                // another update, the 90° crossover (and therefore the
                // `back.visible = false` / `actor.reactive = true` cleanup
                // that now lives there, see `_flip()`) never fires, and
                // nothing is left listening for right-click either (`back`
                // is already non-reactive) or ESC (already disconnected by
                // `_exitEdit()` up front) — permanently stuck. Skipping the
                // action here whenever we're not actually, currently EDIT
                // closes that window the same way drag-start already did.
                if (!this.isEditing(widgetId)) {
                    this._logger.debug('edit-mode',
                        `back button clicked ("${widgetId}", label="${label}") ignored — not editing`);
                    return;
                }
                this._logger.debug('edit-mode', `back button clicked ("${widgetId}", label="${label}")`);
                onClicked();
            });
            toolbar.add_child(button);
            entry.tooltipCleanups.push(this._attachTooltip(button, back, toolbar, label));
        };

        addButton('preferences-system-symbolic', 'Settings',
            'widget-edit-mode-action-settings', () => this._onSettings(widgetId));

        addButton('view-refresh-symbolic', 'Reset', 'widget-edit-mode-action-reset', () => {
            this._storage?.resetWidgetSettings(widgetId);
            this._storage?.removeWidgetLayoutEntry(widgetId);
            // 2026-07-20 fix ("click reset doesn't reload the widget"):
            // used to call `this._exitEdit(widgetId)` directly, which only
            // flips the SAME still-running widget instance back to its
            // front side — the settings/layout files on disk were reset,
            // but nothing ever told the live instance to reload them, so
            // visually nothing changed until the next full extension
            // reload. `_onReset` (extension.js) rebuilds the widget's
            // instance/actor from scratch, the same way task 08's
            // hot-reload does, and re-places it at its now-defaulted
            // position — so Reset takes effect immediately. That callback
            // is responsible for exiting Edit Mode itself (it detaches
            // and rebuilds this widget's WidgetEditMode entry entirely),
            // so this handler does NOT also call _exitEdit().
            this._onReset(widgetId);
        });

        addButton('window-close-symbolic', 'Remove',
            'widget-edit-mode-action-remove', () => this._onRemove(widgetId));

        if (this._onUninstall && entry.isUserInstalled) {
            addButton('user-trash-symbolic', 'Uninstall', 'widget-edit-mode-action-uninstall',
                () => this._onUninstall(widgetId, entry.isUserInstalled));
        }

        // Real-hardware bug (2026-07-19): right-click only ever flipped
        // NORMAL/HOVER -> EDIT, never back the other way, because the
        // *front* actor was the only one that ever listened for it — and
        // the front actor is `reactive = false` and hidden for as long as
        // EDIT is active (see _flip()), so once flipped there was nothing
        // left listening for the right-click that's supposed to flip it
        // back. `back` needs the exact same handler. St.Button only ever
        // consumes PRIMARY button presses for its own click handling, so
        // a right-click still reaches this actor even when the pointer is
        // over one of the icons.
        back.connect('button-press-event', (_actor, event) => {
            this._logger.debug('edit-mode',
                `back button-press("${widgetId}") button=${event.get_button()} state=${this.getState(widgetId)}`);
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;

            this.toggle(widgetId);
            return Clutter.EVENT_STOP;
        });

        // Placed as a SIBLING of the front actor (same parent, same
        // position) rather than a child - a child would rotate along
        // with the front actor's own rotation_angle_y and end up
        // mirrored too, exactly the problem this back actor exists to
        // avoid.
        const parent = entry.actor.get_parent();
        parent?.insert_child_above(back, entry.actor);
        back.set_position(entry.actor.get_x(), entry.actor.get_y());
        back.set_pivot_point(0.5, 0.5);

        // Theme system (2026-07-21): style the card's background/drop
        // shadow from theme.json's GLOBAL appearance settings, if a
        // ThemeService was supplied — additive with `set_style()`, so
        // `.widget-edit-mode-back`'s own stylesheet.css rules still apply
        // for anything the theme config doesn't set (see themeService.js's
        // applyGlobalStyle() doc comment).
        this._theme?.applyGlobalStyle(back);

        // Let EditModeDragController (task 13) arm the DEDICATED drag
        // handle for dragging — see the constructor's onBackActorReady doc
        // comment. `dragHandle` (not `back`) is deliberately the only
        // thing ever handed a button-press listener for drag purposes.
        this._onBackActorReady(widgetId, back, dragHandle);

        return back;
    }

    /**
     * @private builds hover-tooltip behavior for a single back-side
     * button. Returns `{destroy()}` so the caller (entry.tooltipCleanups,
     * consumed by detach()) can tear it down along with everything else
     * for that widget — mirrors the disposal pattern the rest of this
     * class already uses for signal ids.
     * @param {St.Button} button
     * @param {St.Widget} back - the plain (non-layout-managed) back-side
     *   actor the tooltip label is parented into. Real-hardware bug
     *   (2026-07-19): this used to parent the tooltip into the icon
     *   St.BoxLayout itself via insert_child_above() — but a BoxLayout
     *   lays out EVERY child it's given, tooltip label included, so on
     *   hover the label became a real extra column in the row (with its
     *   own dark background), pushing every button after it sideways
     *   instead of floating above them. Parenting into `back` (which
     *   uses a BinLayout, so children are positioned purely by
     *   set_position()) makes it a true floating overlay that never
     *   affects the icon row's layout.
     * @param {St.BoxLayout} toolbar - the actor `button` is actually a
     *   child of, needed to translate `button`'s position (relative to
     *   toolbar) into a position relative to `back`.
     * @param {string} text
     */
    _attachTooltip(button, back, toolbar, text) {
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
                // Sibling of toolbar (a child of `back` directly), on top
                // of everything - a floating overlay, never a participant
                // in toolbar's box layout.
                back.insert_child_above(tooltipLabel, toolbar);

                // Position above the button, centered — read after
                // insertion so the label has a real preferred size to
                // measure instead of guessing a fixed offset. Both
                // `toolbar` and `button` positions are relative to their
                // own parent, so they have to be summed to get a position
                // relative to `back` (the actor the tooltip is actually
                // parented into).
                const [rowX, rowY] = toolbar.get_position();
                const [buttonX, buttonY] = button.get_position();
                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                tooltipLabel.set_position(
                    rowX + buttonX + (button.width - labelWidth) / 2,
                    rowY + buttonY - labelHeight - 4
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

    /**
     * @method reapplyTheme
     * @description Re-styles every widget's already-built back card from
     * the current global theme — call after `ThemeService.reload()` picks
     * up an external `theme.json` change (see themeService.js's `watch()`)
     * so an already-flipped (or previously-flipped-then-back) widget's
     * card reflects the new appearance without needing another flip.
     * Widgets whose back card was never built yet (never flipped this
     * session) need nothing here — `_buildBackActor()` reads the current
     * theme fresh the first time it runs.
     */
    reapplyTheme() {
        if (!this._theme)
            return;
        for (const entry of this._widgets.values()) {
            if (entry.back)
                this._theme.applyGlobalStyle(entry.back);
        }
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

        if (entry.flipListenerId != null) {
            try {
                entry.actor.disconnect(entry.flipListenerId);
            } catch (e) {
                // Actor may already be destroyed - same defensive pattern
                // as everywhere else in this method.
            }
        }

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
