import Gio from "gi://Gio";

import GLib from "gi://GLib";

import Soup from "gi://Soup?version=3.0";

const DBUS_NAME = "org.freedesktop.DBus";

const DBUS_PATH = "/org/freedesktop/DBus";

const DBUS_IFACE = "org.freedesktop.DBus";

const MPRIS_PREFIX = "org.mpris.MediaPlayer2.";

const MPRIS_PATH = "/org/mpris/MediaPlayer2";

const MPRIS_ROOT_IFACE = "org.mpris.MediaPlayer2";

const MPRIS_PLAYER_IFACE = "org.mpris.MediaPlayer2.Player";

const ART_CACHE_SUBDIR = [ "gnome-widget-center", "media-art" ];

const ART_FAILURE_RETRY_MS = 30000;

const ART_CACHE_MAX_FILES = 300;

export class MprisMediaService {
    constructor(logger = console) {
        this._logger = logger;
        this._dbusProxy = null;
        this._rootProxy = null;
        this._nameOwnerChangedId = null;
        this._playerProxy = null;
        this._currentBusName = null;
        this._onUpdate = null;
        this._state = null;
        this._disposed = false;
        this._httpSession = null;
        this._artCacheDir = null;
        this._artCache = new Map();
        this._artFailures = new Map();
        this._pendingArtDownloads = new Set();
        this._artDownloadCount = 0;
        this._players = new Map();
        this._attaching = new Set();
        this._activeBusName = null;
        this._manualBusName = null;
        this._filterMode = 0;
        this._filterList = [];
        this._lastActionTime = 0;
        this._lockWindowUs = 3000 * 1000;
    }
    get isAttached() {
        return this._activeBusName !== null;
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
            if (newOwner && !this._players.has(name)) {
                this._attachToPlayer(name);
            } else if (!newOwner && this._players.has(name)) {
                this._detachPlayer(name);
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
        for (const busName of Array.from(this._players.keys())) {
            this._detachPlayerSilently(busName);
        }
        this._players.clear();
        this._activeBusName = null;
        this._manualBusName = null;
        this._playerProxy = null;
        this._rootProxy = null;
        this._currentBusName = null;
        this._state = null;
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
        this._lastActionTime = GLib.get_monotonic_time();
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
    listPlayers() {
        return Array.from(this._players.entries()).map(([busName, entry]) => ({
            busName,
            appName: this._getProp(entry.rootProxy, "Identity") || (busName.startsWith(MPRIS_PREFIX) ? busName.slice(MPRIS_PREFIX.length).split(".")[0] : busName),
            status: this._getProp(entry.proxy, "PlaybackStatus") || "Stopped",
            isActive: busName === this._activeBusName
        }));
    }
    selectPlayer(busName) {
        if (busName && !this._players.has(busName)) return;
        this._manualBusName = busName || null;
        this._reevaluateActive();
    }
    clearPlayerSelection() {
        this._manualBusName = null;
        this._reevaluateActive();
    }
    switchPlayer(step = 1) {
        const busNames = Array.from(this._players.keys());
        if (busNames.length < 2) return;
        const currentIndex = Math.max(0, busNames.indexOf(this._activeBusName));
        const nextIndex = (currentIndex + step + busNames.length) % busNames.length;
        this.selectPlayer(busNames[nextIndex]);
    }
    setPlayerFilter(mode, list = []) {
        this._filterMode = mode === 1 || mode === 2 ? mode : 0;
        this._filterList = Array.isArray(list) ? list.map(s => String(s).toLowerCase().trim()).filter(Boolean) : [];
        this._reevaluateActive();
    }
    _findExistingPlayer() {
        if (this._disposed || !this._dbusProxy) return;
        this._dbusProxy.call("ListNames", null, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
            if (this._disposed) return;
            try {
                const result = proxy.call_finish(res);
                const [names] = result.deep_unpack();
                const mprisNames = names.filter(n => n.startsWith(MPRIS_PREFIX));
                for (const name of mprisNames) this._attachToPlayer(name);
                if (mprisNames.length === 0) this._reevaluateActive();
            } catch (e) {
                this._logger.warn?.("ListNames failed:", e.message);
                this._reevaluateActive();
            }
        });
    }
    async _attachToPlayer(busName) {
        if (this._disposed || this._players.has(busName) || this._attaching.has(busName)) return;
        this._attaching.add(busName);
        try {
            const playerProxy = await this._createProxy(busName, MPRIS_PATH, MPRIS_PLAYER_IFACE);
            const rootProxy = await this._createProxy(busName, MPRIS_PATH, MPRIS_ROOT_IFACE);
            if (this._disposed || this._players.has(busName)) return;
            const entry = {
                proxy: playerProxy,
                rootProxy: rootProxy,
                lastPlayingTime: 0,
                propsChangedId: null,
                seekedId: null
            };
            entry.propsChangedId = playerProxy.connect("g-properties-changed", (_proxy, changed, invalidated) => {
                this._onPlayerPropsChanged(busName, changed, invalidated);
            });
            entry.seekedId = playerProxy.connectSignal("Seeked", (_p, _s, [positionUs]) => {
                if (this._disposed || busName !== this._activeBusName || !this._state) return;
                this._state.positionMs = this._safeNumber(Number(positionUs) / 1e3);
                this._onUpdate?.(this._state);
            });
            this._players.set(busName, entry);
            if (this._getProp(playerProxy, "PlaybackStatus") === "Playing") {
                entry.lastPlayingTime = GLib.get_monotonic_time();
            }
            this._reevaluateActive();
        } catch (e) {
            if (!this._disposed) {
                this._logger.warn?.("attach failed:", e.message);
            }
        } finally {
            this._attaching.delete(busName);
        }
    }
    _onPlayerPropsChanged(busName, changed, invalidated) {
        const entry = this._players.get(busName);
        if (!entry || this._disposed) return;
        if (changed) {
            const count = changed.n_children();
            for (let i = 0; i < count; i++) {
                const child = changed.get_child_value(i);
                const key = child.get_child_value(0).get_string()[0];
                const value = child.get_child_value(1).get_variant();
                entry.proxy.set_cached_property(key, value);
            }
        }
        const finish = () => {
            if (this._getProp(entry.proxy, "PlaybackStatus") === "Playing") {
                entry.lastPlayingTime = GLib.get_monotonic_time();
            }
            this._reevaluateActive();
        };
        if (invalidated && invalidated.length > 0) {
            this._refreshPlayerProps(busName).then(finish);
        } else {
            finish();
        }
    }
    _refreshPlayerProps(busName) {
        const entry = this._players.get(busName);
        if (!entry || this._disposed) return Promise.resolve();
        const params = new GLib.Variant("(s)", [ MPRIS_PLAYER_IFACE ]);
        return new Promise(resolve => {
            entry.proxy.call("org.freedesktop.DBus.Properties.GetAll", params, Gio.DBusCallFlags.NONE, -1, null, (proxy, res) => {
                if (this._disposed || !this._players.has(busName)) {
                    resolve();
                    return;
                }
                try {
                    const dict = proxy.call_finish(res).get_child_value(0);
                    const count = dict.n_children();
                    for (let i = 0; i < count; i++) {
                        const child = dict.get_child_value(i);
                        const key = child.get_child_value(0).get_string()[0];
                        const value = child.get_child_value(1).get_variant();
                        entry.proxy.set_cached_property(key, value);
                    }
                } catch (e) {
                    if (!this._disposed) this._logger.warn?.("Properties.GetAll refresh failed:", e.message);
                }
                resolve();
            });
        });
    }
    _isPlayerAllowed(busName, entry, metadataObj) {
        if (this._filterMode === 0 || this._filterList.length === 0) return true;
        const identity = String(this._getProp(entry.rootProxy, "Identity") ?? "").toLowerCase();
        const nameFragment = (busName.startsWith(MPRIS_PREFIX) ? busName.slice(MPRIS_PREFIX.length).split(".")[0] : busName).toLowerCase();
        const url = String(metadataObj?.["xesam:url"] ?? "").toLowerCase();
        const haystacks = [ identity, nameFragment, url ];
        const matches = this._filterList.some(item => haystacks.some(h => h.includes(item)));
        return this._filterMode === 1 ? !matches : matches;
    }
    _hasTitle(metadataObj) {
        const title = metadataObj?.["xesam:title"];
        return typeof title === "string" ? title.trim().length > 0 : false;
    }
    _reevaluateActive() {
        if (this._disposed) return;
        if (this._players.size === 0) {
            this._setActivePlayer(null);
            return;
        }
        if (this._manualBusName && this._players.has(this._manualBusName)) {
            this._setActivePlayer(this._manualBusName);
            return;
        }
        const now = GLib.get_monotonic_time();
        if (this._activeBusName && this._players.has(this._activeBusName) && now - this._lastActionTime < this._lockWindowUs) {
            this._emitFromProxy();
            return;
        }
        const candidates = [];
        for (const [busName, entry] of this._players) {
            const status = this._getProp(entry.proxy, "PlaybackStatus") ?? "Stopped";
            const metadataObj = this._variantToJS(entry.proxy.get_cached_property("Metadata")) ?? {};
            const hasTitle = this._hasTitle(metadataObj);
            const allowed = this._isPlayerAllowed(busName, entry, metadataObj);
            let score = -1;
            if (allowed) {
                if (status === "Playing" && hasTitle) score = 500;
                else if (status === "Paused" && hasTitle) score = 100;
                else score = 0;
            }
            candidates.push({ busName, score, status, hasTitle, lastPlayingTime: entry.lastPlayingTime });
        }
        const allowed = candidates.filter(c => c.score >= 0);
        if (allowed.length === 0) {
            this._setActivePlayer(null);
            return;
        }
        allowed.sort((a, b) => b.score - a.score || b.lastPlayingTime - a.lastPlayingTime);
        let winner = allowed[0];
        if (winner.status !== "Playing") {
            const anyPlaying = allowed.find(c => c.status === "Playing" && c.hasTitle);
            if (anyPlaying) winner = anyPlaying;
        }
        this._setActivePlayer(winner.busName);
    }
    _setActivePlayer(busName) {
        if (this._activeBusName === busName) {
            this._emitFromProxy();
            return;
        }
        const entry = busName ? this._players.get(busName) : null;
        this._activeBusName = entry ? busName : null;
        this._playerProxy = entry?.proxy ?? null;
        this._rootProxy = entry?.rootProxy ?? null;
        this._currentBusName = this._activeBusName;
        this._emitFromProxy();
    }
    _detachPlayerSilently(busName) {
        const entry = this._players.get(busName);
        if (!entry) return;
        if (entry.propsChangedId !== null) entry.proxy.disconnect(entry.propsChangedId);
        if (entry.seekedId !== null) entry.proxy.disconnectSignal(entry.seekedId);
    }
    _detachPlayer(busName) {
        this._detachPlayerSilently(busName);
        if (!this._players.has(busName)) return;
        this._players.delete(busName);
        if (this._manualBusName === busName) this._manualBusName = null;
        if (this._activeBusName === busName) {
            this._activeBusName = null;
            this._playerProxy = null;
            this._rootProxy = null;
            this._currentBusName = null;
        }
        this._reevaluateActive();
    }
    _call(method) {
        if (!this._playerProxy || this._disposed) return;
        this._lastActionTime = GLib.get_monotonic_time();
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
        this._lastActionTime = GLib.get_monotonic_time();
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
        const trackId = String(metadata["mpris:trackid"] ?? "");
        const artUrl = this._resolveArtUrl(rawArtUrl, trackId, this._state?.artUrl ?? "");
        const artistRaw = metadata["xesam:artist"];
        const artist = Array.isArray(artistRaw) ? artistRaw.map(String).join(", ") : typeof artistRaw === "string" ? artistRaw : "";
        const state = {
            title: String(metadata["xesam:title"] ?? "Unknown title"),
            artist: artist,
            album: String(metadata["xesam:album"] ?? ""),
            status: String(this._getProp(this._playerProxy, "PlaybackStatus") ?? "Stopped"),
            artUrl: artUrl,
            lengthMs: this._safeNumber(metadata["mpris:length"]) / 1e3,
            positionMs: this._safeNumber(this._getProp(this._playerProxy, "Position")) / 1e3,
            volume: this._safeNumber(this._getProp(this._playerProxy, "Volume")),
            shuffle: Boolean(this._getProp(this._playerProxy, "Shuffle")),
            loopStatus: String(this._getProp(this._playerProxy, "LoopStatus") ?? "None"),
            appName: this._getAppName(),
            busName: this._currentBusName ?? "",
            trackId: trackId,
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
    _resolveArtUrl(rawArtUrl, trackId, previousArtUrl = "") {
        if (!rawArtUrl) return "";
        if (!rawArtUrl.startsWith("http://") && !rawArtUrl.startsWith("https://")) {
            return rawArtUrl;
        }
        const cached = this._artCache.get(rawArtUrl);
        if (cached) return cached;
        const failedAt = this._artFailures.get(rawArtUrl);
        if (failedAt && GLib.get_monotonic_time() / 1000 - failedAt < ART_FAILURE_RETRY_MS) {
            return "";
        }
        this._downloadArt(rawArtUrl, trackId);
        return previousArtUrl;
    }
    _getHttpSession() {
        if (!this._httpSession) this._httpSession = new Soup.Session();
        return this._httpSession;
    }
    _ensureArtCacheDir() {
        if (!this._artCacheDir) {
            this._artCacheDir = GLib.build_filenamev([ GLib.get_user_cache_dir(), ...ART_CACHE_SUBDIR ]);
            GLib.mkdir_with_parents(this._artCacheDir, 0o755);
        }
        return this._artCacheDir;
    }
    _downloadArt(rawArtUrl, trackId) {
        if (this._pendingArtDownloads.has(rawArtUrl)) return;
        this._pendingArtDownloads.add(rawArtUrl);
        const hash = GLib.compute_checksum_for_string(GLib.ChecksumType.MD5, rawArtUrl, -1);
        const destPath = GLib.build_filenamev([ this._ensureArtCacheDir(), `${hash}.img` ]);
        const destFile = Gio.File.new_for_path(destPath);
        if (destFile.query_exists(null)) {
            this._pendingArtDownloads.delete(rawArtUrl);
            this._artFailures.delete(rawArtUrl);
            this._artCache.set(rawArtUrl, destFile.get_uri());
            this._reemitIfCurrentTrack(trackId);
            return;
        }
        (async () => {
            try {
                const session = this._getHttpSession();
                const message = Soup.Message.new("GET", rawArtUrl);
                if (!message) throw new Error(`invalid art URL: ${rawArtUrl}`);
                const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
                if (this._disposed) return;
                if (message.get_status() !== Soup.Status.OK || !bytes || bytes.get_size() === 0) {
                    throw new Error(`HTTP ${message.get_status()} for art`);
                }
                const outStream = destFile.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                outStream.write_bytes(bytes, null);
                outStream.close(null);
                this._artFailures.delete(rawArtUrl);
                this._artCache.set(rawArtUrl, destFile.get_uri());
                this._artDownloadCount++;
                if (this._artDownloadCount % 20 === 0) this._pruneArtCache();
                this._reemitIfCurrentTrack(trackId);
            } catch (e) {
                if (!this._disposed) {
                    this._logger.warn?.("art download failed:", e.message);
                    this._artFailures.set(rawArtUrl, GLib.get_monotonic_time() / 1000);
                }
            } finally {
                this._pendingArtDownloads.delete(rawArtUrl);
            }
        })();
    }
    _reemitIfCurrentTrack(trackId) {
        if (this._disposed || !this._playerProxy) return;
        if (this._state && this._state.trackId === trackId) {
            this._emitFromProxy();
        }
    }
    _pruneArtCache() {
        try {
            const dirPath = this._ensureArtCacheDir();
            const dir = Gio.File.new_for_path(dirPath);
            const enumerator = dir.enumerate_children("standard::name,time::modified", Gio.FileQueryInfoFlags.NONE, null);
            const entries = [];
            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                entries.push({
                    name: info.get_name(),
                    mtime: info.get_modification_date_time()?.to_unix() ?? 0
                });
            }
            enumerator.close(null);
            if (entries.length <= ART_CACHE_MAX_FILES) return;
            entries.sort((a, b) => a.mtime - b.mtime);
            for (const entry of entries.slice(0, entries.length - ART_CACHE_MAX_FILES)) {
                try {
                    Gio.File.new_for_path(GLib.build_filenamev([ dirPath, entry.name ])).delete(null);
                } catch (e) { }
            }
        } catch (e) {
            this._logger.warn?.("art cache prune failed:", e.message);
        }
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