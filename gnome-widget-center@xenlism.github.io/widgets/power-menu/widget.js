// widgets/power-menu/widget.js
//
// A compact 1x1 card with a 2x2 grid of icon-only buttons: Suspend,
// Restart, Power Off, Log Out. No text labels - each button shows a
// hover tooltip instead, via lib/widgetTooltip.js's attachTooltip().
//
// Root actor (this._actor) is a plain St.Widget with Clutter.FixedLayout,
// holding a single St.Bin child (this._content) that does the actual
// centering/painting - lib/blockSizeManager.js's applyBlockSize()
// force-sets the root actor to an exact cols*16 x rows*16px size from
// metadata.json's block-type (currently 11x11 cells = 176x176px)
// regardless of anything set here, so this._content is bound to that
// size via a Clutter.BindConstraint rather than a hardcoded pixel size -
// same fix as widgets/folder-widget-2x2's root/content split and
// widgets/settings-control's identical fix. This keeps the card's
// background/corner-radius filling the FULL allocated block and the
// button grid centered inside it, even if block-type's cell size ever
// changes again.
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
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, borderCss as _borderCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, BLUR_DEFAULTS, applyCardOpacity, resolveCornerRadius} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyCardBlur} from '../../lib/cardLayers.js';
import {attachTooltip} from '../../lib/widgetTooltip.js';
import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

const TOOLTIP_SHOW_DELAY_MS = 400;
const ICON_SIZE = 24;
const BUTTON_SIZE = 60;
const GRID_SPACING = 8;
const PADDING = 8;

export default class PowerMenuWidget {
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
        const backgroundColor = this._settings?.backgroundColor ?? '#070000a5';
        const cornerRadius = resolveCornerRadius(this._settings);
        const iconColor = this._settings?.iconColor ?? '#2e2e2e';

        // Plain (non-layout-managed-by-parent) root so tooltip labels can
        // be positioned as free-floating overlay children, same reason
        // lib/widgetEditMode.js's toolbar uses Clutter.FixedLayout for its
        // own root - see that file's _buildToolbar() doc comment. Sizing
        // itself is left entirely to lib/blockSizeManager.js's
        // applyBlockSize() (called by the host right after buildActor()
        // returns) - this._content below is bound to whatever size that
        // ends up setting, rather than this widget assuming/hardcoding it.
        this._layers = createLayeredCard({
            contentStyleClass: 'power-menu-widget-root',
            withTooltipLayer: true,
        });
        this._actor = this._layers.root;
        this._actor.reactive = true;

        // Card background/corner-radius CSS (this widget's own _cardStyle()
        // helper, not the shared applyLayeredCardStyle) now targets the
        // dedicated Background Layer instead of a hand-rolled inner Bin.
        this._layers.card.set_style(this._cardStyle(backgroundColor, cornerRadius));
        applyCardOpacity(this._layers.card, this._settings);
        this._layers.cardBlur.set_style(this._cardBlurStyle(backgroundColor, cornerRadius));
        applyCardBlur(this._layers.cardBlur, this._settings);

        // this._content is a plain wrapper - padding lives here, never the
        // Content Layer itself (Rule 5).
        this._content = new St.Bin({
            style_class: 'power-menu-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_style(`padding: ${PADDING}px;`);
        this._layers.content.add_child(this._content);

        this._grid = new St.Widget({
            style_class: 'power-menu-widget-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: GRID_SPACING,
                row_spacing: GRID_SPACING,
            }),
        });
        this._content.set_child(this._grid);

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

        const layout = this._grid.layout_manager;
        actions.forEach(({icon, tooltip, onClicked}, i) => {
            const button = this._makeButton(icon, iconColor, onClicked);
            layout.attach(button, i % 2, Math.trunc(i / 2), 1, 1);
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
            this._api.logger.error(`power-menu: could not reach org.gnome.SessionManager: ${e.message}`);
        }

        try {
            this._login1Proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.login1', '/org/freedesktop/login1',
                'org.freedesktop.login1.Manager', null);
        } catch (e) {
            this._api.logger.error(`power-menu: could not reach org.freedesktop.login1: ${e.message}`);
        }
    }

    // NOTE: this does NOT disconnect the tooltips' enter/leave/clicked
    // handlers - those are wired once in buildActor() onto buttons that
    // live for the whole widget instance, exactly like each button's own
    // power-action 'clicked' handler above (same convention
    // widgets/media-player/widget.js uses for its transport buttons).
    // buildActor() only ever runs once, so anything disconnected here
    // would never be reconnected on the next enable() of a
    // disable()/enable() cycle (e.g. screen lock/unlock). What disable()
    // *does* own: the DBus proxies (real external resources opened by
    // enable()) and any tooltip currently mid-flight (a pending show
    // timeout or an already-visible label), so nothing lingers oddly
    // through a lock/unlock cycle.
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
            ...BLUR_DEFAULTS,
        };
    }

    // Card background/corner-radius and the four icons' color are all set
    // once in buildActor() and never re-read on a timer, so without this
    // a Control Center edit wouldn't show up until the widget reloads.
    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        const backgroundColor = settings?.backgroundColor ?? '#070000a5';
        const cornerRadius = resolveCornerRadius(settings);
        this._layers.card.set_style(this._cardStyle(backgroundColor, cornerRadius));
        applyCardOpacity(this._layers.card, settings);
        // Background Blur lives on the dedicated Blur Layer, not `card`
        // itself - see lib/cardLayers.js's createLayeredCard()/applyCardBlur().
        // This was previously never called here, so the "Enable background
        // blur" toggle in this widget's settings had no visible effect.
        this._layers.cardBlur.set_style(this._cardBlurStyle(backgroundColor, cornerRadius));
        applyCardBlur(this._layers.cardBlur, settings);

        const iconColor = settings?.iconColor ?? '#2e2e2e';
        for (const icon of this._icons)
            icon.set_style(`color: ${iconColor};`);
    }

    /**
     * @private builds the card's inline style string. Transparency comes
     * straight from the hex color itself - an 8-digit "#rrggbbaa" (what
     * the Control Center's alpha-enabled color picker saves, e.g.
     * "#FFFFFFAA") rather than a separate opacity setting - converted to
     * rgba() for the actual style string since that's the unambiguous
     * format St's CSS parser is already known to accept (see the tooltip
     * label's style above), rather than assuming St parses 8-digit hex
     * colors directly.
     */
    _cardStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = this._hexToRgba(hexColor);
        return `background-color: rgba(${r}, ${g}, ${b}, ${a}); border-radius: ${cornerRadius}px; ` +
            _borderCss(this._settings) +
            _shadowBoxShadowCss(this._settings);
    }

    /**
     * @private just the background-color + border-radius part of
     * _cardStyle(), for the Blur Layer - border/shadow stay on the
     * visible `card` layer only (see onSettingsChanged() above), or
     * they'd be drawn twice.
     */
    _cardBlurStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = this._hexToRgba(hexColor);
        return `background-color: rgba(${r}, ${g}, ${b}, ${a}); border-radius: ${cornerRadius}px;`;
    }

    /**
     * @private "#rrggbb" / "#rrggbbaa" (or the 3/4-digit shorthands) ->
     * {r, g, b} 0-255 each, {a} 0-1. A 6-digit (or 3-digit) hex with no
     * alpha pair is treated as fully opaque (a: 1).
     */
    _hexToRgba(hex) {
        let value = String(hex).replace('#', '');
        if (value.length === 3 || value.length === 4)
            value = [...value].map(c => c + c).join('');
        const rgbNum = parseInt(value.slice(0, 6), 16);
        if (Number.isNaN(rgbNum))
            return {r: 255, g: 255, b: 255, a: 0.85}; // falls back to the default #070000a5
        const alphaByte = value.length >= 8 ? parseInt(value.slice(6, 8), 16) : 255;
        const a = Number.isNaN(alphaByte) ? 1 : Math.round((alphaByte / 255) * 1000) / 1000;
        return {r: (rgbNum >> 16) & 255, g: (rgbNum >> 8) & 255, b: rgbNum & 255, a};
    }

    /** @private */
    _makeButton(iconName, iconColor, onClicked) {
        const icon = new St.Icon({icon_name: iconName, icon_size: ICON_SIZE});
        icon.set_style(`color: ${iconColor};`);
        this._icons.push(icon);

        const button = new St.Button({
            style_class: 'power-menu-widget-button',
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
            this._api.logger.error(`power-menu: ${method} requested but SessionManager is unavailable`);
            return;
        }
        this._call(this._sessionProxy, method, params);
    }

    /** @private */
    _callLogin1(method, params) {
        if (!this._login1Proxy) {
            this._api.logger.error(`power-menu: ${method} requested but login1 is unavailable`);
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
                    this._api.logger.error(`power-menu: ${method} failed: ${e.message}`);
                }
            });
        } catch (e) {
            this._api.logger.error(`power-menu: ${method} failed: ${e.message}`);
        }
    }
}
