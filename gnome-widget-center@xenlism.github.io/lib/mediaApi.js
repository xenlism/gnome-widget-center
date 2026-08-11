import Gio from "gi://Gio";

import GLib from "gi://GLib";

const DBUS_NAME = "org.freedesktop.DBus";

const DBUS_PATH = "/org/freedesktop/DBus";

const DBUS_IFACE = "org.freedesktop.DBus";

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";

const MPRIS_PATH = "/org/mpris/MediaPlayer2";

const MPRIS_ROOT_IFACE = "org.mpris.MediaPlayer2";

const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

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
        this._disposed = false;
        this._attaching = false;
    }
    get isAttached() {
        return this._currentBusName !== null;
    }
    async start(onUpdate) {
        this._disposed = false;
        this._onUpdate = onUpdate;
        try {
            this._dbusProxy = await this._createProxy(DBUS_NAME, DBUS_PATH, DBUS_IFACE);
        } catch (e) {
            if (this._disposed) return;
            this._logger.warn?.("could not reach DBus:", e.message);
            this._emit(null);
            return;
        }
        if (this._disposed) return;
        this._nameOwnerChangedId = Gio.DBus.session.signal_subscribe(DBUS_NAME, DBUS_IFACE, "NameOwnerChanged", DBUS_PATH, MPRIS_PREFIX.slice(0, -1), Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (_connection, _sender, _path, _iface, _signal, params) => {
            const [name, oldOwner, newOwner] = params.deep_unpack();
            if (this._disposed) return;
            if (newOwner && !this._currentBusName) {
                this._attachToPlayer(name);
            } else if (!newOwner && name === this._currentBusName) {
                this._detachFromPlayer();
            }
        });
        this._findExistingPlayer();
    }
    _createProxy(busName, path, iface) {
        return new Promise((resolve, reject) => {
            Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, null, busName, path, iface, null, (proxy, res) => {
                try {
                    resolve(Gio.DBusProxy.new_for_bus_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });
    }
    stop() {
        if (this._disposed) return;
        this._disposed = true;
        this._onUpdate = null;
        this._detachFromPlayer(false);
        if (this._nameOwnerChangedId !== null) {
            Gio.DBus.session.signal_unsubscribe(this._nameOwnerChangedId);
        }
        this._nameOwnerChangedId = null;
        this._dbusProxy = null;
    }
    playPause() {
        this._call("PlayPause");
    }
    play() {
        this._call("Play");
    }
    pause() {
        this._call("Pause");
    }
    stopPlayback() {
        this._call("Stop");
    }
    next() {
        this._call("Next");
    }
    previous() {
        this._call("Previous");
    }
    seek(offsetMs) {
        if (!this._playerProxy || this._disposed) return;
        const params = new GLib.Variant("(x)", [ BigInt(Math.round(offsetMs * 1e3)) ]);
        this._playerProxy.call("Seek", params, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._logger.warn?.("Seek failed:", e.message);
            }
        });
    }
    position() {
        return this._state?.positionMs ?? 0;
    }
    duration() {
        return this._state?.lengthMs ?? 0;
    }
    volume() {
        return this._state?.volume ?? 0;
    }
    setVolume(value) {
        this._setProperty("Volume", new GLib.Variant("d", Math.max(0, Math.min(1, Number(value)))));
    }
    setShuffle(value) {
        this._setProperty("Shuffle", new GLib.Variant("b", Boolean(value)));
    }
    setLoop(mode) {
        this._setProperty("LoopStatus", new GLib.Variant("s", String(mode)));
    }
    raise() {
        if (!this._rootProxy || this._disposed) return;
        this._rootProxy.call("Raise", null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._logger.warn?.("Raise failed:", e.message);
            }
        });
    }
    quit() {
        if (!this._rootProxy || this._disposed) return;
        this._rootProxy.call("Quit", null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._logger.warn?.("Quit failed:", e.message);
            }
        });
    }
    _findExistingPlayer() {
        if (this._disposed || !this._dbusProxy) return;
        this._dbusProxy.call("ListNames", null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
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
                this._logger.warn?.("ListNames failed:", e.message);
                this._emit(null);
            }
        });
    }
    async _attachToPlayer(busName) {
        if (this._disposed || this._currentBusName || this._attaching) return;
        this._attaching = true;
        try {
            const playerProxy = await this._createProxy(busName, MPRIS_PATH, MPRIS_PLAYER_IFACE);
            const rootProxy = await this._createProxy(busName, MPRIS_PATH, MPRIS_ROOT_IFACE);
            if (this._disposed) return;
            this._playerProxy = playerProxy;
            this._rootProxy = rootProxy;
            this._currentBusName = busName;
            this._propsChangedId = this._playerProxy.connect("g-properties-changed", (_proxy, changed, invalidated) => {
                if (changed) {
                    const count = changed.n_children();
                    for (let i = 0; i < count; i++) {
                        const entry = changed.get_child_value(i);
                        const key = entry.get_child_value(0).get_string()[0];
                        const value = entry.get_child_value(1).get_variant();
                        this._playerProxy.set_cached_property(key, value);
                    }
                }
                if (invalidated && invalidated.length > 0) this._refreshThenEmit(); else this._emitFromProxy();
            });
            this._seekedId = this._playerProxy.connectSignal("Seeked", (_p, _s, [positionUs]) => {
                if (this._disposed || !this._state) return;
                this._state.positionMs = this._safeNumber(Number(positionUs) / 1e3);
                this._onUpdate?.(this._state);
            });
            this._refreshThenEmit();
        } catch (e) {
            if (!this._disposed) {
                this._logger.warn?.("attach failed:", e.message);
            }
        } finally {
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
        this._attaching = false;
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
        this._playerProxy.call(method, null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            if (this._disposed) return;
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._logger.warn?.(`${method} failed:`, e.message);
            }
        });
    }
    _setProperty(name, value) {
        if (!this._playerProxy || this._disposed) return;
        const params = new GLib.Variant("(ssv)", [ MPRIS_PLAYER_IFACE, name, value ]);
        this._playerProxy.call("org.freedesktop.DBus.Properties.Set", params, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            if (this._disposed) return;
            try {
                proxy.call_finish(res);
            } catch (e) {
                this._logger.warn?.(`set ${name} failed:`, e.message);
            }
        });
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
    _refreshThenEmit() {
        if (!this._playerProxy || this._disposed) return;
        const proxyAtCallTime = this._playerProxy;
        const params = new GLib.Variant("(s)", [ MPRIS_PLAYER_IFACE ]);
        proxyAtCallTime.call("org.freedesktop.DBus.Properties.GetAll", params, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            if (this._disposed || this._playerProxy !== proxyAtCallTime) return;
            try {
                const dict = proxy.call_finish(res).get_child_value(0);
                const count = dict.n_children();
                for (let i = 0; i < count; i++) {
                    const entry = dict.get_child_value(i);
                    const key = entry.get_child_value(0).get_string()[0];
                    const value = entry.get_child_value(1).get_variant();
                    this._playerProxy.set_cached_property(key, value);
                }
            } catch (e) {
                this._logger.warn?.("Properties.GetAll refresh failed:", e.message);
            }
            this._emitFromProxy();
        });
    }
    _emitFromProxy() {
        if (this._disposed || !this._playerProxy) {
            this._emit(null);
            return;
        }
        const metadata = this._variantToJS(this._playerProxy.get_cached_property("Metadata")) ?? {};
        let rawArtUrl = String(metadata["mpris:artUrl"] ?? "");
        if (rawArtUrl && !rawArtUrl.includes("://") && rawArtUrl.startsWith("/")) {
            rawArtUrl = `file://${rawArtUrl}`;
        }
        const artistRaw = metadata["xesam:artist"];
        const artist = Array.isArray(artistRaw) ? artistRaw.map(String).join(", ") : typeof artistRaw === "string" ? artistRaw : "";
        const state = {
            title: String(metadata["xesam:title"] ?? "Unknown title"),
            artist: artist,
            album: String(metadata["xesam:album"] ?? ""),
            status: String(this._getProp(this._playerProxy, "PlaybackStatus") ?? "Stopped"),
            artUrl: rawArtUrl,
            lengthMs: this._safeNumber(metadata["mpris:length"]) / 1e3,
            positionMs: this._safeNumber(this._getProp(this._playerProxy, "Position")) / 1e3,
            volume: this._safeNumber(this._getProp(this._playerProxy, "Volume")),
            shuffle: Boolean(this._getProp(this._playerProxy, "Shuffle")),
            loopStatus: String(this._getProp(this._playerProxy, "LoopStatus") ?? "None"),
            appName: this._getAppName(),
            busName: this._currentBusName ?? "",
            trackId: String(metadata["mpris:trackid"] ?? ""),
            canControl: Boolean(this._getProp(this._playerProxy, "CanControl")),
            canPlay: Boolean(this._getProp(this._playerProxy, "CanPlay")),
            canPause: Boolean(this._getProp(this._playerProxy, "CanPause")),
            canSeek: Boolean(this._getProp(this._playerProxy, "CanSeek")),
            canGoNext: Boolean(this._getProp(this._playerProxy, "CanGoNext")),
            canGoPrevious: Boolean(this._getProp(this._playerProxy, "CanGoPrevious")),
            canRaise: Boolean(this._getProp(this._rootProxy, "CanRaise")),
            canQuit: Boolean(this._getProp(this._rootProxy, "CanQuit"))
        };
        this._emit(state);
    }
    _getAppName() {
        try {
            const identity = this._getProp(this._rootProxy, "Identity");
            if (identity) return String(identity);
        } catch (e) {
            this._logger.warn?.("Identity read failed:", e.message);
        }
        if (this._currentBusName?.startsWith(MPRIS_PREFIX)) {
            return this._currentBusName.slice(MPRIS_PREFIX.length).split(".")[0];
        }
        return this._currentBusName ?? "";
    }
    _variantToJS(value) {
        if (value && typeof value.deep_unpack === "function") {
            value = value.deep_unpack();
        }
        if (Array.isArray(value)) {
            return value.map(v => this._variantToJS(v));
        }
        if (value && typeof value === "object") {
            const obj = {};
            for (const [k, v] of Object.entries(value)) {
                obj[k] = this._variantToJS(v);
            }
            return obj;
        }
        return value;
    }
}