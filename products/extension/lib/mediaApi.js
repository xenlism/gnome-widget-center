// products/extension/lib/mediaApi.js
//
// Reusable MPRIS2 (org.mpris.MediaPlayer2.*) client over the session DBus.
// Extracted from widgets/media-player/widget.js so any bundled widget that
// wants "now playing" data doesn't have to re-implement the DBusProxy
// plumbing (name discovery, NameOwnerChanged tracking, signal cleanup,
// GVariant unpacking) from scratch.
//
// Scope note (see development/docs/WIDGET_API.md §8): the public,
// documented-for-third-parties pattern is still "talk to DBusProxy directly
// from widget.js, no host hook needed" - that recommendation doesn't change
// with this file. This class is only reachable via a relative import
// (`../../lib/mediaApi.js`), which works for widgets bundled inside this
// extension (like media-player) but NOT for third-party widgets installed
// under ~/.local/share/gnome-widget-center/widgets/ - they live in a
// different directory entirely and have no path back to this file. It is
// NOT exposed on the public `api` object built in widgetLoader.js. If we
// ever want third-party widgets to use this too, that's a deliberate API
// addition (`api.media`) and WIDGET_API.md §8 needs rewriting alongside it
// - don't wire it in silently as a side effect of some other change.
//
// Same MUST rules as WIDGET_API.md §8: no polling (signal-based only),
// first MPRIS name found wins (documented limitation, not a bug - see
// development/tasks/06-widget-sdk-example.md "Out of scope"), and every
// proxy/signal this class creates is released in stop().

import Gio from 'gi://Gio';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

/** @typedef {{title: string, artist: string, status: string, artUrl: string}} MediaState */

export class MprisMediaService {
    /**
     * @param {{info: Function, warn: Function, error: Function}} [logger]
     *   - defaults to console; pass api.logger from a widget for automatic
     *   id-prefixed log lines.
     */
    constructor(logger = console) {
        this._logger = logger;

        this._dbusProxy = null;
        this._nameOwnerChangedId = null;
        this._playerProxy = null;
        this._propsChangedId = null;
        this._currentBusName = null;
        this._onUpdate = null; // (MediaState|null) => void
    }

    /** Whether we're currently following a player (not just DBus itself). */
    get isAttached() {
        return this._currentBusName !== null;
    }

    /**
     * Starts watching the session bus for MPRIS2 players. Calls
     * `onUpdate(state)` immediately with `null` (nothing found yet is the
     * same shape as nothing playing) and again every time playback state
     * changes or a player appears/disappears. Never throws - if DBus
     * itself is unreachable, logs a warning and leaves you on `null`
     * forever, same graceful-degradation contract as WIDGET_API.md §8.
     *
     * @param {(state: MediaState|null) => void} onUpdate
     */
    start(onUpdate) {
        this._onUpdate = onUpdate;

        try {
            this._dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                DBUS_NAME, DBUS_PATH, DBUS_IFACE, null
            );
        } catch (e) {
            this._logger.warn?.('could not reach org.freedesktop.DBus:', e.message);
            this._emit(null);
            return;
        }

        this._nameOwnerChangedId = this._dbusProxy.connectSignal('NameOwnerChanged',
            (_proxy, _sender, [name, oldOwner, newOwner]) => {
                if (!name.startsWith(MPRIS_PREFIX))
                    return;

                if (newOwner && !this._currentBusName)
                    this._attachToPlayer(name);
                else if (!newOwner && name === this._currentBusName)
                    this._detachFromPlayer();
            });

        this._findExistingPlayer();
    }

    /** Releases every proxy/signal. Safe to call even if start() was never called. */
    stop() {
        this._detachFromPlayer();

        if (this._dbusProxy && this._nameOwnerChangedId !== null)
            this._dbusProxy.disconnectSignal(this._nameOwnerChangedId);
        this._nameOwnerChangedId = null;
        this._dbusProxy = null;
        this._onUpdate = null;
    }

    /** No-op (with a warning logged) if nothing is currently attached. */
    playPause() { this._call('PlayPause'); }
    next() { this._call('Next'); }
    previous() { this._call('Previous'); }

    /** @private */
    _findExistingPlayer() {
        try {
            const [names] = this._dbusProxy
                .call_sync('ListNames', null, Gio.DBusCallFlags.NONE, -1, null)
                .deep_unpack();
            const mprisName = names.find(n => n.startsWith(MPRIS_PREFIX));
            if (mprisName)
                this._attachToPlayer(mprisName);
            else
                this._emit(null);
        } catch (e) {
            this._logger.warn?.('ListNames failed:', e.message);
            this._emit(null);
        }
    }

    /** @private */
    _attachToPlayer(busName) {
        if (this._currentBusName)
            return; // already following one - first-found wins, see header note

        let proxy;
        try {
            proxy = Gio.DBusProxy.new_for_bus_sync(
                Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null,
                busName, MPRIS_PATH, MPRIS_PLAYER_IFACE, null
            );
        } catch (e) {
            this._logger.warn?.(`could not attach to "${busName}":`, e.message);
            return;
        }

        this._playerProxy = proxy;
        this._currentBusName = busName;
        this._propsChangedId = proxy.connect('g-properties-changed', () => this._emitFromProxy());
        this._emitFromProxy();
    }

    /** @private */
    _detachFromPlayer() {
        if (this._playerProxy && this._propsChangedId !== null)
            this._playerProxy.disconnect(this._propsChangedId);
        this._propsChangedId = null;
        this._playerProxy = null;
        this._currentBusName = null;
        this._emit(null);
    }

    /** @private */
    _call(method) {
        if (!this._playerProxy) {
            this._logger.warn?.(`${method}() called with no player attached`);
            return;
        }
        try {
            this._playerProxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, null);
        } catch (e) {
            this._logger.warn?.(`${method}() failed:`, e.message);
        }
    }

    /** @private */
    _emit(state) {
        this._onUpdate?.(state);
    }

    /** @private */
    _emitFromProxy() {
        if (!this._playerProxy) {
            this._emit(null);
            return;
        }

        // Read-only snapshot of external, transient state - per
        // WIDGET_API.md §8 MUST rules this is never written to any
        // settings file, just handed to the caller each time it changes.
        const metadata = this._variantToJS(this._playerProxy.get_cached_property('Metadata')) ?? {};
        const status = String(this._variantToJS(this._playerProxy.get_cached_property('PlaybackStatus')) ?? 'Stopped');

        const title = String(metadata['xesam:title'] ?? 'Unknown title');
        const artists = metadata['xesam:artist'];
        const artist = Array.isArray(artists) ? artists.map(a => String(a)).join(', ') : String(artists ?? '');
        const artUrl = String(metadata['mpris:artUrl'] ?? '');

        this._emit({title, artist, status, artUrl});
    }

    /** @private */
    _variantToJS(value) {
        while (value && (typeof value.deep_unpack === 'function' || typeof value.unpack === 'function'))
            value = value.deep_unpack ? value.deep_unpack() : value.unpack();
        if (Array.isArray(value))
            return value.map(v => this._variantToJS(v));
        if (value && typeof value === 'object') {
            const o = {};
            for (const [k, v] of Object.entries(value))
                o[k] = this._variantToJS(v);
            return o;
        }
        return value;
    }
}
