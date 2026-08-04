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

            // NOTE on the "widget doesn't refresh when playback starts" bug:
            // GDBusProxy's own cache is only *updated* for properties listed
            // in `changed_properties`. Properties listed in
            // `invalidated_properties` instead (many players, incl. the ones
            // that triggered this bug, send Metadata that way as an
            // optimization for big dict values) are simply *flushed* from
            // the cache - get_cached_property() on them returns null until
            // something explicitly re-fetches. Reading the cache
            // unconditionally after every g-properties-changed (the old
            // code) therefore silently dropped exactly the update that
            // matters most: a brand new track starting. When invalidated
            // properties are present we now explicitly re-fetch the full
            // property set via Properties.GetAll before emitting, instead
            // of trusting whatever GDBusProxy happened to still have cached.
            this._propsChangedId = this._playerProxy.connect(
                'g-properties-changed',
                (_proxy, changed, invalidated) => {
                    // Bug fix: this used to ignore `changed` entirely and
                    // decide purely off `invalidated`, on the assumption
                    // GDBusProxy's own internal cache is always already
                    // in sync with `changed_properties` by the time this
                    // callback runs. That assumption is exactly why a
                    // plain Play<->Pause toggle (which nearly every
                    // player sends via `changed_properties`, not
                    // `invalidated_properties` - it's a small scalar,
                    // there's no reason to invalidate it) could still
                    // show a stale icon: nothing here actually GUARANTEED
                    // the new PlaybackStatus reached this widget's own
                    // read of the cache before _emitFromProxy() ran off
                    // it. Apply `changed` into the proxy's cache
                    // ourselves first - same "keep it boxed as a
                    // variant" walk _refreshThenEmit() below already does
                    // for GetAll's result - so PlaybackStatus (and
                    // anything else that arrived this way) is guaranteed
                    // current on THIS callback, synchronously, with no
                    // dependency on cache-timing and no DBus round-trip.
                    if (changed) {
                        const count = changed.n_children();
                        for (let i = 0; i < count; i++) {
                            const entry = changed.get_child_value(i);
                            const key = entry.get_child_value(0).get_string()[0];
                            const value = entry.get_child_value(1).get_variant();
                            this._playerProxy.set_cached_property(key, value);
                        }
                    }

                    // Metadata (and occasionally other properties, on
                    // some players) still arrives via
                    // `invalidated_properties` instead - see
                    // _refreshThenEmit()'s own doc comment - so that path
                    // is unchanged: a full Properties.GetAll re-fetch for
                    // whatever wasn't included above.
                    if (invalidated && invalidated.length > 0)
                        this._refreshThenEmit();
                    else
                        this._emitFromProxy();
                }
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

    /** @private Re-fetches every Player property via
     * org.freedesktop.DBus.Properties.GetAll (bypassing whatever
     * GDBusProxy's cache currently holds - see the comment above where
     * this is called from) and only then emits. Still purely
     * signal-triggered: this runs once per g-properties-changed event,
     * never on a timer, so it stays inside WIDGET_API.md §9.1's
     * "no polling" rule. Falls back to a plain cache-based emit if the
     * GetAll call itself fails for any reason. */
    _refreshThenEmit() {
        if (!this._playerProxy || this._disposed) return;

        const params = new GLib.Variant('(s)', [MPRIS_PLAYER_IFACE]);
        this._playerProxy.call(
            'org.freedesktop.DBus.Properties.GetAll',
            params,
            Gio.DBusCallFlags.NONE,
            -1,
            null,
            (proxy, res) => {
                if (this._disposed || !this._playerProxy) return;
                try {
                    // Deliberately NOT deep_unpack() here - that would
                    // strip the 'v' (variant) wrapper each dict value
                    // needs to still be a GVariant, which is what
                    // set_cached_property() requires below. Walk the
                    // a{sv} GVariant by hand instead to keep each value
                    // boxed.
                    const dict = proxy.call_finish(res).get_child_value(0);
                    const count = dict.n_children();
                    for (let i = 0; i < count; i++) {
                        const entry = dict.get_child_value(i);
                        const key = entry.get_child_value(0).get_string()[0];
                        const value = entry.get_child_value(1).get_variant();
                        // Feed the freshly-fetched values back into the
                        // proxy's own cache so every other _getProp() call
                        // in _emitFromProxy() (Position, Shuffle,
                        // LoopStatus, ...) also sees up-to-date data, not
                        // just Metadata.
                        this._playerProxy.set_cached_property(key, value);
                    }
                } catch (e) {
                    this._logger.warn?.('Properties.GetAll refresh failed:', e.message);
                }
                this._emitFromProxy();
            }
        );
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