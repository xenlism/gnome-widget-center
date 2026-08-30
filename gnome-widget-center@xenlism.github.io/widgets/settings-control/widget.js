import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, borderCss as _borderCss, BORDER_DEFAULTS, OPACITY_DEFAULTS, BLUR_DEFAULTS, applyCardOpacity, resolveCornerRadius} from '../../lib/widgetVisualKit.js';
import {createLayeredCard, applyCardBlur} from '../../lib/shell/cardLayers.js';
import {attachTooltip} from '../../lib/shell/widgetTooltip.js';
import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';

const ICON_SIZE = 24;
const BUTTON_SIZE = 60;
const GRID_SPACING = 8;
const PADDING = 0;

const NOTIFICATIONS_SCHEMA = 'org.gnome.desktop.notifications';
const INTERFACE_SCHEMA = 'org.gnome.desktop.interface';

export default class SettingsControlWidget {
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
        this._airplaneMode = false;
        this._dndButton = null;
        this._themeButton = null;

        this._iconOnColor = '#3584E4E6';
        this._iconOffColor = '#9A99961F';

        this._nmProxy = null;
        this._nmSignalId = null;
        this._btAdapterPath = null;
        this._btProxy = null;
        this._btSignalId = null;
        this._notifSettings = null;
        this._notifSignalId = null;
        this._interfaceSettings = null;
        this._interfaceSignalId = null;
        this._rfkillSettings = null;
        this._rfkillSignalId = null;
    }

    buildActor() {
        const backgroundColor = this._settings?.backgroundColor ?? '#070000a5';
        const cornerRadius = resolveCornerRadius(this._settings);
        this._iconOnColor = this._settings?.iconOnColor ?? '#3584E4E6';
        this._iconOffColor = this._settings?.iconOffColor ?? '#9A99961F';

        this._layers = createLayeredCard({
            contentStyleClass: 'settings-control-widget-root',
            withTooltipLayer: true,
        });
        this._actor = this._layers.root;
        this._actor.reactive = true;

        this._layers.card.set_style(this._cardStyle(backgroundColor, cornerRadius));
        applyCardOpacity(this._layers.card, this._settings);
        this._layers.cardBlur.set_style(this._cardBlurStyle(backgroundColor, cornerRadius));
        applyCardBlur(this._layers.cardBlur, this._settings);

        this._content = new St.Bin({
            style_class: 'settings-control-widget-content',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
            y_expand: true,
        });
        this._content.set_style(`padding: ${PADDING}px;`);
        this._layers.content.add_child(this._content);

        this._grid = new St.Widget({
            style_class: 'settings-control-widget-grid',
            layout_manager: new Clutter.GridLayout({
                column_spacing: GRID_SPACING,
                row_spacing: GRID_SPACING,
            }),
        });
        this._content.set_child(this._grid);

        const layout = this._grid.layout_manager;

        this._networkIcon = new St.Icon({icon_name: 'network-wireless-offline-symbolic', icon_size: ICON_SIZE});
        this._networkButton = this._makeButton(this._networkIcon, () => this._toggleNetwork());
        layout.attach(this._networkButton, 0, 0, 1, 1);
        this._tooltips.push(attachTooltip(this._networkButton, this._layers, 'Wi-Fi'));

        this._bluetoothIcon = new St.Icon({
            icon_name: 'bluetooth-symbolic',
            icon_size: ICON_SIZE
        });

        this._bluetoothButton = this._makeButton(
            this._bluetoothIcon,
            () => this._toggleBluetoothOrAirplane()
        );

        layout.attach(this._bluetoothButton, 1, 0, 1, 1);

        this._bluetoothTooltip = attachTooltip(
            this._bluetoothButton,
            this._layers,
            () => this._airplaneMode ? 'Airplane Mode' : 'Bluetooth'
        );

        this._tooltips.push(this._bluetoothTooltip);

        this._dndIcon = new St.Icon({icon_name: 'notifications-disabled-symbolic', icon_size: ICON_SIZE});
        this._dndButton = this._makeButton(this._dndIcon, () => this._toggleDnd());
        layout.attach(this._dndButton, 0, 1, 1, 1);
        this._tooltips.push(attachTooltip(this._dndButton, this._layers, 'Do Not Disturb'));

        this._themeIcon = new St.Icon({icon_name: 'night-light-symbolic', icon_size: ICON_SIZE});
        this._themeButton = this._makeButton(this._themeIcon, () => this._toggleTheme());
        layout.attach(this._themeButton, 1, 1, 1, 1);
        this._tooltips.push(attachTooltip(this._themeButton, this._layers, 'Dark Mode'));

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

        if (this._rfkillSettings && this._rfkillSignalId) {
            try {
                this._rfkillSettings.disconnect(this._rfkillSignalId);
            } catch (e) {
            }
        }
        this._rfkillSettings = null;
        this._rfkillSignalId = null;

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

        const backgroundColor = settings?.backgroundColor ?? '#070000a5';
        const cornerRadius = resolveCornerRadius(settings);
        this._layers.card.set_style(this._cardStyle(backgroundColor, cornerRadius));
        applyCardOpacity(this._layers.card, settings);
        this._layers.cardBlur.set_style(this._cardBlurStyle(backgroundColor, cornerRadius));
        applyCardBlur(this._layers.cardBlur, settings);

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
            this._api.logger.error(`settings-control: could not reach NetworkManager: ${e.message}`);
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
            this._api.logger.error('settings-control: Wi-Fi toggle requested but NetworkManager is unavailable');
            return;
        }
        const enabled = this._nmProxy.get_cached_property('WirelessEnabled')?.unpack() ?? false;
        this._setDBusProperty(
            Gio.BusType.SYSTEM, 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled', GLib.Variant.new_boolean(!enabled)
        );
    }

    _enableBluetooth() {
        try {
            const objectManager = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SYSTEM,
                Gio.DBusProxyFlags.NONE,
                null,
                'org.bluez',
                '/',
                'org.freedesktop.DBus.ObjectManager',
                null
            );

            const [managedObjects] = objectManager.call_sync(
                'GetManagedObjects',
                null,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            ).deep_unpack();

            this._btAdapterPath = Object.keys(managedObjects)
                .find(path => 'org.bluez.Adapter1' in managedObjects[path]) ?? null;

            if (this._btAdapterPath) {
                this._btProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SYSTEM,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.bluez',
                    this._btAdapterPath,
                    'org.bluez.Adapter1',
                    null
                );

                this._btSignalId = this._btProxy.connect(
                    'g-properties-changed',
                    () => this._renderBluetooth()
                );

                this._airplaneMode = false;
            } else {
                this._enableAirplaneFallback();
            }

        } catch (e) {
            this._btProxy = null;
            this._btAdapterPath = null;
            this._enableAirplaneFallback();
        }

        this._renderBluetooth();
    }
    _enableAirplaneFallback() {
    this._airplaneMode = true;

    try {
        this._rfkillSettings = new Gio.Settings({
            schema_id: 'org.gnome.settings-daemon.plugins.rfkill'
        });
        this._rfkillSignalId = this._rfkillSettings.connect(
            'changed::airplane-mode',
            () => this._renderBluetooth()
        );
    } catch (e) {
        this._api.logger.error(
            `settings-control: could not reach rfkill settings: ${e.message}`
        );
        this._rfkillSettings = null;
    }

    if (!this._bluetoothIcon || !this._bluetoothButton)
        return;

    this._bluetoothIcon.icon_name = 'airplane-mode-symbolic';

    this._setToggleState(
        this._bluetoothIcon,
        this._bluetoothButton,
        false
    );

}

    _renderBluetooth() {
        if (!this._bluetoothIcon)
            return;

        if (this._airplaneMode) {
            this._renderAirplaneMode();
            return;
        }

        const powered =
            this._btProxy
                ?.get_cached_property('Powered')
                ?.unpack() ?? false;

        this._bluetoothIcon.icon_name = 'bluetooth-symbolic';

        this._setToggleState(
            this._bluetoothIcon,
            this._bluetoothButton,
            powered
        );
    }
    _renderAirplaneMode() {
        const enabled = this._rfkillSettings?.get_boolean('airplane-mode') ?? false;

        this._bluetoothIcon.icon_name = 'airplane-mode-symbolic';

        this._setToggleState(
            this._bluetoothIcon,
            this._bluetoothButton,
            enabled
        );
    }
    _toggleBluetoothOrAirplane() {
        if (this._airplaneMode) {
            this._toggleAirplaneMode();
            return;
        }

        this._toggleBluetooth();
    }
    _toggleAirplaneMode() {
        if (!this._rfkillSettings) {
            this._api.logger.error(
                'settings-control: Airplane Mode toggle requested but rfkill is unavailable'
            );
            return;
        }
        try {
            const current = this._rfkillSettings.get_boolean('airplane-mode');
            this._rfkillSettings.set_boolean('airplane-mode', !current);
        } catch (e) {
            this._api.logger.error(
                `settings-control: Airplane Mode toggle failed: ${e.message}`
            );
        }
    }

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

    _renderDnd() {
        if (!this._dndIcon)
            return;
        const dndOn = this._notifSettings ? !this._notifSettings.get_boolean('show-banners') : false;
        this._setToggleState(this._dndIcon, this._dndButton, dndOn);
    }

    _toggleDnd() {
        if (!this._notifSettings) {
            this._api.logger.error(`settings-control: Do Not Disturb toggle requested but ${NOTIFICATIONS_SCHEMA} is unavailable`);
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
            this._api.logger.error(`settings-control: could not reach ${INTERFACE_SCHEMA}: ${e.message}`);
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
            this._api.logger.error(`settings-control: Dark Mode toggle requested but ${INTERFACE_SCHEMA} is unavailable`);
            return;
        }
        const scheme = this._interfaceSettings.get_string('color-scheme');
        this._interfaceSettings.set_string('color-scheme', scheme === 'prefer-dark' ? 'default' : 'prefer-dark');
    }

    _makeButton(icon, onClicked) {
        const button = new St.Button({
            style_class: 'settings-control-widget-button',
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
        const {r, g, b, a} = this._hexToRgba(hex);
        // Keep the old visual defaults for existing six-digit saved colors;
        // newly selected colors include their alpha channel and use it directly.
        const alpha = String(hex).replace('#', '').length >= 8 ? a : (isOn ? 0.9 : 0.12);
        button.set_style(`background-color: rgba(${r}, ${g}, ${b}, ${alpha}); border-radius: ${BUTTON_SIZE / 2}px;`);
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
                        this._api.logger.error(`settings-control: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
                    }
                }
            );
        } catch (e) {
            this._api.logger.error(`settings-control: setting ${interfaceName}.${propertyName} failed: ${e.message}`);
        }
    }

    _cardStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = this._hexToRgba(hexColor);
        return `background-color: rgba(${r}, ${g}, ${b}, ${a}); border-radius: ${cornerRadius}px; ` +
            _borderCss(this._settings) +
            _shadowBoxShadowCss(this._settings);
    }

    _cardBlurStyle(hexColor, cornerRadius) {
        const {r, g, b, a} = this._hexToRgba(hexColor);
        return `background-color: rgba(${r}, ${g}, ${b}, ${a}); border-radius: ${cornerRadius}px;`;
    }

    _hexToRgba(hex) {
        let value = String(hex).replace('#', '');
        if (value.length === 3 || value.length === 4)
            value = [...value].map(c => c + c).join('');
        const rgbNum = parseInt(value.slice(0, 6), 16);
        if (Number.isNaN(rgbNum))
            return {r: 255, g: 255, b: 255, a: 0.85};

        const alphaByte = value.length >= 8 ? parseInt(value.slice(6, 8), 16) : 255;
        const a = Number.isNaN(alphaByte) ? 1 : Math.round((alphaByte / 255) * 1000) / 1000;
        return {r: (rgbNum >> 16) & 255, g: (rgbNum >> 8) & 255, b: rgbNum & 255, a};
    }
}
