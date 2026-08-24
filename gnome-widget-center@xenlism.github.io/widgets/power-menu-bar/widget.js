// widgets/power-menu-bar/widget.js
//
// A wide `barx2` card (23x5 grid cells = 368x80px): the same four
// icon-only buttons as widgets/power-menu (Suspend, Restart, Power Off,
// Log Out) - just laid out in a single evenly-spaced ROW instead of a
// 2x2 grid, to suit the short/wide bar shape. No text labels - each
// button shows a hover tooltip instead, via lib/widgetTooltip.js's
// attachTooltip().
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
// The four buttons sit directly in the row with a fixed BUTTON_SPACING
// gap between them (same px value as widgets/power-menu's GRID_SPACING),
// so this row reads as identically spaced to that widget's grid. The
// row is left at its natural (unexpanded) width and centered by
// this._content, so the gap stays fixed rather than stretching out if
// this bar is ever placed at one of the other 3 bar widths (barx1/3/4).
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
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS,} from '../../lib/widgetVisualKit.js';
import {createLayeredCard} from '../../lib/cardLayers.js';
import {attachTooltip} from '../../lib/widgetTooltip.js';
import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

const TOOLTIP_SHOW_DELAY_MS = 400;
const ICON_SIZE = 24;
const BUTTON_SIZE = 60;
const PADDING = 0;
// Same fixed gap as widgets/power-menu's GRID_SPACING, so the row (this
// bar) and the grid (widgets/power-menu) read as the same spacing
// whether the four buttons end up arranged horizontally or vertically.
const BUTTON_SPACING = 24;

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

        this._layers = createLayeredCard({
            contentStyleClass: 'power-menu-bar-widget-root',
            withTooltipLayer: true,
        });
        this._actor = this._layers.root;
        this._actor.reactive = true;

        this._layers.card.set_style(
            _cardStyleCss(this._settings, {backgroundColorFallback: '#070000a5', cornerRadiusFallback: 18})
        );

        // this._content is a plain wrapper - padding lives here, never the
        // Content Layer itself (Rule 5).
        this._content = new St.Bin({
            style_class: 'power-menu-bar-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_style(`padding: ${PADDING}px;`);
        this._layers.content.add_child(this._content);

        // NOTE: this._content (above) aligns CENTER rather than FILL, so
        // it always shrink-wraps to this._row's natural size - x_expand
        // on the row (or on the per-button cells below) never actually
        // gets any slack space to distribute, no matter what's set here.
        // Spacing therefore has to be an explicit fixed gap (style:
        // "spacing"), not expand-to-fill - same BUTTON_SPACING value as
        // widgets/power-menu's GRID_SPACING, so the two widgets read as
        // identically spaced whether the four buttons end up arranged
        // in this row or in that grid.
        this._row = new St.BoxLayout({
            style_class: 'power-menu-bar-widget-row',
            style: `spacing: ${BUTTON_SPACING}px;`,
            vertical: false,
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
            this._row.add_child(button);
            this._tooltips.push(attachTooltip(button, this._layers, tooltip));
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
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
        };
    }

    // Card background/corner-radius and the four icons' color are all set
    // once in buildActor() and never re-read on a timer, so without this
    // a Control Center edit wouldn't show up until the widget reloads.
    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        this._layers.card.set_style(
            _cardStyleCss(settings, {backgroundColorFallback: '#070000a5', cornerRadiusFallback: 18})
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
