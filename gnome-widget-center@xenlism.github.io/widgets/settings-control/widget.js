// widgets/settings-control/widget.js
//
// A compact 1x1 (160x160px) card with a 2x2 grid of icon-only TOGGLE
// buttons: Wi-Fi/Ethernet, Bluetooth, Do Not Disturb, Dark/Light mode.
// Same no-label-just-a-tooltip visual language as widgets/power-menu -
// see that widget's _attachTooltip() for the pattern reused here.
//
// Unlike power-menu's fire-and-forget actions, every button here reflects
// live system state (icon color swaps between the "on"/"off" settings
// colors) and stays in sync if the setting is changed some other way
// (GNOME Settings app, another instance of this widget, an external
// nmcli/bluetoothctl command, etc.) - each source below is subscribed to
// via signals, never polled, per WIDGET_API.md §9.1's must-follow rules:
//
//   - Wi-Fi/Ethernet -> org.freedesktop.NetworkManager (system bus).
//     Icon glyph switches between wifi/wired/offline based on
//     PrimaryConnectionType; the click toggles WirelessEnabled.
//   - Bluetooth       -> org.bluez (system bus). Adapter is discovered
//     once via the root ObjectManager; click toggles the adapter's own
//     Powered property.
//   - Do Not Disturb  -> GSettings org.gnome.desktop.notifications'
//     show-banners key (DND active means show-banners is false - this is
//     the same key GNOME's own Quick Settings "Do Not Disturb" toggle
//     uses).
//   - Dark/Light mode -> GSettings org.gnome.desktop.interface's
//     color-scheme key ('prefer-dark' vs 'default').
//
// All four are wrapped defensively: a missing bus name, missing adapter,
// or missing schema (non-GNOME session, sandboxed test environment,
// older GNOME without a given key) leaves that one button inert (off
// color, generic icon, logs on click) rather than throwing - buildActor()
// itself never touches DBus/GSettings at all, only enable() does.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss} from '../../lib/widgetVisualKit.js';

const TOOLTIP_SHOW_DELAY_MS = 400;
const ICON_SIZE = 22;
const BUTTON_SIZE = 60;
const GRID_SPACING = 8;
const PADDING = 12;
// 2 * BUTTON_SIZE + GRID_SPACING + 2 * PADDING = 160, matching the 1x1
// block-type's resolved 10x10-cell (16px/cell) footprint exactly - see
// metadata.json's block-type comment / WIDGET_API.md §2's size table.

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

export default class SettingsControlWidget {
    /**
     * @param {WidgetAPI} api - see WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._tooltips = [];

        // Re-colored on state change / onSettingsChanged - see _setIconState().
        this._networkIcon = null;
        this._bluetoothIcon = null;
        this._dndIcon = null;
        this._themeIcon = null;

        // Cached appearance settings, refreshed in buildActor()/onSettingsChanged().
        this._iconOnColor = '#3584e4';
        this._iconOffColor = '#9a9996';

        // External resources opened in enable(), torn down in disable().
        this._nmProxy = null;
        this._nmSignalId = null;
        this._btAdapterPath = null;
        this._btProxy = null;
        this._btSignalId = null;
        this._notifSettings = null;
        this._notifSignalId = null;
        this._interfaceSettings = null;
        this._interfaceSignalId = null;
    }

    // Must never throw. Builds the 2x2 grid with placeholder (off-color,
    // generic) icons - enable() fills in real state right after this
    // actor is placed in the Widget Layer.
    buildActor() {
        const backgroundColor = this._settings?.backgroundColor ?? '#ffffffd9';
        const cornerRadius = this._settings?.cornerRadius ?? 18;
        this._iconOnColor = this._settings?.iconOnColor ?? '#3584e4';
        this._iconOffColor = this._settings?.iconOffColor ?? '#9a9996';

        // Plain (non-layout-managed-by-parent) root so tooltip labels can
        // be positioned as free-floating overlay children - same pattern
        // as widgets/power-menu/widget.js.
        this._actor = new St.Widget({
            style_class: 'settings-control-widget-root',
            layout_manager: new Clutter.FixedLayout(),
            reactive: true,
        });
        this._actor.set_size(
            2 * BUTTON_SIZE + GRID_SPACING + 2 * PADDING,
            2 * BUTTON_SIZE + GRID_SPACING + 2 * PADDING
        );
        this._actor.set_style(this._cardStyle(backgroundColor, cornerRadius));

        this._grid = new St.Widget({
            style_class: 'settings-control-widget-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: GRID_SPACING,
                row_spacing: GRID_SPACING,
            }),
        });
        this._grid.set_position(PADDING, PADDING);
        this._actor.add_child(this._grid);

        const layout = this._grid.layout_manager;

        this._networkIcon = new St.Icon({icon_name: 'network-wireless-offline-symbolic', icon_size: ICON_SIZE});
        const networkButton = this._makeButton(this._networkIcon, () => this._toggleNetwork());
        layout.attach(networkButton, 0, 0, 1, 1);
        this._tooltips.push(this._attachTooltip(networkButton, 'Wi-Fi'));

        this._bluetoothIcon = new St.Icon({icon_name: 'bluetooth-symbolic', icon_size: ICON_SIZE});
        const bluetoothButton = this._makeButton(this._bluetoothIcon, () => this._toggleBluetooth());
        layout.attach(bluetoothButton, 1, 0, 1, 1);
        this._tooltips.push(this._attachTooltip(bluetoothButton, 'Bluetooth'));

        this._dndIcon = new St.Icon({icon_name: 'notifications-disabled-symbolic', icon_size: ICON_SIZE});
        const dndButton = this._makeButton(this._dndIcon, () => this._toggleDnd());
        layout.attach(dndButton, 0, 1, 1, 1);
        this._tooltips.push(this._attachTooltip(dndButton, 'Do Not Disturb'));

        // 'weather-clear-night-symbolic' isn't part of the GNOME48 Adwaita
        // icon set (see https://github.com/StorageB/icons/blob/main/GNOME48Adwaita/icons.md,
        // no 'weather' category at all) - night-light-symbolic is the
        // closest available stand-in and is what this widget uses.
        this._themeIcon = new St.Icon({icon_name: 'night-light-symbolic', icon_size: ICON_SIZE});
        const themeButton = this._makeButton(this._themeIcon, () => this._toggleTheme());
        layout.attach(themeButton, 1, 1, 1, 1);
        this._tooltips.push(this._attachTooltip(themeButton, 'Dark Mode'));

        // Placeholder state (all "off") until enable() reads the real
        // thing - buildActor() itself must stay side-effect-free.
        this._setIconState(this._networkIcon, false);
        this._setIconState(this._bluetoothIcon, false);
        this._setIconState(this._dndIcon, false);
        this._setIconState(this._themeIcon, false);

        return this._actor;
    }

    enable() {
        this._enableNetwork();
        this._enableBluetooth();
        this._enableDnd();
        this._enableTheme();
    }

    // Undoes exactly what enable() started: every DBusProxy/GSettings
    // signal subscription. Unlike power-menu's hover-tooltip signals
    // (wired once in buildActor(), meant to live for the whole
    // instance), these four ARE real external subscriptions opened fresh
    // in enable(), so they're torn down here and re-subscribed on the
    // next enable() of a disable()/enable() cycle (e.g. screen lock).
    disable() {
        if (this._nmProxy && this._nmSignalId) {
            try {
                this._nmProxy.disconnect(this._nmSignalId);
            } catch (e) {
                // proxy may already be gone
            }
        }
        this._nmProxy = null;
        this._nmSignalId = null;

        if (this._btProxy && this._btSignalId) {
            try {
                this._btProxy.disconnect(this._btSignalId);
            } catch (e) {
                // proxy may already be gone
            }
        }
        this._btProxy = null;
        this._btSignalId = null;
        this._btAdapterPath = null;

        if (this._notifSettings && this._notifSignalId) {
            try {
                this._notifSettings.disconnect(this._notifSignalId);
            } catch (e) {
                // settings object may already be gone
            }
        }
        this._notifSettings = null;
        this._notifSignalId = null;

        if (this._interfaceSettings && this._interfaceSignalId) {
            try {
                this._interfaceSettings.disconnect(this._interfaceSignalId);
            } catch (e) {
                // settings object may already be gone
            }
        }
        this._interfaceSettings = null;
        this._interfaceSignalId = null;

        for (const tooltip of this._tooltips)
            tooltip.hide();
    }

    getDefaultSettings() {
        return {
            backgroundColor: '#ffffffd9', // white @ 0.85 alpha ("d9")
            iconOnColor: '#3584e4',
            iconOffColor: '#9a9996',
            cornerRadius: 18,
            ...SHADOW_DEFAULTS,
        };
    }

    // Card background/corner-radius and both icon colors are all applied
    // once in buildActor()/enable() and never re-read on a timer, so
    // without this a Control Center edit wouldn't show up until the
    // widget reloads.
    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        const backgroundColor = settings?.backgroundColor ?? '#ffffffd9';
        const cornerRadius = settings?.cornerRadius ?? 18;
        this._actor.set_style(this._cardStyle(backgroundColor, cornerRadius));

        this._iconOnColor = settings?.iconOnColor ?? '#3584e4';
        this._iconOffColor = settings?.iconOffColor ?? '#9a9996';

        // Re-apply each icon's color using its current (unchanged) on/off
        // state, now against the new color settings.
        this._renderNetwork();
        this._renderBluetooth();
        this._renderDnd();
        this._renderTheme();
    }

    // ---- Wi-Fi / Ethernet (org.freedesktop.NetworkManager) ----------------

    /** @private */
    _enableNetwork() {
        try {
            this._nmProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
                'org.freedesktop.NetworkManager', null);
            this._nmSignalId = this._nmProxy.connect('g-properties-changed', () => this._renderNetwork());
        } catch (e) {
            this._api.logger.error(`settings-control: could not reach NetworkManager: ${e.message}`);
            this._nmProxy = null;
        }
        this._renderNetwork();
    }

    /** @private */
    _renderNetwork() {
        if (!this._networkIcon)
            return;

        const enabled = this._nmProxy?.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        const connType = this._nmProxy?.get_cached_property('PrimaryConnectionType')?.unpack() ?? '';

        let iconName = 'network-wireless-offline-symbolic';
        if (connType.includes('ethernet'))
            iconName = 'network-wired-symbolic';
        else if (enabled)
            iconName = 'network-wireless-symbolic';
        this._networkIcon.icon_name = iconName;

        this._setIconState(this._networkIcon, enabled);
    }

    /** @private */
    _toggleNetwork() {
        if (!this._nmProxy) {
            this._api.logger.error('settings-control: Wi-Fi toggle requested but NetworkManager is unavailable');
            return;
        }
        const enabled = this._nmProxy.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', GLib.Variant.new_boolean(!enabled)
        );
    }

    // ---- Bluetooth (org.bluez) ---------------------------------------------

    /** @private */
    _enableBluetooth() {
        try {
            const objectManager = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', null);
            const [managedObjects] = objectManager.call_sync(
                'GetManagedObjects', null, Gio.DBusCallFlags.NONE, -1, null
            ).deep_unpack();

            this._btAdapterPath = Object.keys(managedObjects)
                .find(path => 'org.bluez.Adapter1' in managedObjects[path]) ?? null;

            if (this._btAdapterPath) {
                this._btProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                    'org.bluez', this._btAdapterPath, 'org.bluez.Adapter1', null);
                this._btSignalId = this._btProxy.connect('g-properties-changed', () => this._renderBluetooth());
            } else {
                this._api.logger.error('settings-control: no Bluetooth adapter found');
            }
        } catch (e) {
            this._api.logger.error(`settings-control: could not reach BlueZ: ${e.message}`);
            this._btProxy = null;
            this._btAdapterPath = null;
        }
        this._renderBluetooth();
    }

    /** @private */
    _renderBluetooth() {
        if (!this._bluetoothIcon)
            return;
        const powered = this._btProxy?.get_cached_property('Powered')?.unpack() ?? false;
        this._setIconState(this._bluetoothIcon, powered);
    }

    /** @private */
    _toggleBluetooth() {
        if (!this._btProxy || !this._btAdapterPath) {
            this._api.logger.error('settings-control: Bluetooth toggle requested but no adapter is available');
            return;
        }
        const powered = this._btProxy.get_cached_property('Powered')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.bluez', this._btAdapterPath,
            'org.bluez.Adapter1', 'Powered', GLib.Variant.new_boolean(!powered)
        );
    }

    // ---- Do Not Disturb (GSettings) ----------------------------------------

    /** @private */
    _enableDnd() {
        try {
            this._notifSettings = new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
            this._notifSignalId = this._notifSettings.connect('changed::show-banners', () => this._renderDnd());
        } catch (e) {
            this._api.logger.error(`settings-control: could not reach ${NOTIFICATIONS_SCHEMA}: ${e.message}`);
            this._notifSettings = null;
        }
        this._renderDnd();
    }

    /** @private */
    _renderDnd() {
        if (!this._dndIcon)
            return;
        // Do Not Disturb is "on" when banners are turned off - same
        // inverted relationship GNOME's own Quick Settings toggle uses.
        const dndOn = this._notifSettings ? !this._notifSettings.get_boolean('show-banners') : false;
        this._setIconState(this._dndIcon, dndOn);
    }

    /** @private */
    _toggleDnd() {
        if (!this._notifSettings) {
            this._api.logger.error(`settings-control: Do Not Disturb toggle requested but ${NOTIFICATIONS_SCHEMA} is unavailable`);
            return;
        }
        const showBanners = this._notifSettings.get_boolean('show-banners');
        this._notifSettings.set_boolean('show-banners', !showBanners);
    }

    // ---- Dark / Light mode (GSettings) -------------------------------------

    /** @private */
    _enableTheme() {
        try {
            this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
            this._interfaceSignalId = this._interfaceSettings.connect('changed::color-scheme', () => this._renderTheme());
        } catch (e) {
            this._api.logger.error(`settings-control: could not reach ${INTERFACE_SCHEMA}: ${e.message}`);
            this._interfaceSettings = null;
        }
        this._renderTheme();
    }

    /** @private */
    _renderTheme() {
        if (!this._themeIcon)
            return;
        const scheme = this._interfaceSettings?.get_string('color-scheme') ?? 'default';
        this._setIconState(this._themeIcon, scheme === 'prefer-dark');
    }

    /** @private */
    _toggleTheme() {
        if (!this._interfaceSettings) {
            this._api.logger.error(`settings-control: Dark Mode toggle requested but ${INTERFACE_SCHEMA} is unavailable`);
            return;
        }
        const scheme = this._interfaceSettings.get_string('color-scheme');
        this._interfaceSettings.set_string('color-scheme', scheme === 'prefer-dark' ? 'default' : 'prefer-dark');
    }

    // ---- Shared helpers -----------------------------------------------------

    /** @private */
    _makeButton(icon, onClicked) {
        const button = new St.Button({
            style_class: 'settings-control-widget-button',
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.set_size(BUTTON_SIZE, BUTTON_SIZE);
        button.set_style(
            `background-color: rgba(255, 255, 255, 0.08); border-radius: ${BUTTON_SIZE / 2}px;`
        );
        button.connect('clicked', onClicked);
        return button;
    }

    /** @private colors one button's icon according to its on/off state. */
    _setIconState(icon, isOn) {
        const color = isOn ? this._iconOnColor : this._iconOffColor;
        icon.set_style(`color: ${color};`);
    }

    /**
     * @private hover-tooltip for a single grid button - see
     * widgets/power-menu/widget.js's _attachTooltip() for the original
     * this was copied from (kept local since widget.js can't import
     * another widget's file, and lib/widgetEditMode.js's own version is
     * private to that module). disable() only ever calls the returned
     * hide() - see disable()'s comment for why the signal connections
     * themselves stay live across a disable()/enable() cycle.
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
                    style_class: 'settings-control-widget-tooltip',
                    text,
                });
                tooltipLabel.set_style(
                    'background-color: rgba(20, 20, 20, 0.95); color: #fff; ' +
                    'font-size: 12px; padding: 4px 8px; border-radius: 6px;'
                );
                this._actor.insert_child_above(tooltipLabel, this._grid);

                const [buttonX, buttonY] = button.get_position();
                const [, labelHeight] = tooltipLabel.get_preferred_height(-1);
                const [, labelWidth] = tooltipLabel.get_preferred_width(-1);
                const [gridX, gridY] = this._grid.get_position();
                const [cardWidth, cardHeight] = this._actor.get_size();

                // Prefer just above the button, but the widget layer clips
                // each widget to its own allocated card - anything
                // positioned outside [0, cardWidth] x [0, cardHeight] is
                // simply invisible rather than floating over neighboring
                // widgets, so both axes are clamped to stay fully on-card.
                const idealX = gridX + buttonX + (button.width - labelWidth) / 2;
                const idealY = gridY + buttonY - labelHeight - 6;
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
            hide,
            destroy() {
                hide();
                try {
                    button.disconnect(enterId);
                    button.disconnect(leaveId);
                    button.disconnect(clickedId);
                } catch (e) {
                    // button may already be destroyed by the caller's own teardown.
                }
            },
        };
    }

    /**
     * @private sets a single DBus property via org.freedesktop.DBus.Properties.Set
     * - used instead of relying on a proxy's own property setter since
     * neither proxy here was built with interface introspection info.
     */
    _setDBusProperty(busType, busName, objectPath, interfaceName, propertyName, variant) {
        try {
            const connection = busType === Gio.BusType.SYSTEM
                ? Gio.DBus.system
                : Gio.DBus.session;
            connection.call(
                busName, objectPath, 'org.freedesktop.DBus.Properties', 'Set',
                new GLib.Variant('(ssv)', [interfaceName, propertyName, variant]),
                null, Gio.DBusCallFlags.NONE, -1, null,
                (source, res) => {
                    try {
                        source.call_finish(res);
                    } catch (e) {
                        this._api.logger.error(`settings-control: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            this._api.logger.error(`settings-control: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
        }
    }

    /** @private builds the card's inline style string (see power-menu's identical helper for the hex-alpha rationale). */
    _cardStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = this._hexToRgba(hexColor);
        return `background-color: rgba(${r}, ${g}, ${b}, ${a}); border-radius: ${cornerRadius}px; ` +
            _shadowBoxShadowCss(this._settings);
    }

    /** @private "#rrggbb" / "#rrggbbaa" (or 3/4-digit shorthand) -> {r, g, b} 0-255 each, {a} 0-1. */
    _hexToRgba(hex) {
        let value = String(hex).replace('#', '');
        if (value.length === 3 || value.length === 4)
            value = [...value].map(c => c + c).join('');
        const rgbNum = parseInt(value.slice(0, 6), 16);
        if (Number.isNaN(rgbNum))
            return {r: 255, g: 255, b: 255, a: 0.85}; // falls back to the default #ffffffd9
        const alphaByte = value.length >= 8 ? parseInt(value.slice(6, 8), 16) : 255;
        const a = Number.isNaN(alphaByte) ? 1 : Math.round((alphaByte / 255) * 1000) / 1000;
        return {r: (rgbNum >> 16) & 255, g: (rgbNum >> 8) & 255, b: rgbNum & 255, a};
    }
}
