// widgets/power-menu-bar/widget.js
//
// A wide `barx2` card (23x5 grid cells = 368x80px): the same four
// icon-only buttons as widgets/power-menu (Suspend, Restart, Power Off,
// Log Out) - just laid out in a single evenly-spaced ROW instead of a
// 2x2 grid, to suit the short/wide bar shape. No text labels - each
// button shows a hover tooltip instead, identical pattern to
// widgets/power-menu's own _attachTooltip().
//
// Root actor (this._actor) is a plain St.Widget with Clutter.FixedLayout,
// holding a single St.Bin child (this._content) that does the actual
// centering/painting - lib/blockSizeManager.js's applyBlockSize()
// force-sets the root actor to an exact cols*16 x rows*16px size from
// metadata.json's block-type (23x5 cells = 368x80px) regardless of
// anything set here, so this._content is bound to that size via a
// Clutter.BindConstraint rather than a hardcoded pixel size - same fix
// as widgets/power-menu and widgets/settings-control.
//
// The four buttons sit in equal-width cells across the row (an St.Bin
// per button, x_expand: true, button centered inside), so they stay
// evenly spread across the full bar width rather than clumped - same
// "evenly spaced toolbar" look as a dock, and it degrades gracefully if
// this bar is ever placed at any of the other 3 bar widths (barx1/3/4).
//
// Actions go through the same two system services GNOME Shell's own
// system menu uses, so behavior (confirmation dialogs, inhibitors, etc.)
// matches what the user already expects from those buttons elsewhere:
//   - Suspend            -> org.freedesktop.login1.Manager (system bus)
//   - Restart/Shutdown/
//     Log Out            -> org.gnome.SessionManager (session bus)
//
// Both proxies are created defensively - if either bus name isn't
// present (e.g. non-GNOME session, sandboxed test environment) the
// corresponding buttons simply log an error on click instead of
// throwing, and buildActor() itself never touches DBus at all.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss} from '../../lib/widgetVisualKit.js';

const TOOLTIP_SHOW_DELAY_MS = 400;
const ICON_SIZE = 22;
const BUTTON_SIZE = 60;
const PADDING_X = 18;
const PADDING_Y = 10;

export default class PowerMenuBarWidget {
    /**
     * @param {WidgetAPI} api - see WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._tooltips = [];
        this._icons = [];
        this._sessionProxy = null;
        this._login1Proxy = null;
    }

    // Must never throw, and must not depend on enable() having run yet
    // (DBus proxies are created in enable(); a click before that simply
    // no-ops via the `?.` guards in the *_call* helpers below).
    buildActor() {
        const iconColor = this._settings?.iconColor ?? '#2e2e2e';

        // Plain (non-layout-managed-by-parent) root so tooltip labels can
        // be positioned as free-floating overlay children - same pattern
        // as widgets/power-menu/widget.js.
        this._actor = new St.Widget({
            style_class: 'power-menu-bar-widget-root',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
        });

        this._content = new St.Bin({
            style_class: 'power-menu-bar-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._content.add_constraint(new Clutter.BindConstraint({
            source: this._actor,
            coordinate: Clutter.BindCoordinate.SIZE,
        }));
        this._actor.add_child(this._content);
        // FixedLayout otherwise allocates this child at its natural width,
        // which prevents the expanding cells below from spreading the icons
        // across the bar. Keep the painted card and row at the root's full
        // block allocation instead.
        const syncContentSize = () => {
            this._content.set_position(0, 0);
            this._content.set_size(this._actor.width, this._actor.height);
        };
        this._actor.connect('notify::width', syncContentSize);
        this._actor.connect('notify::height', syncContentSize);
        syncContentSize();
        this._content.set_style(
            _cardStyleCss(this._settings, {backgroundColorFallback: '#ffffffd9', cornerRadiusFallback: 18}) +
            `padding: ${PADDING_Y}px ${PADDING_X}px;`
        );

        this._row = new St.BoxLayout({
            style_class: 'power-menu-bar-widget-row',
            vertical: false,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_child(this._row);

        const actions = [
            // 'system-suspend-symbolic' isn't part of the GNOME48 Adwaita
            // icon set (see https://github.com/StorageB/icons/blob/main/GNOME48Adwaita/icons.md,
            // 'actions' section) - media-playback-pause-symbolic is the
            // closest available stand-in and is what this widget uses.
            {icon: 'media-playback-pause-symbolic', tooltip: 'Suspend', onClicked: () => this._suspend()},
            {icon: 'system-reboot-symbolic', tooltip: 'Restart', onClicked: () => this._restart()},
            {icon: 'system-shutdown-symbolic', tooltip: 'Power Off', onClicked: () => this._shutdown()},
            {icon: 'system-log-out-symbolic', tooltip: 'Log Out', onClicked: () => this._logout()},
        ];

        actions.forEach(({icon, tooltip, onClicked}) => {
            const button = this._makeButton(icon, iconColor, onClicked);
            // Equal-width cell per button so all four stay evenly spread
            // across the bar's full width instead of clumped together.
            const cell = new St.Bin({
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                child: button,
            });
            this._row.add_child(cell);
            this._tooltips.push(this._attachTooltip(button, tooltip));
        });

        return this._actor;
    }

    // DBus proxies are created here (not in buildActor()) so a widget
    // instance that's built but never enabled (shouldn't normally happen,
    // but buildActor() must stay side-effect-free per the widget.js
    // contract) never opens a bus connection.
    enable() {
        try {
            this._sessionProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                'org.gnome.SessionManager', '/org/gnome/SessionManager',
                'org.gnome.SessionManager', null);
        } catch (e) {
            this._api.logger.error(`power-menu-bar: could not reach org.gnome.SessionManager: ${e.message}`);
        }

        try {
            this._login1Proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', null);
        } catch (e) {
            this._api.logger.error(`power-menu-bar: could not reach org.freedesktop.login1: ${e.message}`);
        }
    }

    // NOTE: this does NOT disconnect the tooltips' enter/leave/clicked
    // handlers - those are wired once in buildActor() onto buttons that
    // live for the whole widget instance, same convention as
    // widgets/power-menu/widget.js's identical disable(). buildActor()
    // only ever runs once, so anything disconnected here would never be
    // reconnected on the next enable() of a disable()/enable() cycle
    // (e.g. screen lock/unlock). What disable() *does* own: the DBus
    // proxies (real external resources opened by enable()) and any
    // tooltip currently mid-flight.
    disable() {
        for (const tooltip of this._tooltips)
            tooltip.hide();
        this._sessionProxy = null;
        this._login1Proxy = null;
    }

    getDefaultSettings() {
        return {
            backgroundColor: '#ffffffd9', // white @ 0.85 alpha ("d9")
            cornerRadius: 18,
            iconColor: '#2e2e2e',
            ...SHADOW_DEFAULTS,
        };
    }

    // Card background/corner-radius and the four icons' color are all set
    // once in buildActor() and never re-read on a timer, so without this
    // a Control Center edit wouldn't show up until the widget reloads.
    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        this._content.set_style(
            _cardStyleCss(settings, {backgroundColorFallback: '#ffffffd9', cornerRadiusFallback: 18}) +
            `padding: ${PADDING_Y}px ${PADDING_X}px;`
        );

        const iconColor = settings?.iconColor ?? '#2e2e2e';
        for (const icon of this._icons)
            icon.set_style(`color: ${iconColor};`);
    }

    /** @private */
    _makeButton(iconName, iconColor, onClicked) {
        const icon = new St.Icon({icon_name: iconName, icon_size: ICON_SIZE});
        icon.set_style(`color: ${iconColor};`);
        this._icons.push(icon);

        const button = new St.Button({
            style_class: 'power-menu-bar-widget-button',
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.set_size(BUTTON_SIZE, BUTTON_SIZE);
        // Fully round: radius = half the button's own size, so this stays
        // circular even if BUTTON_SIZE is ever changed, rather than a
        // fixed px value that would only look right at one specific size.
        button.set_style(
            `background-color: rgba(255, 255, 255, 0.08); border-radius: ${BUTTON_SIZE / 2}px;`
        );
        button.connect('clicked', onClicked);
        return button;
    }

    /**
     * @private hover-tooltip for a single row button - no text label is
     * ever shown on the button itself, only on hover, per the design
     * spec widgets/power-menu was built to (reused here). Position is
     * computed via get_transformed_position() (absolute/stage
     * coordinates) rather than summing each ancestor's own get_position()
     * - robust regardless of how many containers (row -> per-button cell
     * -> button) sit between the button and this._content, unlike a
     * manual parent-offset sum that breaks if a level of nesting changes.
     * Returns `{hide(), destroy()}` - disable() only ever calls `hide()`,
     * see its comment above.
     * @param {St.Button} button
     * @param {string} text
     */
    _attachTooltip(button, text) {
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
                    style_class: 'power-menu-bar-widget-tooltip',
                    text,
                });
                tooltipLabel.set_style(
                    'background-color: rgba(20, 20, 20, 0.95); color: #fff; ' +
                    'font-size: 12px; padding: 4px 8px; border-radius: 6px;'
                );
                // this._content is tooltipLabel's true parent-to-be - it's
                // also the direct parent of this._row, so this stays valid
                // however many per-button wrapper levels sit in between.
                this._content.insert_child_above(tooltipLabel, this._row);

                const [buttonAbsX, buttonAbsY] = button.get_transformed_position();
                const [contentAbsX, contentAbsY] = this._content.get_transformed_position();
                const buttonX = buttonAbsX - contentAbsX;
                const buttonY = buttonAbsY - contentAbsY;

                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                const [cardWidth, cardHeight] = this._actor.get_size();

                // Prefer just above the button, but the widget layer clips
                // each widget to its own allocated card - anything
                // positioned outside [0, cardWidth] x [0, cardHeight] is
                // simply invisible rather than floating over neighboring
                // widgets, so both axes are clamped to stay fully on-card.
                const idealX = buttonX + (button.width - labelWidth) / 2;
                const idealY = buttonY - labelHeight - 6;
                tooltipLabel.set_position(
                    Math.max(0, Math.min(idealX, cardWidth - labelWidth)),
                    Math.max(0, Math.min(idealY, cardHeight - labelHeight))
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
            // Called from disable() - cancels any pending show timeout and
            // destroys an already-visible label, without touching the
            // signal connections themselves (see disable()'s comment).
            hide,
            // Not currently called anywhere (the widget's buttons live for
            // the whole instance), but kept for symmetry/completeness in
            // case a future change needs to fully tear a button down.
            destroy() {
                hide();
                try {
                    button.disconnect(enterId);
                    button.disconnect(leaveId);
                    button.disconnect(clickedId);
                } catch (e) {
                    // button may already be destroyed by the caller's own
                    // teardown - same defensive pattern as widgetEditMode.js.
                }
            },
        };
    }

    /** @private */
    _suspend() {
        this._callLogin1('Suspend', new GLib.Variant('(b)', [true]));
    }

    /** @private */
    _restart() {
        this._callSession('Reboot', null);
    }

    /** @private */
    _shutdown() {
        this._callSession('Shutdown', null);
    }

    /** @private */
    _logout() {
        // mode 0 = "normal": gnome-session shows its own confirmation
        // dialog, same as the system menu's own Log Out entry.
        this._callSession('Logout', new GLib.Variant('(u)', [0]));
    }

    /** @private */
    _callSession(method, params) {
        if (!this._sessionProxy) {
            this._api.logger.error(`power-menu-bar: ${method} requested but SessionManager is unavailable`);
            return;
        }
        this._call(this._sessionProxy, method, params);
    }

    /** @private */
    _callLogin1(method, params) {
        if (!this._login1Proxy) {
            this._api.logger.error(`power-menu-bar: ${method} requested but login1 is unavailable`);
            return;
        }
        this._call(this._login1Proxy, method, params);
    }

    /** @private */
    _call(proxy, method, params) {
        try {
            proxy.call(method, params, Gio.DBusCallFlags.NONE, -1, null, (source, res) => {
                try {
                    source.call_finish(res);
                } catch (e) {
                    this._api.logger.error(`power-menu-bar: ${method} failed: ${e.message}`);
                }
            });
        } catch (e) {
            this._api.logger.error(`power-menu-bar: ${method} failed: ${e.message}`);
        }
    }
}
