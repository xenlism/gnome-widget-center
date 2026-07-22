// products/extension/lib/widgetEditMode.js
//
// Task 12 — Widget Edit Mode. Right-click a widget to show a small
// floating toolbar bar over its top edge with Settings/Reset/Remove/
// Uninstall actions and a drag grip; right-click the bar again or ESC
// hides it. Per development/architecture/specs/ui/widget-edit-mode.md.
//
// State machine (per widget, independent of every other widget — there is
// no "one edit mode for the whole desktop", each widget's toolbar shows on
// its own):
//
//   NORMAL --(pointer enter)--> HOVER --(pointer leave)--> NORMAL
//   NORMAL/HOVER --(right-click)--> EDIT --(right-click / ESC)--> NORMAL
//   EDIT --(task 13 drag-start)--> DRAGGING --(drop)--> EDIT
//
// This module owns NORMAL/HOVER/EDIT and the EDIT<->DRAGGING transition
// points (enterDragging()/exitDragging() below), but does not implement
// the drag itself — EditModeDragController (task 13) calls those two
// hooks and does the pointer tracking/grid-snap/persistence.
//
// 2026-07-21, design change (real-hardware feedback: the original
// "flip the whole widget over to a back card" design was replaced
// wholesale) — instead of rotating the widget 180° to a same-size back
// side, Edit Mode now overlays a fixed-height TOOLBAR BAR across the
// widget's own top edge (same width as the widget, same top-left corner —
// footprint unchanged, per spec's Non-Goals: resize is still not
// supported). The widget's own content stays visible underneath the
// whole time; only the strip the toolbar bar covers is obscured. This
// removes an entire class of bug that plagued the flip design: there is
// no second, full-size actor to keep in sync with the front one, no
// rotation tween to race against, and nothing to "swap which side is
// showing" — showing/hiding the toolbar is a single opacity fade on one
// small overlay actor, so a widget can never end up "vanished" (both
// sides invisible) or "stuck flipped" (front never comes back) the way
// the old `_flip()` could under bad timing. See `_showToolbar()`/
// `_hideToolbar()` below for exactly how that fade is driven.
//
// Prior history, kept for context (this file no longer contains a flip,
// but the same real-hardware lessons still apply to the toolbar's own
// show/hide and its buttons):
//   - 2026-07-19: back-side icon clicks fought a full-card drag listener
//     for the same press event (implicit St.Button-consumes-first
//     ordering, not a real boundary) — fixed by giving drag its own
//     dedicated event-surface actor, never the container the buttons
//     live in. The toolbar bar below keeps that split: `dragArea` is the
//     ONLY actor EditModeDragController is ever handed a press listener
//     for (see onBackActorReady below), never the toolbar bar itself.
//   - 2026-07-19/07-21: two different rounds of "the widget doesn't come
//     back" bugs, both from the OLD flip's cleanup running on a clock
//     unrelated to what was actually on screen (a dropped ease()
//     onComplete, then a wall-clock GLib.timeout_add racing the real
//     rotation). Not applicable to the current design (see above), but
//     the LESSON carried forward: `_hideToolbar()` still guards its own
//     cleanup with a `finalized` flag and a generation counter (see
//     below) rather than assuming its ease()'s onComplete is guaranteed
//     to run — cheap insurance against the same class of bug recurring
//     in a new shape.
//   - 2026-07-21: a Reset click landing mid-exit-transition rebuilt the
//     widget's actor out from under an in-flight animation, orphaning it
//     permanently. The toolbar's buttons still guard every click with
//     `isEditing()` (see `addButton` below) for the same reason — cheap,
//     and still the right call even though the transition it originally
//     protected against no longer exists in this design.
//
// Development Mode debug logging (2026-07-19): every state transition,
// right-click, and toolbar button click below still goes through the
// optional `logger` (lib/logger.js) passed into the constructor — a
// no-op unless the Control Center's "Development Mode" switch is on.
//
// Widget content is disabled while EDIT (and therefore also DRAGGING) is
// active, per spec — `actor.reactive = false` on the front content so
// clicks can't reach whatever the widget itself put there (e.g. the
// media-player widget's own play/pause button). Unlike the old flip
// design, the front actor stays VISIBLE the whole time now (only
// non-reactive) — the toolbar bar is a small overlay, not a full
// replacement, so there's no reason to hide the widget's own content
// underneath it.
//
// Resize is explicitly NOT supported (see spec's Non-Goals) — nothing
// here ever changes a widget actor's width/height, only the toolbar
// bar's opacity/visibility and position (the latter is task 13's job,
// not this file's).

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

export const EditModeState = Object.freeze({
    NORMAL: 'normal',
    HOVER: 'hover',
    EDIT: 'edit',
    DRAGGING: 'dragging',
});

// Height of the floating toolbar bar overlaid on the widget's top edge.
// Deliberately small/fixed — it's chrome sitting ON TOP of the widget's
// existing footprint, not something that grows the widget (see spec's
// Non-Goals re: resize).
const TOOLBAR_HEIGHT = 32;
const TOOLBAR_FADE_MS = 150;

// How long the pointer has to sit still over a toolbar icon button
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
     *   this module reaching into SettingsService/WidgetLoader directly.
     * @param {object} callbacks
     * @param {(widgetId:string)=>void} callbacks.onSettings - "Settings"
     *   toolbar action. Typically opens the Control Center to this
     *   widget's prefs page (task 05).
     * @param {(widgetId:string)=>void} callbacks.onRemove - "Remove"
     *   toolbar action.
     * @param {(widgetId:string, isUserInstalled:boolean)=>void} [callbacks.onUninstall] -
     *   "Uninstall" toolbar action. Only meaningful for user-installed
     *   widgets — see attach()'s `isUserInstalled` option. Optional; if
     *   omitted the Uninstall button is not shown at all.
     * @param {(widgetId:string)=>void} [callbacks.onReset] - "Reset"
     *   toolbar action, fired AFTER this module has already cleared the
     *   widget's settings file/layout entry via `storageService`. Default
     *   (if omitted) just calls `_exitEdit()`. The caller (extension.js)
     *   should instead rebuild the widget's instance/actor (mirroring the
     *   hot-reload path, task 08) so the reset takes visible effect
     *   immediately.
     * @param {(widgetId:string, toolbarActor:St.Widget, dragArea:St.Widget)=>void} [callbacks.onBackActorReady] -
     *   fired once per widget, the first time its toolbar bar is built
     *   (lazily, on first right-click — see `_buildToolbar()`). Exists so
     *   EditModeDragController (task 13) can wire its drag button-press
     *   listener onto the dedicated `dragArea` actor instead of the front
     *   actor as a whole. `toolbarActor` is also passed since it's what
     *   needs to be moved/eased on screen in lockstep with the widget
     *   during a drag (it's a sibling actor, not the widget's own child,
     *   so it doesn't move for free). Kept the same callback name as
     *   before this design change, since EditModeDragController.
     *   armDragHandle() only ever treats its two arguments generically
     *   (an actor to reposition, an actor to arm a press listener onto)
     *   and needed no changes itself.
     */
    /**
     * @param {ThemeService} [themeService] - optional (lib/themeService.js).
     *   If supplied, the toolbar bar's background/drop-shadow is styled
     *   from `theme.json`'s global appearance settings via
     *   `applyGlobalStyle()` each time a widget's toolbar is (lazily)
     *   built — a widget-specific `theme.json` entry, if any, is not
     *   consulted here on purpose: the toolbar is host chrome, not widget
     *   content. Omitting this parameter (or passing null) keeps the
     *   toolbar exactly as styled by `stylesheet.css` alone.
     */
    constructor(storageService, callbacks = {}, logger = null, themeService = null) {
        this._storage = storageService;
        this._theme = themeService;
        this._onSettings = callbacks.onSettings ?? (() => {});
        this._onRemove = callbacks.onRemove ?? (() => {});
        this._onUninstall = callbacks.onUninstall ?? null;
        this._onReset = callbacks.onReset ?? (widgetId => this._exitEdit(widgetId));
        this._onBackActorReady = callbacks.onBackActorReady ?? (() => {});
        // Optional (lib/logger.js) — debug() is a no-op if omitted, so
        // this module works unchanged for any caller that doesn't pass one.
        this._logger = logger ?? {debug() {}, warn() {}, error() {}};

        /** @private {Map<string, object>} widgetId -> per-widget state */
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
     *   (from buildActor()) — never replaced or reparented, never hidden;
     *   only its `reactive` flag changes, and a toolbar bar is overlaid
     *   above its top edge while EDIT is active.
     * @param {{isUserInstalled?: boolean}} [options] - isUserInstalled
     *   gates whether the Uninstall button appears at all.
     */
    attach(widgetId, actor, options = {}) {
        if (this._widgets.has(widgetId)) {
            this._logger.debug('edit-mode', `attach("${widgetId}") skipped — already attached`);
            return;
        }
        this._logger.debug('edit-mode', `attach("${widgetId}")`);

        const rightClickId = actor.connect('button-press-event', (_actor, event) => {
            this._logger.debug('edit-mode',
                `front button-press("${widgetId}") button=${event.get_button()} state=${this.getState(widgetId)}`);
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;

            // Only ever enters EDIT from here — front actor is
            // `reactive = false` once EDIT starts (see _enterEdit()), so
            // this handler simply won't fire again until back to NORMAL/
            // HOVER; exiting is the toolbar bar's own job (see
            // _buildToolbar()) plus ESC (see _enterEdit()).
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
            toolbar: null, // St.Widget, built lazily on first right-click - see _buildToolbar()
            isUserInstalled: options.isUserInstalled ?? false,
            escId: null, // connected only while state === EDIT, see _enterEdit()/_exitEdit()
            toolbarGeneration: 0, // guards _showToolbar()/_hideToolbar() finalize, see there
            signalIds: {rightClickId, enterId, leaveId},
        });
    }

    /**
     * @method toggle
     * @description Toggles a widget between NORMAL/HOVER and EDIT. No-op
     * if the widget is currently DRAGGING (task 13 owns exiting that
     * state via exitDragging()).
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
     * spec ("Drag is available only while Edit Mode is active"). Also
     * used by the toolbar's own buttons (see addButton()) to reject a
     * stray click that lands after the toolbar has already started
     * hiding.
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
     * right-click or ESC during the drag itself doesn't also try to hide
     * the toolbar mid-motion — task 13's own release handler is what
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
     * to EDIT (toolbar still showing — a single drag doesn't imply the
     * user is done editing; exiting Edit Mode is still only ever
     * right-click-the-toolbar or ESC).
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
        this._logger.debug('edit-mode', `_enterEdit("${widgetId}") toolbar-exists=${!!entry.toolbar}`);

        if (!entry.toolbar)
            entry.toolbar = this._buildToolbar(widgetId, entry);

        // Spec: "Widget content is disabled while Edit Mode is active."
        // The front actor stays VISIBLE (unlike the old flip design) —
        // only its own interactivity is switched off; the toolbar bar
        // overlaid on top is what's actually usable now.
        entry.actor.reactive = false;

        this._showToolbar(entry);

        // ESC only listened for while EDIT/DRAGGING - a global stage-level
        // key handler left connected all the time would be one more thing
        // to remember to disconnect in destroy() for zero benefit.
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

        entry.actor.reactive = true;
        this._hideToolbar(entry);
    }

    /** @private fades the toolbar bar in and marks it visible/reactive.
     * No dual-actor swap, no rotation tween to race against — just one
     * small overlay actor's opacity, so there's nothing here that can
     * leave the widget itself stuck either way. */
    _showToolbar(entry) {
        const {toolbar} = entry;
        const generation = ++entry.toolbarGeneration;

        toolbar.remove_all_transitions();
        toolbar.reactive = true;
        toolbar.visible = true;
        toolbar.ease({
            opacity: 255,
            duration: TOOLBAR_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                // A newer toggle may have already interrupted/superseded
                // this fade (e.g. a fast right-click-right-click) - if so
                // its own ease() is the one whose onComplete should apply,
                // not this stale one.
                if (entry.toolbarGeneration !== generation)
                    return;
                this._logger.debug('edit-mode', `_showToolbar finalize`);
            },
        });
    }

    /** @private fades the toolbar bar out, then hides/disables it once
     * fully transparent. Guarded the same defensive way _showToolbar()
     * is — see its comment — even though, unlike the old flip's
     * `_flip()`, there's no second actor or rotation angle for this to
     * race against; it's cheap insurance, not a fix for an active bug. */
    _hideToolbar(entry) {
        const {toolbar} = entry;
        const generation = ++entry.toolbarGeneration;

        toolbar.remove_all_transitions();
        toolbar.reactive = false;
        toolbar.ease({
            opacity: 0,
            duration: TOOLBAR_FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (entry.toolbarGeneration !== generation)
                    return;
                this._logger.debug('edit-mode', `_hideToolbar finalize`);
                try {
                    toolbar.visible = false;
                } catch (e) {
                    // toolbar may have been destroyed out from under this
                    // in-flight fade (e.g. detach() during teardown) -
                    // nothing left to finalize onto.
                }
            },
        });
    }

    /** @private builds the floating toolbar bar overlaid on the widget's
     * top edge: up to four action icon buttons on the left, then an
     * expanding drag area (with a grip glyph at its far end) filling the
     * rest of the bar's width. Same width as the front actor, fixed
     * height (TOOLBAR_HEIGHT) — the widget's own footprint never changes
     * (see spec's Non-Goals re: resize). Built lazily (only once, on
     * first right-click) rather than in attach() for every widget up
     * front - most widgets may never be right-clicked in a session.
     *
     * Icon-click-vs-drag design (carried forward from the old flip-card
     * design's 2026-07-21 fix): the toolbar's row and its `dragArea` are
     * two separate actors. `dragArea` is added FIRST (bottom of the
     * z-order, `x_expand: true` so it fills all the space after the icon
     * buttons) and is the ONLY actor EditModeDragController is ever
     * allowed to arm a drag listener onto (see armDragHandle() in
     * editModeDragController.js) — a press on one of the icon buttons is
     * consumed by that St.Button and never reaches `dragArea` at all, by
     * construction, and a press that misses every button (including the
     * grip glyph, which is a plain non-reactive St.Label layered on top
     * of `dragArea` purely as a visual cue for where to grab) falls
     * straight through to it.
     */
    _buildToolbar(widgetId, entry) {
        const [width] = entry.actor.get_size();
        this._logger.debug('edit-mode', `_buildToolbar("${widgetId}") frontWidth=${width}`);
        if (width <= 0) {
            this._logger.warn('edit-mode',
                `_buildToolbar("${widgetId}") built with a non-positive width (${width}) — ` +
                'the front actor likely has not been allocated yet; the toolbar may render ' +
                'invisibly or zero-width. If icon clicks/right-click seem to do nothing, this ' +
                'is the first thing to check.');
        }

        // Plain, non-layout-managed outer actor - tooltips (see
        // _attachTooltip()) are parented into THIS, not the BoxLayout row
        // below, so they float as a true overlay instead of becoming an
        // extra column the row's layout manager tries to position (the
        // exact bug the old flip-card design's back/toolbar split fixed
        // in 2026-07-19 — kept the same way here for the same reason).
        const toolbar = new St.Widget({
            style_class: 'widget-edit-mode-toolbar-bar',
            layout_manager: new Clutter.BinLayout(),
            reactive: false, // toggled true only while actually showing, see _showToolbar()
            width, height: TOOLBAR_HEIGHT, // fixed strip, never grows with content
            visible: false,
            opacity: 0,
        });

        const row = new St.BoxLayout({
            style_class: 'widget-edit-mode-icon-row',
            vertical: false,
            x_expand: true,
            y_expand: true,
        });
        toolbar.add_child(row);

        const dragArea = new St.Widget({
            style_class: 'widget-edit-mode-drag-handle',
            layout_manager: new Clutter.BinLayout(),
            reactive: true, // only ever actually hit-tested while `toolbar` is visible (EDIT/DRAGGING)
            x_expand: true,
            y_expand: true,
        });
        const grip = new St.Label({
            style_class: 'widget-edit-mode-grip',
            text: '\u2637', // ⠿ - purely decorative, non-reactive, sits on top of dragArea
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        dragArea.add_child(grip);

        // Icon-only (no visible text label) so a row of buttons fits
        // inside even a small widget's width without wrapping/clipping.
        // `accessible_name` is set explicitly on every button below so
        // screen readers still get the full label even though nothing
        // visible spells it out.
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
                // Guard (carried forward from the old flip design's
                // 2026-07-21 fix, "Reset mid-exit permanently freezes the
                // widget"): reject a click that arrives after the toolbar
                // has already started hiding, same as dragArea's press
                // handler already does for drag-start. Cheap insurance —
                // this design's _hideToolbar() no longer has the dual
                // actor/rotation race that originally caused that bug,
                // but there's no reason to remove a guard this inexpensive.
                if (!this.isEditing(widgetId)) {
                    this._logger.debug('edit-mode',
                        `toolbar button clicked ("${widgetId}", label="${label}") ignored — not editing`);
                    return;
                }
                this._logger.debug('edit-mode', `toolbar button clicked ("${widgetId}", label="${label}")`);
                onClicked();
            });
            row.add_child(button);
            entry.tooltipCleanups.push(this._attachTooltip(button, toolbar, row, label));
        };

        addButton('preferences-system-symbolic', 'Settings',
            'widget-edit-mode-action-settings', () => this._onSettings(widgetId));

        addButton('view-refresh-symbolic', 'Reset', 'widget-edit-mode-action-reset', () => {
            this._storage?.resetWidgetSettings(widgetId);
            this._storage?.removeWidgetLayoutEntry(widgetId);
            // 2026-07-20 fix ("click reset doesn't reload the widget"):
            // `_onReset` (extension.js) rebuilds the widget's instance/
            // actor from scratch, the same way task 08's hot-reload does,
            // and re-places it at its now-defaulted position — so Reset
            // takes effect immediately. That callback is responsible for
            // exiting Edit Mode itself, so this handler does NOT also
            // call _exitEdit().
            this._onReset(widgetId);
        });

        addButton('window-close-symbolic', 'Remove',
            'widget-edit-mode-action-remove', () => this._onRemove(widgetId));

        if (this._onUninstall && entry.isUserInstalled) {
            addButton('user-trash-symbolic', 'Uninstall', 'widget-edit-mode-action-uninstall',
                () => this._onUninstall(widgetId, entry.isUserInstalled));
        }

        // Drag area added AFTER the buttons in the BoxLayout so it fills
        // whatever width the row's expansion leaves once the buttons
        // have taken their own natural width — but added BELOW the
        // buttons in z-order doesn't matter here since it's a sibling in
        // the same BoxLayout row, not stacked underneath it; each
        // button's own reactive St.Button consumes its own press before
        // it could ever reach dragArea regardless of paint order.
        row.add_child(dragArea);

        // Right-click anywhere on the toolbar bar (including over
        // dragArea, or over a button - St.Button only ever consumes
        // PRIMARY presses for its own click handling) exits Edit Mode.
        // This is the toolbar's equivalent of the old flip design's
        // `back` actor having the same listener, for the same reason:
        // the front actor is `reactive = false` for as long as EDIT is
        // active, so nothing else is left listening for the right-click
        // that's supposed to close it.
        toolbar.connect('button-press-event', (_actor, event) => {
            this._logger.debug('edit-mode',
                `toolbar button-press("${widgetId}") button=${event.get_button()} state=${this.getState(widgetId)}`);
            if (event.get_button() !== Clutter.BUTTON_SECONDARY)
                return Clutter.EVENT_PROPAGATE;

            this.toggle(widgetId);
            return Clutter.EVENT_STOP;
        });

        // Placed as a SIBLING of the front actor (same parent), pinned to
        // its top-left corner so it overlaps the widget's own top edge
        // rather than sitting above/pushing it down — footprint stays
        // exactly the widget's own width/height, per spec.
        const parent = entry.actor.get_parent();
        parent?.insert_child_above(toolbar, entry.actor);
        toolbar.set_position(entry.actor.get_x(), entry.actor.get_y());

        // Theme system (2026-07-21): style the toolbar's background/drop
        // shadow from theme.json's GLOBAL appearance settings, if a
        // ThemeService was supplied — additive with `set_style()`, so
        // `.widget-edit-mode-toolbar-bar`'s own stylesheet.css rules
        // still apply for anything the theme config doesn't set.
        this._theme?.applyGlobalStyle(toolbar);

        // Let EditModeDragController (task 13) arm the dedicated drag
        // area for dragging — see the constructor's onBackActorReady doc
        // comment. `dragArea` (not `toolbar` as a whole) is deliberately
        // the only thing ever handed a button-press listener for drag
        // purposes.
        this._onBackActorReady(widgetId, toolbar, dragArea);

        return toolbar;
    }

    /**
     * @private builds hover-tooltip behavior for a single toolbar button.
     * Returns `{destroy()}` so the caller (entry.tooltipCleanups,
     * consumed by detach()) can tear it down along with everything else
     * for that widget.
     * @param {St.Button} button
     * @param {St.Widget} toolbar - the plain (non-layout-managed) outer
     *   toolbar actor the tooltip label is parented into, so it floats
     *   above the icon row instead of becoming a real extra column in it
     *   (see _buildToolbar()'s doc comment).
     * @param {St.BoxLayout} row - the actor `button` is actually a child
     *   of, needed to translate `button`'s position (relative to `row`)
     *   into a position relative to `toolbar`.
     * @param {string} text
     */
    _attachTooltip(button, toolbar, row, text) {
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
                toolbar.insert_child_above(tooltipLabel, row);

                const [rowX, rowY] = row.get_position();
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
        const clickedId = button.connect('clicked', hide);

        return {
            destroy() {
                hide();
                try {
                    button.disconnect(enterId);
                    button.disconnect(leaveId);
                    button.disconnect(clickedId);
                } catch (e) {
                    // button may already be destroyed by the caller
                    // (toolbar teardown in detach()) - same defensive
                    // pattern used elsewhere in this file.
                }
            },
        };
    }

    /**
     * @method reapplyTheme
     * @description Re-styles every widget's already-built toolbar bar
     * from the current global theme — call after `ThemeService.reload()`
     * picks up an external `theme.json` change (see themeService.js's
     * `watch()`) so an already-shown (or previously-shown-then-hidden)
     * toolbar reflects the new appearance without needing another
     * right-click. Widgets whose toolbar was never built yet (never
     * right-clicked this session) need nothing here — `_buildToolbar()`
     * reads the current theme fresh the first time it runs.
     */
    reapplyTheme() {
        if (!this._theme)
            return;
        for (const entry of this._widgets.values()) {
            if (entry.toolbar)
                this._theme.applyGlobalStyle(entry.toolbar);
        }
    }

    /** @private only transitions HOVER<->NORMAL, never touches EDIT or
     * DRAGGING - a pointer leaving the actor while its toolbar is showing
     * (e.g. moving to click a toolbar button, which is a different actor)
     * must not silently drop out of Edit Mode. */
    _setState(widgetId, next, {ifCurrently}) {
        const entry = this._widgets.get(widgetId);
        if (!entry || entry.state !== ifCurrently)
            return;
        entry.state = next;
    }

    /**
     * @method detach
     * @description Disconnects all signals and destroys the toolbar
     * actor for a single widget - call right before
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

        entry.toolbar?.destroy();
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
