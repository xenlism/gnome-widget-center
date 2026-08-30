import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, cardStyleCss as _cardStyleCss, hexToRgba as _hexToRgba, BORDER_DEFAULTS, OPACITY_DEFAULTS, BLUR_DEFAULTS} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyLayeredCardStyle} from '../../lib/shell/cardLayers.js';
import {attachTooltip} from '../../lib/shell/widgetTooltip.js';
import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

const ICON_SIZE = 24;
const BUTTON_SIZE = 60;
const PADDING = 0;
const BUTTON_SPACING = 24;

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

const RFKILL_SCHEMA = 'org.gnome.settings-daemon.plugins.rfkill';

export default class SettingsControlBarWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._tooltips = [];

        this._networkIcon = null;
        this._bluetoothIcon = null;
        this._dndIcon = null;
        this._themeIcon = null;
        this._networkButton = null;
        this._bluetoothButton = null;
        this._dndButton = null;
        this._themeButton = null;

        this._iconOnColor = '#3584E4E6';
        this._iconOffColor = '#9A99961F';

        this._nmProxy = null;
        this._nmSignalId = null;
        this._btAdapterPath = null;
        this._btProxy = null;
        this._btSignalId = null;

        this._btMode = 'bluetooth';
        this._bluetoothTooltipText = 'Bluetooth';
        this._rfkillSettings = null;
        this._rfkillSignalId = null;

        this._notifSettings = null;
        this._notifSignalId = null;
        this._interfaceSettings = null;
        this._interfaceSignalId = null;
    }

    buildActor() {
        this._iconOnColor = this._settings?.iconOnColor ?? '#3584E4E6';
        this._iconOffColor = this._settings?.iconOffColor ?? '#9A99961F';

        this._layers = createLayeredCard({
            contentStyleClass: 'settings-control-bar-widget-root',
            withTooltipLayer: true,
        });
        this._actor = this._layers.root;
        this._actor.reactive = true;

        applyLayeredCardStyle(this._layers, this._settings, {backgroundColorFallback: '#070000a5', cornerRadiusFallback: 18});

        this._content = new St.Bin({
            style_class: 'settings-control-bar-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_style(`padding: ${PADDING}px;`);
        this._layers.content.add_child(this._content);

        this._row = new St.BoxLayout({
            style_class: 'settings-control-bar-widget-row',
            style: `spacing: ${BUTTON_SPACING}px;`,
            vertical: false,
        });
        this._content.set_child(this._row);

        const addButton = (icon, button, tooltip) => {
            this._row.add_child(button);
            this._tooltips.push(attachTooltip(button, this._layers, tooltip));
        };

        this._networkIcon = new St.Icon({icon_name: 'network-wireless-offline-symbolic', icon_size: ICON_SIZE});
        this._networkButton = this._makeButton(this._networkIcon, () => this._toggleNetwork());
        addButton(this._networkIcon, this._networkButton, 'Wi-Fi');

        this._bluetoothIcon = new St.Icon({icon_name: 'bluetooth-symbolic', icon_size: ICON_SIZE});
        this._bluetoothButton = this._makeButton(this._bluetoothIcon, () => this._toggleBluetooth());
        addButton(this._bluetoothIcon, this._bluetoothButton, () => this._bluetoothTooltipText);

        this._dndIcon = new St.Icon({icon_name: 'notifications-disabled-symbolic', icon_size: ICON_SIZE});
        this._dndButton = this._makeButton(this._dndIcon, () => this._toggleDnd());
        addButton(this._dndIcon, this._dndButton, 'Do Not Disturb');

        this._themeIcon = new St.Icon({icon_name: 'night-light-symbolic', icon_size: ICON_SIZE});
        this._themeButton = this._makeButton(this._themeIcon, () => this._toggleTheme());
        addButton(this._themeIcon, this._themeButton, 'Dark Mode');

        this._setToggleState(this._networkIcon, this._networkButton, false);
        this._setToggleState(this._bluetoothIcon, this._bluetoothButton, false);
        this._setToggleState(this._dndIcon, this._dndButton, false);
        this._setToggleState(this._themeIcon, this._themeButton, false);

        return this._actor;
    }

    enable() {
        this._enableNetwork();
        this._enableBluetooth();
        this._enableDnd();
        this._enableTheme();
    }

    disable() {
        if (this._nmProxy && this._nmSignalId) {
            try {
                this._nmProxy.disconnect(this._nmSignalId);
            } catch (e) {
            }
        }
        this._nmProxy = null;
        this._nmSignalId = null;

        if (this._btProxy && this._btSignalId) {
            try {
                this._btProxy.disconnect(this._btSignalId);
            } catch (e) {
            }
        }
        this._btProxy = null;
        this._btSignalId = null;
        this._btAdapterPath = null;

        if (this._rfkillSettings && this._rfkillSignalId) {
            try {
                this._rfkillSettings.disconnect(this._rfkillSignalId);
            } catch (e) {
            }
        }
        this._rfkillSettings = null;
        this._rfkillSignalId = null;

        if (this._notifSettings && this._notifSignalId) {
            try {
                this._notifSettings.disconnect(this._notifSignalId);
            } catch (e) {
            }
        }
        this._notifSettings = null;
        this._notifSignalId = null;

        if (this._interfaceSettings && this._interfaceSignalId) {
            try {
                this._interfaceSettings.disconnect(this._interfaceSignalId);
            } catch (e) {
            }
        }
        this._interfaceSettings = null;
        this._interfaceSignalId = null;

        for (const tooltip of this._tooltips)
            tooltip.hide();
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

    onSettingsChanged(settings) {
        if (!this._actor)
            return;

        applyLayeredCardStyle(this._layers, settings, {backgroundColorFallback: '#070000a5', cornerRadiusFallback: 18});

        this._iconOnColor = settings?.iconOnColor ?? '#3584E4E6';
        this._iconOffColor = settings?.iconOffColor ?? '#9A99961F';

        this._renderNetwork();
        this._renderBluetooth();
        this._renderDnd();
        this._renderTheme();
    }

    _enableNetwork() {
        try {
            this._nmProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.NONE, null,
                'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
                'org.freedesktop.NetworkManager', null);
            this._nmSignalId = this._nmProxy.connect('g-properties-changed', () => this._renderNetwork());
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach NetworkManager: ${e.message}`);
            this._nmProxy = null;
        }
        this._renderNetwork();
    }

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

        this._setToggleState(this._networkIcon, this._networkButton, enabled);
    }

    _toggleNetwork() {
        if (!this._nmProxy) {
            this._api.logger.error('settings-control-bar: Wi-Fi toggle requested but NetworkManager is unavailable');
            return;
        }
        const enabled = this._nmProxy.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', GLib.Variant.new_boolean(!enabled)
        );
    }

    _enableBluetooth() {
        // Check whether BlueZ is actually running before touching it at all.
        // Gio.DBusProxyFlags.NONE (the old code) lets GDBus try to activate
        // org.bluez on the system bus when it isn't already up, and on a lot
        // of systems there's no bluetoothd unit to activate, so that attempt
        // fails loudly (NameHasNoOwner) and gets logged as an error even
        // though "no Bluetooth here" is an entirely normal, expected case —
        // the widget already has a fallback (Airplane Mode) for exactly this.
        if (!this._hasSystemService('org.bluez')) {
            this._api.logger.info('settings-control-bar: BlueZ is not running, switching this button to Airplane Mode');
            this._btAdapterPath = null;
            this._enableAirplaneModeFallback();
            this._renderBluetooth();
            return;
        }

        try {
            const objectManager = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
                'org.bluez', '/', 'org.freedesktop.DBus.ObjectManager', null);
            const [managedObjects] = objectManager.call_sync(
                'GetManagedObjects', null, Gio.DBusCallFlags.NO_AUTO_START, -1, null
            ).deep_unpack();

            this._btAdapterPath = Object.keys(managedObjects)
                .find(path => 'org.bluez.Adapter1' in managedObjects[path]) ?? null;
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach BlueZ: ${e.message}`);
            this._btAdapterPath = null;
        }

        if (this._btAdapterPath) {
            try {
                this._btProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
                    'org.bluez', this._btAdapterPath, 'org.bluez.Adapter1', null);
                this._btSignalId = this._btProxy.connect('g-properties-changed', () => this._renderBluetooth());
                this._btMode = 'bluetooth';
                this._bluetoothTooltipText = 'Bluetooth';
            } catch (e) {
                this._api.logger.error(`settings-control-bar: could not reach BlueZ adapter: ${e.message}`);
                this._btProxy = null;
                this._btAdapterPath = null;
            }
        }

        if (!this._btAdapterPath) {
            this._api.logger.info('settings-control-bar: no Bluetooth adapter found, switching this button to Airplane Mode');
            this._enableAirplaneModeFallback();
        }

        this._renderBluetooth();
    }

    // Sync NameHasOwner check on the system bus, with NO_AUTO_START so this
    // itself never triggers the activation attempt we're trying to avoid.
    // Same idea as the getBluetoothDevices() helper, just the call_sync
    // shape since the rest of this file (enable/disable) is synchronous.
    _hasSystemService(name) {
        try {
            const result = Gio.DBus.system.call_sync(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'NameHasOwner', new GLib.Variant('(s)', [name]), new GLib.VariantType('(b)'),
                Gio.DBusCallFlags.NO_AUTO_START, -1, null
            );
            return result.deepUnpack()[0];
        } catch (e) {
            return false;
        }
    }

    _enableAirplaneModeFallback() {
        this._btMode = 'airplane';
        this._bluetoothTooltipText = 'Airplane Mode';

        // Look the schema up first instead of relying on the Gio.Settings
        // constructor to throw — a missing rfkill schema (e.g. a distro not
        // running gnome-settings-daemon) is just "this fallback isn't
        // available either", not an error worth alarming anyone with.
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(RFKILL_SCHEMA, true);
        if (!schema) {
            this._api.logger.info(`settings-control-bar: ${RFKILL_SCHEMA} schema not found, Airplane Mode fallback unavailable`);
            this._rfkillSettings = null;
            return;
        }

        try {
            this._rfkillSettings = new Gio.Settings({settings_schema: schema});
            this._rfkillSignalId = this._rfkillSettings.connect('changed::airplane-mode', () => this._renderBluetooth());
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach ${RFKILL_SCHEMA}: ${e.message}`);
            this._rfkillSettings = null;
        }
    }

    _renderBluetooth() {
        if (!this._bluetoothIcon)
            return;

        if (this._btMode === 'airplane') {
            this._bluetoothIcon.icon_name = 'airplane-mode-symbolic';
            const airplaneOn = this._rfkillSettings?.get_boolean('airplane-mode') ?? false;
            this._setToggleState(this._bluetoothIcon, this._bluetoothButton, airplaneOn);
            return;
        }

        this._bluetoothIcon.icon_name = 'bluetooth-symbolic';
        const powered = this._btProxy?.get_cached_property('Powered')?.unpack() ?? false;
        this._setToggleState(this._bluetoothIcon, this._bluetoothButton, powered);
    }

    _toggleBluetooth() {
        if (this._btMode === 'airplane') {
            if (!this._rfkillSettings) {
                this._api.logger.error('settings-control-bar: Airplane Mode toggle requested but rfkill is unavailable');
                return;
            }
            try {
                const airplaneOn = this._rfkillSettings.get_boolean('airplane-mode');
                this._rfkillSettings.set_boolean('airplane-mode', !airplaneOn);
            } catch (e) {
                this._api.logger.error(`settings-control-bar: Airplane Mode toggle failed: ${e.message}`);
            }
            return;
        }

        if (!this._btProxy || !this._btAdapterPath) {
            this._api.logger.error('settings-control-bar: Bluetooth toggle requested but no adapter is available');
            return;
        }
        const powered = this._btProxy.get_cached_property('Powered')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.bluez', this._btAdapterPath,
            'org.bluez.Adapter1', 'Powered', GLib.Variant.new_boolean(!powered)
        );
    }

    _enableDnd() {
        try {
            this._notifSettings = new Gio.Settings({schema_id: NOTIFICATIONS_SCHEMA});
            this._notifSignalId = this._notifSettings.connect('changed::show-banners', () => this._renderDnd());
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach ${NOTIFICATIONS_SCHEMA}: ${e.message}`);
            this._notifSettings = null;
        }
        this._renderDnd();
    }

    _renderDnd() {
        if (!this._dndIcon)
            return;
        const dndOn = this._notifSettings ? !this._notifSettings.get_boolean('show-banners') : false;
        this._setToggleState(this._dndIcon, this._dndButton, dndOn);
    }

    _toggleDnd() {
        if (!this._notifSettings) {
            this._api.logger.error(`settings-control-bar: Do Not Disturb toggle requested but ${NOTIFICATIONS_SCHEMA} is unavailable`);
            return;
        }
        const showBanners = this._notifSettings.get_boolean('show-banners');
        this._notifSettings.set_boolean('show-banners', !showBanners);
    }

    _enableTheme() {
        try {
            this._interfaceSettings = new Gio.Settings({schema_id: INTERFACE_SCHEMA});
            this._interfaceSignalId = this._interfaceSettings.connect('changed::color-scheme', () => this._renderTheme());
        } catch (e) {
            this._api.logger.error(`settings-control-bar: could not reach ${INTERFACE_SCHEMA}: ${e.message}`);
            this._interfaceSettings = null;
        }
        this._renderTheme();
    }

    _renderTheme() {
        if (!this._themeIcon)
            return;
        const scheme = this._interfaceSettings?.get_string('color-scheme') ?? 'default';
        this._setToggleState(this._themeIcon, this._themeButton, scheme === 'prefer-dark');
    }

    _toggleTheme() {
        if (!this._interfaceSettings) {
            this._api.logger.error(`settings-control-bar: Dark Mode toggle requested but ${INTERFACE_SCHEMA} is unavailable`);
            return;
        }
        const scheme = this._interfaceSettings.get_string('color-scheme');
        this._interfaceSettings.set_string('color-scheme', scheme === 'prefer-dark' ? 'default' : 'prefer-dark');
    }

    _makeButton(icon, onClicked) {
        const button = new St.Button({
            style_class: 'settings-control-bar-widget-button',
            child: icon,
            reactive: true,
            can_focus: true,
            track_hover: true,
        });
        button.set_size(BUTTON_SIZE, BUTTON_SIZE);
        button.connect('clicked', onClicked);
        return button;
    }

    _setToggleState(icon, button, isOn) {
        icon.set_style('color: #ffffff;');

        const hex = isOn ? this._iconOnColor : this._iconOffColor;
        const {r, g, b, a} = _hexToRgba(hex);
        // Keep the old visual defaults for existing six-digit saved colors;
        // newly selected colors include their alpha channel and use it directly.
        const alpha = String(hex).replace('#', '').length >= 8 ? a : (isOn ? 0.9 : 0.12);
        button.set_style(`background-color: rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha}); border-radius: ${BUTTON_SIZE / 2}px;`);
    }

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
                        this._api.logger.error(`settings-control-bar: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            this._api.logger.error(`settings-control-bar: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
        }
    }
}
