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
import GLib from 'gi://GLib';

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const DBUS_IFACE = 'org.freedesktop.DBus';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';

const MPRIS_ROOT_IFACE = 'org.mpris.MediaPlayer2';
const MPRIS_PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';

/**
 * @typedef {{
 * title:string,
 * artist:string,
 * album:string,
 * status:string,
 * artUrl:string,
 * lengthMs:number,
 * positionMs:number,
 * volume:number,
 * shuffle:boolean,
 * loopStatus:string,
 * appName:string,
 * busName:string,
 * trackId:string,
 * canControl:boolean,
 * canPlay:boolean,
 * canPause:boolean,
 * canSeek:boolean,
 * canGoNext:boolean,
 * canGoPrevious:boolean,
 * canRaise:boolean,
 * canQuit:boolean
 * }} MediaState
 */

export class MprisMediaService {

    constructor(logger = console) {
        this._logger = logger;

        this._dbusProxy = null;
        this._rootProxy = null;

        this._nameOwnerChangedId = null;

        this._playerProxy = null;
        this._propsChangedId = null;
        this._seekedId = null;

        this._currentBusName = null;

        this._onUpdate = null;
        this._state = null;

        // Async safety flags
        this._disposed = false;
        this._attaching = false;
    }

    get isAttached() {
        return this._currentBusName !== null;
    }

    /**
     * Starts the service, listening for MPRIS players.
     * @param {(state: MediaState | null) => void} onUpdate 
     */
    async start(onUpdate) {
        // Allow restarting if stop() was called previously
        this._disposed = false;
        this._onUpdate = onUpdate;

        try {
            this._dbusProxy = await this._createProxy(DBUS_NAME, DBUS_PATH, DBUS_IFACE);
        } catch (e) {
            if (this._disposed) return;
            this._logger.warn?.('could not reach DBus:', e.message);
            this._emit(null);
            return;
        }

        if (this._disposed) return;

        this._nameOwnerChangedId = this._dbusProxy.connectSignal(
            'NameOwnerChanged',
            (_proxy, _sender, [name, oldOwner, newOwner]) => {
                if (this._disposed || !name.startsWith(MPRIS_PREFIX)) return;

                if (newOwner && !this._currentBusName) {
                    this._attachToPlayer(name);
                } else if (!newOwner && name === this._currentBusName) {
                    this._detachFromPlayer();
                }
            }
        );

        this._findExistingPlayer();
    }

    /**
     * Creates a DBusProxy asynchronously to avoid blocking the main thread.
     */
    _createProxy(busName, path, iface) {
        return new Promise((resolve, reject) => {
            Gio.DBusProxy.new_for_bus(
                Gio.BusType.SESSION,
                Gio.DBusProxyFlags.NONE,
                null,
                busName,
                path,
                iface,
                null,
                (proxy, res) => {
                    try {
                        resolve(Gio.DBusProxy.new_for_bus_finish(res));
                    } catch (e) {
                        reject(e);
                    }
                }
            );
        });
    }

    stop() {
        if (this._disposed) return;
        this._disposed = true;

        // Detach from player first, but prevent _emit from firing 
        // into a potentially destroyed widget during teardown.
        this._onUpdate = null; 
        this._detachFromPlayer(false);

        if (this._dbusProxy && this._nameOwnerChangedId !== null) {
            this._dbusProxy.disconnectSignal(this._nameOwnerChangedId);
        }

        this._nameOwnerChangedId = null;
        this._dbusProxy = null;
    }

    playPause() { this._call('PlayPause'); }
    play() { this._call('Play'); }
    pause() { this._call('Pause'); }
    stopPlayback() { this._call('Stop'); }
    next() { this._call('Next'); }
    previous() { this._call('Previous'); }

    seek(offsetMs) {
        if (!this._playerProxy || this._disposed) return;

        const params = new GLib.Variant('(x)', [BigInt(Math.round(offsetMs * 1000))]);
        this._playerProxy.call(
            'Seek',
            params,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    this._logger.warn?.('Seek failed:', e.message);
                }
            }
        );
    }

    position() { return this._state?.positionMs ?? 0; }
    duration() { return this._state?.lengthMs ?? 0; }
    volume() { return this._state?.volume ?? 0; }

    setVolume(value) {
        this._setProperty('Volume', new GLib.Variant('d', Math.max(0, Math.min(1, Number(value)))));
    }

    setShuffle(value) {
        this._setProperty('Shuffle', new GLib.Variant('b', Boolean(value)));
    }

    setLoop(mode) {
        this._setProperty('LoopStatus', new GLib.Variant('s', String(mode)));
    }

    raise() {
        if (!this._rootProxy || this._disposed) return;
        this._rootProxy.call('Raise', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._logger.warn?.('Raise failed:', e.message);
            }
        });
    }

    quit() {
        if (!this._rootProxy || this._disposed) return;
        this._rootProxy.call('Quit', null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._logger.warn?.('Quit failed:', e.message);
            }
        });
    }

    _findExistingPlayer() {
        if (this._disposed || !this._dbusProxy) return;

        this._dbusProxy.call(
            'ListNames',
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                if (this._disposed) return;
                try {
                    const result = proxy.call_finish(res);
                    const [names] = result.deep_unpack();
                    const mprisName = names.find(n => n.startsWith(MPRIS_PREFIX));

                    if (mprisName) {
                        this._attachToPlayer(mprisName);
                    } else {
                        this._emit(null);
                    }
                } catch (e) {
                    this._logger.warn?.('ListNames failed:', e.message);
                    this._emit(null);
                }
            }
        );
    }

    async _attachToPlayer(busName) {
        // Prevent re-entry or attaching while we are disposing/already attaching
        if (this._disposed || this._currentBusName || this._attaching) return;
        
        this._attaching = true;

        try {
            const playerProxy = await this._createProxy(busName, MPRIS_PATH, MPRIS_PLAYER_IFACE);
            const rootProxy = await this._createProxy(busName, MPRIS_PATH, MPRIS_ROOT_IFACE);
            
            // If stop() was called while waiting for proxies, bail out
            if (this._disposed) return;

            this._playerProxy = playerProxy;
            this._rootProxy = rootProxy;
            this._currentBusName = busName;

            this._propsChangedId = this._playerProxy.connect(
                'g-properties-changed',
                () => this._emitFromProxy()
            );

            // MPRIS Position property doesn't emit PropertiesChanged.
            // We must listen to the Seeked signal for real-time progress.
            this._seekedId = this._playerProxy.connectSignal('Seeked', (_p, _s, [positionUs]) => {
                if (this._disposed || !this._state) return;
                this._state.positionMs = this._safeNumber(Number(positionUs) / 1000);
                this._onUpdate?.(this._state);
            });

            this._emitFromProxy();
        } catch (e) {
            if (!this._disposed) {
                this._logger.warn?.('attach failed:', e.message);
            }
        } finally {
            // Guarantee the lock is always released, even if connect()
            // or _emitFromProxy() throws an exception.
            this._attaching = false;
        }
    }

    _detachFromPlayer(reemit = true) {
        if (this._playerProxy) {
            if (this._propsChangedId !== null) {
                this._playerProxy.disconnect(this._propsChangedId);
            }
            if (this._seekedId !== null) {
                this._playerProxy.disconnectSignal(this._seekedId);
            }
        }

        this._propsChangedId = null;
        this._seekedId = null;
        this._playerProxy = null;
        this._rootProxy = null;
        this._currentBusName = null;
        this._state = null;
        
        // Ensure attaching state is cleared if detach is called mid-attach
        this._attaching = false;

        // If a player quit, try to find another one before giving up and emitting null
        if (reemit && !this._disposed) {
            if (this._dbusProxy) {
                this._findExistingPlayer();
            } else {
                this._emit(null);
            }
        }
    }

    _call(method) {
        if (!this._playerProxy || this._disposed) return;

        this._playerProxy.call(
            method,
            null,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                if (this._disposed) return;
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    this._logger.warn?.(`${method} failed:`, e.message);
                }
            }
        );
    }

    _setProperty(name, value) {
        if (!this._playerProxy || this._disposed) return;

        const params = new GLib.Variant('(ssv)', [MPRIS_PLAYER_IFACE, name, value]);
        this._playerProxy.call(
            'org.freedesktop.DBus.Properties.Set',
            params,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                if (this._disposed) return;
                try {
                    proxy.call_finish(res);
                } catch (e) {
                    this._logger.warn?.(`set ${name} failed:`, e.message);
                }
            }
        );
    }

    _emit(state) {
        if (this._disposed) return;
        this._state = state;
        this._onUpdate?.(state);
    }

    _getProp(proxy, name) {
        return this._variantToJS(proxy?.get_cached_property(name));
    }

    _safeNumber(value) {
        const n = Number(value);
        return Number.isFinite(n) ? n : 0;
    }

    _emitFromProxy() {
        if (this._disposed || !this._playerProxy) {
            this._emit(null);
            return;
        }

        const metadata = this._variantToJS(this._playerProxy.get_cached_property('Metadata')) ?? {};

        // --- Artwork Quirks Handling ---
        // Only prepend file:// if it's a bare path. Don't decodeURIComponent 
        // as it corrupts valid http(s) URLs with encoded characters.
        let rawArtUrl = String(metadata['mpris:artUrl'] ?? '');
        if (rawArtUrl && !rawArtUrl.includes('://') && rawArtUrl.startsWith('/')) {
            rawArtUrl = `file://${rawArtUrl}`;
        }

        const artistRaw = metadata['xesam:artist'];
        const artist = Array.isArray(artistRaw)
            ? artistRaw.map(String).join(', ')
            : (typeof artistRaw === 'string' ? artistRaw : '');

        const state = {
            title: String(metadata['xesam:title'] ?? 'Unknown title'),
            artist,
            album: String(metadata['xesam:album'] ?? ''),
            status: String(this._getProp(this._playerProxy, 'PlaybackStatus') ?? 'Stopped'),
            artUrl: rawArtUrl,
            lengthMs: this._safeNumber(metadata['mpris:length']) / 1000,
            positionMs: this._safeNumber(this._getProp(this._playerProxy, 'Position')) / 1000,
            volume: this._safeNumber(this._getProp(this._playerProxy, 'Volume')),
            shuffle: Boolean(this._getProp(this._playerProxy, 'Shuffle')),
            loopStatus: String(this._getProp(this._playerProxy, 'LoopStatus') ?? 'None'),
            appName: this._getAppName(),
            busName: this._currentBusName ?? '',
            trackId: String(metadata['mpris:trackid'] ?? ''),
            
            // --- Player Capabilities ---
            canControl: Boolean(this._getProp(this._playerProxy, 'CanControl')),
            canPlay: Boolean(this._getProp(this._playerProxy, 'CanPlay')),
            canPause: Boolean(this._getProp(this._playerProxy, 'CanPause')),
            canSeek: Boolean(this._getProp(this._playerProxy, 'CanSeek')),
            canGoNext: Boolean(this._getProp(this._playerProxy, 'CanGoNext')),
            canGoPrevious: Boolean(this._getProp(this._playerProxy, 'CanGoPrevious')),
            canRaise: Boolean(this._getProp(this._rootProxy, 'CanRaise')),
            canQuit: Boolean(this._getProp(this._rootProxy, 'CanQuit')),
        };

        this._emit(state);
    }

    _getAppName() {
        try {
            const identity = this._getProp(this._rootProxy, 'Identity');
            if (identity) return String(identity);
        } catch (e) {
            this._logger.warn?.('Identity read failed:', e.message);
        }

        // Fallback: strip MPRIS_PREFIX to get the app name
        if (this._currentBusName?.startsWith(MPRIS_PREFIX)) {
            return this._currentBusName.slice(MPRIS_PREFIX.length).split('.')[0];
        }
        
        return this._currentBusName ?? '';
    }

    /**
     * Recursively unpacks a GVariant to a native JS object.
     * Ensures arrays and dictionaries are fully mapped, avoiding 
     * potential lingering GVariant types in edge cases.
     */
    _variantToJS(value) {
        // Unpack GVariant if it has deep_unpack
        if (value && typeof value.deep_unpack === 'function') {
            value = value.deep_unpack();
        }

        // Recursively process arrays
        if (Array.isArray(value)) {
            return value.map(v => this._variantToJS(v));
        }

        // Recursively process plain JS objects (like dictionaries a{sv})
        // Note: Must check Array.isArray first, since Arrays are technically objects
        if (value && typeof value === 'object') {
            const obj = {};
            for (const [k, v] of Object.entries(value)) {
                obj[k] = this._variantToJS(v);
            }
            return obj;
        }

        return value;
    }
}