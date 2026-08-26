import St from "gi://St";

import Clutter from "gi://Clutter";

import GLib from "gi://GLib";

import Gio from "gi://Gio";

import { SystemMetricsService } from "../../lib/systemMetricsApi.js";

import { SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor, TEXT_SHADOW_DEFAULTS, textShadowCss as _textShadowCss, cardStyleCss as _cardStyleCss, BORDER_DEFAULTS, OPACITY_DEFAULTS } from "../../lib/widgetVisualKit.js";

import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";

import {configJsonDefaults} from '../../lib/widgetConfigDefaults.js';
const REFRESH_INTERVAL_SECONDS = 30;

const CARD_PADDING = 16;

const DISTRO_KEYS = [ "alpine", "android", "arch", "armbian", "buildroot", "bunsenlabs", "centos", "crunchbang", "darwin", "debian", "devuan", "elementary", "endeavouros", "enso", "fedora", "freebsd", "gentoo", "guix", "kali", "linux", "linuxmint", "manjaro", "moevalent", "netbsd", "nixos", "nobara", "openbsd", "opensuse", "parabola", "pop", "quirinux", "raspbian", "rhel", "rocky", "siduction", "slackware", "ubuntu", "univalent", "windows" ];

const DISTRO_ID_ALIASES = {
    "opensuse-leap": "opensuse",
    "opensuse-tumbleweed": "opensuse",
    suse: "opensuse",
    sles: "opensuse",
    ol: "rhel",
    rhel: "rhel",
    almalinux: "rocky",
    mint: "linuxmint",
    artix: "arch"
};

const ROW_DEFS = [ [ "os", "OS", "#61afef" ], [ "host", "Host", "#c678dd" ], [ "kernel", "Kernel", "#98c379" ], [ "uptime", "Uptime", "#e5c07b" ], [ "packages", "Packages", "#56b6c2" ], [ "shell", "Shell", "#d19a66" ], [ "resolution", "Resolution", "#e06c75" ], [ "de", "DE", "#bb9af7" ], [ "cpu", "CPU", "#f7768e" ], [ "gpu", "GPU", "#9ece6a" ], [ "memory", "Memory", "#7aa2f7" ] ];

const PALETTE_COLORS = [ "#1a1b26", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#a9b1d6", "#414868", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5" ];

const GENERIC_ART = {
    color: "#8be9fd",
    art: [ "     .--.", "    ( oo )", "     |==|", "    /|  |\\", "   ^ '--' ^", "", "   L I N U X" ]
};

function _markupEscape(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function _logoLineToMarkup(line, colors) {
    let markup = "";
    let currentColor = null;
    let openSpan = false;
    const re = /\{c\[(\d+)\]\}|([^{]+)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
        if (match[1] !== undefined) {
            const color = colors[Number(match[1])] ?? colors[0] ?? "#ffffff";
            if (color !== currentColor) {
                if (openSpan) markup += "</span>";
                markup += `<span foreground="${color}">`;
                currentColor = color;
                openSpan = true;
            }
        } else {
            markup += _markupEscape(match[2]);
        }
    }
    if (openSpan) markup += "</span>";
    return markup;
}

export default class GeekArcheySystechBayWidget {
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService;
        this._info = {};
        this._timerId = null;
        this._cancellable = null;
        this._logoDistroKey = null;
        this._logoModule = null;
        this._logoLoadToken = 0;
    }
    buildActor() {
        this._layers = createLayeredCard({
            contentStyleClass: "geek-archey-systech-bay-root"
        });
        this._actor = this._layers.root;
        this._actor.x_align = Clutter.ActorAlign.CENTER;
        this._actor.y_align = Clutter.ActorAlign.CENTER;
        const content = new St.BoxLayout({
            vertical: false
        });
        content.set_style(`padding: ${CARD_PADDING}px;`);
        this._layers.content.add_child(content);
        this._asciiLabel = new St.Label({
            style_class: "geek-archey-systech-bay-ascii"
        });
        this._asciiLabel.clutter_text.set_use_markup(true);
        this._asciiLabel.clutter_text.set_line_wrap(false);
        content.add_child(this._asciiLabel);
        const infoBox = new St.BoxLayout({
            vertical: true,
            style_class: "geek-archey-systech-bay-info"
        });
        infoBox.set_style("margin-left: 18px;");
        this._headerLabel = new St.Label({
            style_class: "geek-archey-systech-bay-header"
        });
        infoBox.add_child(this._headerLabel);
        this._sepLabel = new St.Label({
            style_class: "geek-archey-systech-bay-sep"
        });
        infoBox.add_child(this._sepLabel);
        this._rows = {};
        for (const [key, label, color] of ROW_DEFS) {
            const row = new St.BoxLayout({
                vertical: false,
                style_class: "geek-archey-systech-bay-row"
            });
            const bullet = new St.Label({
                text: "■",
                style_class: "geek-archey-systech-bay-bullet"
            });
            const value = new St.Label({
                style_class: "geek-archey-systech-bay-value"
            });
            row.add_child(bullet);
            row.add_child(value);
            infoBox.add_child(row);
            this._rows[key] = {
                bullet: bullet,
                value: value,
                label: label,
                color: color
            };
        }
        this._paletteRow = new St.BoxLayout({
            vertical: false,
            style_class: "geek-archey-systech-bay-palette"
        });
        this._paletteRow.set_style("margin-top: 6px;");
        this._paletteSwatches = PALETTE_COLORS.map(() => {
            const swatch = new St.Widget({
                style_class: "geek-archey-systech-bay-swatch"
            });
            swatch.set_style("width: 12px; height: 12px; margin-right: 3px; border-radius: 2px;");
            this._paletteRow.add_child(swatch);
            return swatch;
        });
        infoBox.add_child(this._paletteRow);
        content.add_child(infoBox);
        this._render();
        return this._actor;
    }
    enable() {
        this._cancellable = new Gio.Cancellable;
        this._ensureDistroDetected();
        this._loadLogo(this._settings.distro ?? "linux");
        this._fetchStaticInfo();
        this._updateDynamicInfo();
        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_INTERVAL_SECONDS, () => {
            this._updateDynamicInfo();
            return GLib.SOURCE_CONTINUE;
        });
    }
    disable() {
        if (this._timerId !== null) {
            GLib.source_remove(this._timerId);
            this._timerId = null;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
    }
    getDefaultSettings() {
        return {
            ...configJsonDefaults(import.meta.url),
            ...SHADOW_DEFAULTS,
            ...BORDER_DEFAULTS,
            ...OPACITY_DEFAULTS,
            ...TEXT_SHADOW_DEFAULTS,
            textShadowEnabled: false,
            distroDetected: false,
        };
    }
    onSettingsChanged() {
        const distroKey = this._settings.distro ?? "linux";
        if (distroKey !== this._logoDistroKey) this._loadLogo(distroKey);
        this._render();
        this._fetchStaticInfo();
    }
    _ensureDistroDetected() {
        if (this._settings.distroDetected) return;
        this._settings.distro = this._detectLinuxDistro();
        this._settings.distroDetected = true;
        this._api.saveSettings?.(this._settings);
    }
    _detectLinuxDistro() {
        try {
            const [ok, contents] = GLib.file_get_contents("/etc/os-release");
            if (!ok) return "linux";
            const text = (new TextDecoder).decode(contents);
            const clean = v => (v ?? "").trim().replace(/^"|"$/g, "");
            const id = clean(text.match(/^ID=(.*)$/m)?.[1]);
            const idLike = clean(text.match(/^ID_LIKE=(.*)$/m)?.[1]);
            const candidates = [ id, ...idLike.split(/\s+/) ].filter(Boolean);
            for (const candidate of candidates) {
                const key = DISTRO_ID_ALIASES[candidate] ?? candidate;
                if (DISTRO_KEYS.includes(key)) return key;
            }
            return "linux";
        } catch (e) {
            return "linux";
        }
    }
    _loadLogo(distroKey) {
        const token = ++this._logoLoadToken;
        const key = distroKey === "generic" ? null : distroKey;
        const applyFallback = () => {
            if (token !== this._logoLoadToken) return;
            this._logoDistroKey = distroKey;
            this._logoModule = null;
            this._render();
        };
        if (!key) {
            applyFallback();
            return;
        }
        import(`./logos/${key}.js`).then(module => {
            if (token !== this._logoLoadToken) return;
            this._logoDistroKey = distroKey;
            this._logoModule = module;
            this._render();
        }).catch(e => {
            logError(e, `geek-archey-systech-bay: failed to load logo for "${distroKey}"`);
            applyFallback();
        });
    }
    _render() {
        applyLayeredCardStyle(this._layers, this._settings, {
            cornerRadiusFallback: 18
        }, false);
        let accent = GENERIC_ART.color;
        let markup;
        if (this._logoModule) {
            const variant = this._logoModule.default;
            accent = variant.colors[0] ?? GENERIC_ART.color;
            markup = variant.logo.map(line => _logoLineToMarkup(line, variant.colors)).join("\n");
        } else {
            accent = GENERIC_ART.color;
            markup = _markupEscape(GENERIC_ART.art.join("\n"));
        }
        this._asciiLabel.set_style(`font-family: monospace; font-size: 9px; line-height: 1.2; color: ${accent}; white-space: pre;`);
        this._asciiLabel.clutter_text.set_markup(markup);
        const user = GLib.get_user_name();
        const host = GLib.get_host_name();
        const textShadow = _textShadowCss(this._settings);
        this._headerLabel.set_style(`font-family: monospace; font-size: 13px; font-weight: bold; color: #ffffff;`);
        this._headerLabel.text = `${user}@${host}`;
        this._sepLabel.set_style(`font-family: monospace; font-size: 11px; color: ${accent}; margin-bottom: 4px;`);
        this._sepLabel.text = "─".repeat(Math.max(user.length + host.length + 1, 10));
        for (const [key, {bullet: bullet, value: value, label: label, color: color}] of Object.entries(this._rows)) {
            bullet.set_style(`font-family: monospace; font-size: 11px; color: ${color}; margin-right: 6px;`);
            value.set_style(`font-family: monospace; font-size: 11px; color: #e5e5e5;`);
            value.text = `${label}: ${this._info[key] ?? "…"}`;
        }
        const showColorPalette = this._settings.showColorPalette ?? true;
        this._paletteRow.visible = showColorPalette;
        if (showColorPalette) {
            this._paletteSwatches.forEach((swatch, i) => {
                const hex = PALETTE_COLORS[i] ?? "#000000";
                swatch.set_style(`background-color: ${hex}; width: 12px; height: 12px; margin-right: 3px; border-radius: 2px;`);
            });
        }
    }
    _fetchStaticInfo() {
        this._info.os = this._readOsPrettyName();
        this._info.kernel = this._readKernelVersion();
        this._info.host = this._readHostProduct() ?? GLib.get_host_name();
        this._info.cpu = this._readCpuModel();
        this._info.shell = this._readShellName();
        this._info.resolution = this._readResolution();
        this._info.de = GLib.getenv("XDG_CURRENT_DESKTOP") ?? "GNOME";
        this._render();
        const distroKey = this._settings.distro ?? "linux";
        this._runCommandAsync(this._packageCommand(distroKey)).then(out => {
            const count = parseInt(out, 10);
            this._info.packages = Number.isFinite(count) ? String(count) : "Unknown";
            this._render();
        });
        this._runCommandAsync([ "bash", "-lc", "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -n1 | sed -E 's/^[^:]+: //'" ]).then(out => {
            this._info.gpu = out || "Unknown";
            this._render();
        });
        const shellPath = GLib.getenv("SHELL") ?? "/bin/bash";
        this._runCommandAsync([ shellPath, "--version" ]).then(out => {
            const match = out.match(/(\d+\.\d+(?:\.\d+)?)/);
            if (match) this._info.shell = `${this._readShellName()} ${match[1]}`;
            this._render();
        });
    }
    _updateDynamicInfo() {
        this._info.uptime = this._formatUptime(this._readUptimeSeconds());
        const {totalKb: totalKb, usedKb: usedKb} = this._metrics.getMemoryUsage();
        this._info.memory = `${this._formatGb(usedKb)}/${this._formatGb(totalKb)}`;
        this._render();
    }
    _packageCommand(distroKey) {
        const PACMAN = [ "bash", "-lc", "pacman -Qq 2>/dev/null | wc -l" ];
        const DPKG = [ "bash", "-lc", "dpkg -l 2>/dev/null | grep -c '^ii'" ];
        const RPM = [ "bash", "-lc", "rpm -qa 2>/dev/null | wc -l" ];
        const APK = [ "bash", "-lc", "apk info 2>/dev/null | wc -l" ];
        const ZYPPER = [ "bash", "-lc", "rpm -qa 2>/dev/null | wc -l" ];
        const PORTAGE = [ "bash", "-lc", "qlist -I 2>/dev/null | wc -l" ];
        const NIX = [ "bash", "-lc", "nix-store -q --requisites /run/current-system/sw 2>/dev/null | wc -l" ];
        const GUIX = [ "bash", "-lc", "guix package --list-installed 2>/dev/null | wc -l" ];
        const PKG_BSD = [ "bash", "-lc", "pkg info 2>/dev/null | wc -l" ];
        const SLACKPKG = [ "bash", "-lc", "ls /var/log/packages 2>/dev/null | wc -l" ];
        const GENERIC = [ "bash", "-lc", "if command -v pacman >/dev/null; then pacman -Qq | wc -l; " + "elif command -v dpkg >/dev/null; then dpkg -l | grep -c '^ii'; " + "elif command -v rpm >/dev/null; then rpm -qa | wc -l; " + "elif command -v apk >/dev/null; then apk info | wc -l; " + "elif command -v guix >/dev/null; then guix package --list-installed | wc -l; " + "elif command -v nix-store >/dev/null; then nix-store -q --requisites /run/current-system/sw | wc -l; " + "elif command -v pkg >/dev/null; then pkg info | wc -l; " + "else echo 0; fi" ];
        const ARCH_BASED = [ "arch", "manjaro", "endeavouros" ];
        const DEBIAN_BASED = [ "debian", "ubuntu", "linuxmint", "pop", "devuan", "kali", "raspbian", "bunsenlabs", "crunchbang", "siduction", "quirinux", "elementary", "armbian" ];
        const RPM_BASED = [ "fedora", "centos", "rhel", "rocky", "nobara" ];
        if (ARCH_BASED.includes(distroKey)) return PACMAN;
        if (DEBIAN_BASED.includes(distroKey)) return DPKG;
        if (RPM_BASED.includes(distroKey)) return RPM;
        switch (distroKey) {
          case "alpine":
            return APK;

          case "opensuse":
            return ZYPPER;

          case "gentoo":
            return PORTAGE;

          case "nixos":
            return NIX;

          case "guix":
            return GUIX;

          case "freebsd":
          case "netbsd":
          case "openbsd":
            return PKG_BSD;

          case "slackware":
            return SLACKPKG;

          case "darwin":
          case "windows":
          case "android":
          case "linux":
          case "buildroot":
          case "enso":
          case "moevalent":
          case "univalent":
          case "parabola":
          default:
            return GENERIC;
        }
    }
    _runCommandAsync(argv) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, this._cancellable, (source, res) => {
                    try {
                        const [, stdout] = source.communicate_utf8_finish(res);
                        resolve((stdout ?? "").trim());
                    } catch (e) {
                        resolve("");
                    }
                });
            } catch (e) {
                resolve("");
            }
        });
    }
    _readOsPrettyName() {
        try {
            const [ok, contents] = GLib.file_get_contents("/etc/os-release");
            if (!ok) return "Linux";
            const text = (new TextDecoder).decode(contents);
            const match = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
            return match ? match[1] : "Linux";
        } catch (e) {
            return "Linux";
        }
    }
    _readKernelVersion() {
        try {
            const [ok, contents] = GLib.file_get_contents("/proc/sys/kernel/osrelease");
            return ok ? (new TextDecoder).decode(contents).trim() : "Unknown";
        } catch (e) {
            return "Unknown";
        }
    }
    _readHostProduct() {
        try {
            const [ok, contents] = GLib.file_get_contents("/sys/class/dmi/id/product_name");
            const text = ok ? (new TextDecoder).decode(contents).trim() : "";
            return text || null;
        } catch (e) {
            return null;
        }
    }
    _readCpuModel() {
        try {
            const [ok, contents] = GLib.file_get_contents("/proc/cpuinfo");
            if (!ok) return "Unknown";
            const text = (new TextDecoder).decode(contents);
            const match = text.match(/^model name\s*:\s*(.+)$/m);
            return match ? match[1].replace(/\s+/g, " ").trim() : "Unknown";
        } catch (e) {
            return "Unknown";
        }
    }
    _readShellName() {
        const shellPath = GLib.getenv("SHELL");
        if (!shellPath) return "Unknown";
        return shellPath.split("/").pop();
    }
    _readResolution() {
        try {
            const monitorIndex = global.display.get_primary_monitor();
            const geometry = global.display.get_monitor_geometry(monitorIndex);
            return `${geometry.width}x${geometry.height}`;
        } catch (e) {
            return "Unknown";
        }
    }
    _readUptimeSeconds() {
        try {
            const [ok, contents] = GLib.file_get_contents("/proc/uptime");
            if (!ok) return 0;
            const text = (new TextDecoder).decode(contents);
            return parseFloat(text.split(" ")[0]) || 0;
        } catch (e) {
            return 0;
        }
    }
    _formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor(seconds % 86400 / 3600);
        const minutes = Math.floor(seconds % 3600 / 60);
        const parts = [];
        if (days > 0) parts.push(`${days}d`);
        if (days > 0 || hours > 0) parts.push(`${hours}h`);
        parts.push(`${minutes}m`);
        return parts.join(" ");
    }
    _formatGb(kb) {
        const gb = kb / 1024 / 1024;
        return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`;
    }
}