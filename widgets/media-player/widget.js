// widgets/media-player/widget.js
//
// Task 06 — SDK example #2: a "Now Playing" widget that reads/controls
// whatever MPRIS2-compatible media player is currently running (Spotify,
// VLC, Rhythmbox, Firefox, ...) over the session DBus. This is the point
// of the second example widget in this pack: it proves the CURRENT
// WidgetAPI already supports a widget that talks to an external system
// service, with no new hooks added to the host — see
// docs/WIDGET_API.md §8 for the full pattern and the MUST rules this file
// follows (graceful degradation with no player running, signal-based
// updates only, no polling, full DBusProxy/signal cleanup in disable()).
//
// Known limitation (documented, not a bug — see
// tasks/06-widget-sdk-example.md "Out of scope"): if more than one MPRIS
// player is running at once, this widget follows whichever bus name it
// noticed first (either already running at enable() time, or the first
// NameOwnerChanged after that) and ignores the rest until that one goes
// away.

import St from 'gi://St';
import Gio from 'gi://Gio';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

export default class MediaPlayerWidget {
    /**
     * @param {WidgetAPI} api - see docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;

        this._dbusProxy = null;          // proxy to org.freedesktop.DBus itself
        this._nameOwnerChangedId = null; // DBus-signal subscription id on _dbusProxy
        this._playerProxy = null;        // proxy to the current player's Player iface, or null
        this._propsChangedId = null;     // GObject-signal id on _playerProxy
        this._currentBusName = null;     // whichever org.mpris.MediaPlayer2.* we're following
    }

    // Must never throw even before enable() has found a player - starts on
    // the same "No media playing" placeholder enable() would fall back to
    // anyway if DBus itself were unreachable.
    buildActor() {
        this._actor = new St.BoxLayout({
            style_class: 'media-player-widget-root',
            vertical: true,
        });

        this._art = new St.Icon({
            style_class: 'media-player-widget-art',
            icon_name: 'audio-x-generic-symbolic',
            icon_size: 48,
        });

        this._titleLabel = new St.Label({style_class: 'media-player-widget-title'});
        this._artistLabel = new St.Label({style_class: 'media-player-widget-artist'});

        const infoBox = new St.BoxLayout({vertical: true, style_class: 'media-player-widget-info'});
        infoBox.add_child(this._titleLabel);
        infoBox.add_child(this._artistLabel);

        const topRow = new St.BoxLayout({style_class: 'media-player-widget-top'});
        topRow.add_child(this._art);
        topRow.add_child(infoBox);

        this._prevButton = this._makeButton('media-skip-backward-symbolic', () => this._call('Previous'));
        this._playPauseButton = this._makeButton('media-playback-start-symbolic', () => this._call('PlayPause'));
        this._nextButton = this._makeButton('media-skip-forward-symbolic', () => this._call('Next'));

        this._controls = new St.BoxLayout({style_class: 'media-player-widget-controls'});
        this._controls.add_child(this._prevButton);
        this._controls.add_child(this._playPauseButton);
        this._controls.add_child(this._nextButton);

        this._actor.add_child(topRow);
        this._actor.add_child(this._controls);

        this._renderNoPlayer();
        return this._actor;
    }

    enable() {
        try {
            this._dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                DBUS_NAME, DBUS_PATH, DBUS_IFACE, null
            );
        } catch (e) {
            // Graceful degradation per docs/WIDGET_API.md §8 MUST rules -
            // stay on the "No media playing" placeholder rather than throw.
            this._api.logger.warn('could not reach org.freedesktop.DBus:', e.message);
            return;
        }

        // Subscribe to future player start/stop events...
        this._nameOwnerChangedId = this._dbusProxy.connectSignal('NameOwnerChanged',
            (_proxy, _sender, [name, oldOwner, newOwner]) => {
                if (!name.startsWith(MPRIS_PREFIX))
                    return;

                if (newOwner && !this._currentBusName)
                    this._attachToPlayer(name);
                else if (!newOwner && name === this._currentBusName)
                    this._detachFromPlayer();
            });

        // ...and also check for one already running, since
        // NameOwnerChanged only fires for changes from this point forward.
        this._findExistingPlayer();
    }

    disable() {
        this._detachFromPlayer();

        if (this._dbusProxy && this._nameOwnerChangedId !== null)
            this._dbusProxy.disconnectSignal(this._nameOwnerChangedId);
        this._nameOwnerChangedId = null;
        this._dbusProxy = null;
    }

    getDefaultSettings() {
        return {
            showArtwork: true,
            compactMode: false,
        };
    }

    /** @private one-time scan at enable() time for a player already running. */
    _findExistingPlayer() {
        try {
            const [names] = this._dbusProxy
                .call_sync('ListNames', null, Gio.DBusCallFlags.NONE, -1, null)
                .deep_unpack();
            const mprisName = names.find(n => n.startsWith(MPRIS_PREFIX));
            if (mprisName)
                this._attachToPlayer(mprisName);
        } catch (e) {
            this._api.logger.warn('ListNames failed:', e.message);
        }
    }

    /** @private */
    _attachToPlayer(busName) {
        if (this._currentBusName)
            return; // already following one - first-found wins, see header Notes

        let proxy;
        try {
            proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                busName, MPRIS_PATH, MPRIS_PLAYER_IFACE, null
            );
        } catch (e) {
            this._api.logger.warn(`could not attach to "${busName}":`, e.message);
            return;
        }

        this._playerProxy = proxy;
        this._currentBusName = busName;
        this._propsChangedId = proxy.connect('g-properties-changed', () => this._renderFromProxy());
        this._renderFromProxy();
    }

    /** @private */
    _detachFromPlayer() {
        if (this._playerProxy && this._propsChangedId !== null)
            this._playerProxy.disconnect(this._propsChangedId);
        this._propsChangedId = null;
        this._playerProxy = null;
        this._currentBusName = null;
        this._renderNoPlayer();
    }

    /** @private */
    _call(method) {
        if (!this._playerProxy)
            return;
        try {
            this._playerProxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (e) {
            this._api.logger.warn(`${method}() failed:`, e.message);
        }
    }

    /** @private */
    _makeButton(iconName, onClicked) {
        const button = new St.Button({
            style_class: 'media-player-widget-button',
            child: new St.Icon({icon_name: iconName, icon_size: 20}),
        });
        button.connect('clicked', onClicked);
        return button;
    }

    
    _variantToJS(value) {
        while (value && (typeof value.deep_unpack==='function' || typeof value.unpack==='function'))
            value = value.deep_unpack ? value.deep_unpack() : value.unpack();
        if (Array.isArray(value))
            return value.map(v=>this._variantToJS(v));
        if (value && typeof value==='object') {
            const o={};
            for (const [k,v] of Object.entries(value))
                o[k]=this._variantToJS(v);
            return o;
        }
        return value;
    }

/** @private */
    _renderNoPlayer() {
        this._titleLabel.set_text('No media playing');
        this._artistLabel.set_text('');
        this._art.icon_name = 'audio-x-generic-symbolic';
        this._controls.hide();
    }

    /** @private */
    _renderFromProxy() {
        if (!this._playerProxy) {
            this._renderNoPlayer();
            return;
        }

        // Read-only snapshot of external, transient state - per
        // docs/WIDGET_API.md §8 MUST rules this is kept in local variables
        // only, never written into this._settings (that file is for
        // user-chosen settings, not what happens to be playing right now).
        const metadata = this._variantToJS(this._playerProxy.get_cached_property('Metadata')) ?? {};
        const status = String(this._variantToJS(this._playerProxy.get_cached_property('PlaybackStatus')) ?? 'Stopped');

        const title = String(metadata['xesam:title'] ?? 'Unknown title');
        const artists = metadata['xesam:artist'];
        const artist = Array.isArray(artists)?artists.map(a=>String(a)).join(', '):String(artists??'');

        this._titleLabel.set_text(title);
        this._artistLabel.set_text(artist);
        this._controls.show();

        this._playPauseButton.child.icon_name = status === 'Playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic';

        const compact = this._settings.compactMode ?? false;
        this._prevButton.visible = !compact;
        this._nextButton.visible = !compact;

        const showArtwork = this._settings.showArtwork ?? true;
        const artUrl = String(metadata['mpris:artUrl'] ?? '');
        if (showArtwork && typeof artUrl === 'string' && artUrl.length > 0) {
            try {
                let file;
                if (artUrl.startsWith('file://'))
                    file = Gio.File.new_for_uri(artUrl);
                else
                    file = Gio.File.new_for_path(artUrl);
                this._art.gicon = new Gio.FileIcon({ file });
            } catch (e) {
                this._art.icon_name = 'audio-x-generic-symbolic';
            }
            this._art.show();
        } else if (showArtwork) {
            this._art.icon_name = 'audio-x-generic-symbolic';
            this._art.show();
        } else {
            this._art.hide();
        }
    }
}
