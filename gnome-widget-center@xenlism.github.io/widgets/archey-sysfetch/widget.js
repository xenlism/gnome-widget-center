// widgets/sysfetch/widget.js
//
// neofetch/archey4-style system info card (archey4 reference:
// https://github.com/HorlogeSkynet/archey4): a small ASCII distro mark on
// the left, "user@host" + a divider + a labeled stat list on the right -
// same field set archey4 reports by default (OS, Host, Kernel, Uptime,
// Packages, Shell, Resolution, DE, CPU, GPU, Memory).
//
// Root actor is an St.Bin (x_align/y_align CENTER), same
// force-sized-by-blockSizeManager / centered-content reasoning as
// widgets/folder-widget-2x2-1's file header - this widget doesn't need
// widgets/power-menu's FixedLayout-root trick since nothing here is a
// free-floating overlay (no tooltips).
//
// Where each stat actually comes from:
//   - OS         -> /etc/os-release's PRETTY_NAME
//   - Host       -> /sys/class/dmi/id/product_name, falling back to the
//                   hostname on hardware (VMs, some laptops) that doesn't
//                   expose a DMI product name
//   - Kernel     -> /proc/sys/kernel/osrelease
//   - Uptime     -> /proc/uptime
//   - Memory     -> lib/systemMetricsApi.js's SystemMetricsService - the
//                   same shared /proc/meminfo reader widgets/system-stats
//                   already uses, not a second hand-rolled parser
//   - CPU        -> /proc/cpuinfo's "model name"
//   - Shell      -> $SHELL's basename, `<shell> --version`'s first
//                   dotted-number match (best-effort - some shells don't
//                   support --version at all, in which case just the name
//                   is shown)
//   - Resolution -> global.display's primary-monitor geometry (this
//                   widget runs in the Shell process, same as
//                   lib/dragController.js's own use of the `global`
//                   singleton - see that file for precedent)
//   - Desktop    -> $XDG_CURRENT_DESKTOP, falling back to "GNOME" since
//                   this extension only runs under GNOME Shell anyway
//   - Packages   -> an external package-manager query, picked by the
//                   "distro" setting (see _packageCommand()) - the ONE
//                   stat above that can't come from a plain file read
//   - GPU        -> `lspci`, filtered to the VGA/3D/display controller
//                   line
//
// Packages/GPU/shell-version need an external command, so - per this
// project's own "no polling of its own" / "never block the Shell's main
// loop" rules (see systemMetricsApi.js's file header for the general
// principle) - those three run through Gio.Subprocess's ASYNC
// communicate_utf8_async(), never the sync communicate_utf8() a
// backupService.js-style helper would use; that's fine for a one-shot
// backup/restore action but would freeze the compositor if used here.
//
// Everything except uptime/memory is effectively static for a session,
// so it's fetched once (in enable(), and again whenever the "distro"
// setting changes what package manager to query) and cached in
// this._info; only uptime/memory re-sample on a timer.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {SystemMetricsService} from '../../lib/systemMetricsApi.js';
import {SHADOW_DEFAULTS, shadowBoxShadowCss as _shadowBoxShadowCss, toCssColor as _toCssColor} from '../../lib/widgetVisualKit.js';

const REFRESH_INTERVAL_SECONDS = 30;
const CARD_PADDING = 16;

// Every distro key that has a matching ./logos/<key>.js module (kept in
// sync with config.json's dropdown options and the logos/ directory).
// Used by _detectLinuxDistro() to validate a /etc/os-release guess
// before trusting it, and as the ultimate "linux" fallback.
const DISTRO_KEYS = [
    'alpine', 'android', 'arch', 'armbian', 'buildroot', 'bunsenlabs',
    'centos', 'crunchbang', 'darwin', 'debian', 'devuan', 'elementary',
    'endeavouros', 'enso', 'fedora', 'freebsd', 'gentoo', 'guix', 'kali',
    'linux', 'linuxmint', 'manjaro', 'moevalent', 'netbsd', 'nixos',
    'nobara', 'openbsd', 'opensuse', 'parabola', 'pop', 'quirinux',
    'raspbian', 'rhel', 'rocky', 'siduction', 'slackware', 'ubuntu',
    'univalent', 'windows',
];

// A few /etc/os-release `ID=`/`ID_LIKE=` values that don't spell their
// distro key the same way we do (or share one logo across near-clones).
const DISTRO_ID_ALIASES = {
    'opensuse-leap': 'opensuse',
    'opensuse-tumbleweed': 'opensuse',
    suse: 'opensuse',
    sles: 'opensuse',
    ol: 'rhel', // Oracle Linux
    rhel: 'rhel',
    almalinux: 'rocky', // closest available family logo
    mint: 'linuxmint',
    artix: 'arch',
};

// Display label + row-bullet color for each stat, in the same order
// archey4/neofetch conventionally show them (and the order the
// reference screenshot this widget was built from uses).
const ROW_DEFS = [
    ['os', 'OS', '#61afef'],
    ['host', 'Host', '#c678dd'],
    ['kernel', 'Kernel', '#98c379'],
    ['uptime', 'Uptime', '#e5c07b'],
    ['packages', 'Packages', '#56b6c2'],
    ['shell', 'Shell', '#d19a66'],
    ['resolution', 'Resolution', '#e06c75'],
    ['de', 'DE', '#bb9af7'],
    ['cpu', 'CPU', '#f7768e'],
    ['gpu', 'GPU', '#9ece6a'],
    ['memory', 'Memory', '#7aa2f7'],
];

// Fallback mark shown before a logo module has finished loading (or if
// loading one ever fails) - NOT copied from archey4's own logo files,
// just a same-spirit placeholder glyph. Real per-distro logos now live
// one-file-per-distro under ./logos/ (converted from archey4's own
// `archey/logos/*.py`) and are lazily `import()`-ed by _loadLogo() below,
// so only the currently-selected distro's logo module is ever loaded -
// see that method's comment for why.
const GENERIC_ART = {
    color: '#8be9fd',
    art: [
        '     .--.',
        '    ( oo )',
        '     |==|',
        '    /|  |\\',
        '   ^ \'--\' ^',
        '',
        '   L I N U X',
    ],
};

/** @private Escapes text for safe embedding inside Pango markup (used
 * when turning a logo module's `{c[N]}`-templated LOGO lines into
 * per-glyph colored <span> runs below). */
function _markupEscape(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/** @private Turns one archey4-style LOGO line (containing '{c[N]}' color
 * placeholders, as produced by the Python->JS logo conversion) into a
 * Pango markup string, wrapping each colored run in its own <span
 * foreground="..."> using the matching entry of `colors`. Mirrors what
 * archey4's own `str.format(c=...)` does for a terminal, just emitting
 * markup instead of ANSI escapes since St.Label renders via Pango. */
function _logoLineToMarkup(line, colors) {
    let markup = '';
    let currentColor = null;
    let openSpan = false;
    const re = /\{c\[(\d+)\]\}|([^{]+)/g;
    let match;
    while ((match = re.exec(line)) !== null) {
        if (match[1] !== undefined) {
            const color = colors[Number(match[1])] ?? colors[0] ?? '#ffffff';
            if (color !== currentColor) {
                if (openSpan)
                    markup += '</span>';
                markup += `<span foreground="${color}">`;
                currentColor = color;
                openSpan = true;
            }
        } else {
            markup += _markupEscape(match[2]);
        }
    }
    if (openSpan)
        markup += '</span>';
    return markup;
}

export default class SysfetchWidget {
    /**
     * @param {WidgetAPI} api - see development/docs/WIDGET_API.md §5.
     */
    constructor(api) {
        this._api = api;
        this._settings = api.settings;
        this._metrics = new SystemMetricsService();
        this._info = {}; // populated by _fetchStaticInfo()/_updateDynamicInfo()
        this._timerId = null;
        this._cancellable = null;

        // Logo state for _loadLogo() below: only ever holds the ONE
        // currently-selected distro's logo module (never a cache of all
        // of them) plus which distro key + variant it belongs to, so a
        // stale in-flight import() can't clobber a newer selection.
        this._logoDistroKey = null;
        this._logoModule = null;
        this._logoLoadToken = 0;
    }

    // Must never throw, even with empty settings, and must not depend on
    // enable() having run yet - this._info starts life as {} above, and
    // every row read below falls back to '…' until enable()'s fetches
    // land, same "never assume enable() already ran" rule
    // widgets/power-menu/widget.js's buildActor() follows for its DBus
    // proxies.
    buildActor() {
        this._actor = new St.Bin({
            style_class: 'sysfetch-root',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const content = new St.BoxLayout({vertical: false});

        this._asciiLabel = new St.Label({style_class: 'sysfetch-ascii'});
        this._asciiLabel.clutter_text.set_use_markup(true);
        this._asciiLabel.clutter_text.set_line_wrap(false);
        content.add_child(this._asciiLabel);

        const infoBox = new St.BoxLayout({vertical: true, style_class: 'sysfetch-info'});
        infoBox.set_style('margin-left: 18px;');

        this._headerLabel = new St.Label({style_class: 'sysfetch-header'});
        infoBox.add_child(this._headerLabel);

        this._sepLabel = new St.Label({style_class: 'sysfetch-sep'});
        infoBox.add_child(this._sepLabel);

        this._rows = {}; // key -> {bullet: St.Label, value: St.Label, label, color}
        for (const [key, label, color] of ROW_DEFS) {
            const row = new St.BoxLayout({vertical: false, style_class: 'sysfetch-row'});
            const bullet = new St.Label({text: '\u25A0', style_class: 'sysfetch-bullet'});
            const value = new St.Label({style_class: 'sysfetch-value'});
            row.add_child(bullet);
            row.add_child(value);
            infoBox.add_child(row);
            this._rows[key] = {bullet, value, label, color};
        }

        content.add_child(infoBox);
        this._actor.set_child(content);

        this._render();
        return this._actor;
    }

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._ensureDistroDetected();
        this._loadLogo(this._settings.distro ?? 'linux');
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
        // Aborts any in-flight package-manager/lspci/shell-version
        // subprocess so its (now-stale) result never lands after this
        // widget instance is gone - same reasoning
        // widgets/media-player/widget.js's MprisMediaService.stop() has
        // for outstanding DBus calls.
        this._cancellable?.cancel();
        this._cancellable = null;
    }

    getDefaultSettings() {
        return {
            ...SHADOW_DEFAULTS,
            distro: 'linux',
            // Set true once _detectLinuxDistro() has run and written its
            // guess into `distro` - keeps first-run auto-detection from
            // overwriting a distro the user later picked by hand.
            distroDetected: false,
            backgroundColor: '#00000026',
            cornerRadius: 18,
        };
    }

    // Re-render immediately so a color/radius/distro change in the
    // Control Center shows up right away (mirrors
    // widgets/folder-widget-2x2-1's onSettingsChanged). Distro also picks
    // which package-manager command Packages uses, so re-fetch the static
    // info too rather than leaving a stale count from the previous
    // distro on screen.
    onSettingsChanged() {
        const distroKey = this._settings.distro ?? 'linux';
        if (distroKey !== this._logoDistroKey)
            this._loadLogo(distroKey);
        this._render();
        this._fetchStaticInfo();
    }

    /** @private First-run only (guarded by the persisted `distroDetected`
     * flag, so this never overrides a distro the user picked by hand):
     * reads /etc/os-release and, if it maps to one of our DISTRO_KEYS,
     * sets that as the default `distro` setting. Falls back to plain
     * 'linux' whenever detection fails outright OR the detected distro
     * has no matching logo module - i.e. exactly the same GENERIC_ART /
     * "linux" mark every unmatched selection already renders. */
    _ensureDistroDetected() {
        if (this._settings.distroDetected)
            return;

        this._settings.distro = this._detectLinuxDistro();
        this._settings.distroDetected = true;
        // Best-effort persistence: this widget's other settings writes
        // all happen from the Control Center (via onSettingsChanged()),
        // so there's no precedent here for a widget-initiated save. If
        // WIDGET_API.md documents an explicit save call, wire it in;
        // until then this mutates the live settings object in place,
        // which is enough for the running session either way.
        this._api.saveSettings?.(this._settings);
    }

    /** @private Best-effort /etc/os-release -> DISTRO_KEYS lookup. Tries
     * `ID=` first, then each token of `ID_LIKE=` (most-specific first),
     * consulting DISTRO_ID_ALIASES for spellings that differ from our
     * logo filenames. Returns 'linux' - the generic Tux logo - if the
     * file can't be read or nothing recognizable is found, exactly per
     * "if not exist[s], set to linux". */
    _detectLinuxDistro() {
        try {
            const [ok, contents] = GLib.file_get_contents('/etc/os-release');
            if (!ok)
                return 'linux';

            const text = new TextDecoder().decode(contents);
            const clean = (v) => (v ?? '').trim().replace(/^"|"$/g, '');
            const id = clean(text.match(/^ID=(.*)$/m)?.[1]);
            const idLike = clean(text.match(/^ID_LIKE=(.*)$/m)?.[1]);

            const candidates = [id, ...idLike.split(/\s+/)].filter(Boolean);
            for (const candidate of candidates) {
                const key = DISTRO_ID_ALIASES[candidate] ?? candidate;
                if (DISTRO_KEYS.includes(key))
                    return key;
            }
            return 'linux';
        } catch (e) {
            return 'linux';
        }
    }

    /** @private Loads exactly one logo module - `./logos/${distroKey}.js`
     * - via a dynamic import(), and only that one: nothing under
     * ./logos/ is imported eagerly or preloaded for other options in the
     * dropdown, and the previous selection's module reference (if any)
     * is dropped as soon as this resolves, so at most one logo's worth
     * of ASCII/color data is ever held in memory regardless of how many
     * distros config.json lists. Re-entrant-safe via `token`: if the
     * user flips through several distros quickly, only the *last*
     * import() to resolve is allowed to update this._logoModule/_render(). */
    _loadLogo(distroKey) {
        const token = ++this._logoLoadToken;
        const key = distroKey === 'generic' ? null : distroKey;

        const applyFallback = () => {
            if (token !== this._logoLoadToken)
                return;
            this._logoDistroKey = distroKey;
            this._logoModule = null; // _render() falls back to GENERIC_ART
            this._render();
        };

        if (!key) {
            applyFallback();
            return;
        }

        import(`./logos/${key}.js`).then(module => {
            if (token !== this._logoLoadToken)
                return; // a newer selection already superseded this load
            this._logoDistroKey = distroKey;
            this._logoModule = module;
            this._render();
        }).catch(e => {
            logError(e, `sysfetch: failed to load logo for "${distroKey}"`);
            applyFallback();
        });
    }

    /** @private repaints the card and every label from this._settings /
     * this._info - never touches the network or spawns anything, so it's
     * safe to call as often as needed (every info fetch above calls this
     * once it resolves, rather than hand-updating one label at a time). */
    _render() {
        const backgroundColor = _toCssColor(this._settings.backgroundColor ?? '#00000026', '#00000026');
        const cornerRadius = this._settings.cornerRadius ?? 18;

        this._actor.set_style(
            `background-color: ${backgroundColor}; border-radius: ${cornerRadius}px; padding: ${CARD_PADDING}px;` +
            _shadowBoxShadowCss(this._settings)
        );

        // this._logoModule is whatever _loadLogo() last resolved for the
        // *current* this._settings.distro (or still null/stale while a
        // load is in flight) - fall back to the plain placeholder mark
        // rather than blocking render on the import() settling.
        let accent = GENERIC_ART.color;
        let markup;
        if (this._logoModule) {
            const variant = this._logoModule.default; // {colors, logo}
            accent = variant.colors[0] ?? GENERIC_ART.color;
            markup = variant.logo.map(line => _logoLineToMarkup(line, variant.colors)).join('\n');
        } else {
            accent = GENERIC_ART.color;
            markup = _markupEscape(GENERIC_ART.art.join('\n'));
        }

        this._asciiLabel.set_style(
            `font-family: monospace; font-size: 9px; line-height: 1.2; color: ${accent}; white-space: pre;`
        );
        this._asciiLabel.clutter_text.set_markup(markup);

        const user = GLib.get_user_name();
        const host = GLib.get_host_name();
        this._headerLabel.set_style('font-family: monospace; font-size: 13px; font-weight: bold; color: #ffffff;');
        this._headerLabel.text = `${user}@${host}`;

        this._sepLabel.set_style(`font-family: monospace; font-size: 11px; color: ${accent}; margin-bottom: 4px;`);
        this._sepLabel.text = '\u2500'.repeat(Math.max(user.length + host.length + 1, 10));

        for (const [key, {bullet, value, label, color}] of Object.entries(this._rows)) {
            bullet.set_style(`font-family: monospace; font-size: 11px; color: ${color}; margin-right: 6px;`);
            value.set_style('font-family: monospace; font-size: 11px; color: #e5e5e5;');
            value.text = `${label}: ${this._info[key] ?? '\u2026'}`;
        }
    }

    /** @private everything readable synchronously from local files/env
     * lands in this._info immediately; Packages/GPU/shell-version need an
     * external command, so those three resolve later and each triggers
     * its own _render() when they do (see file header for why these
     * three specifically go through Gio.Subprocess async). */
    _fetchStaticInfo() {
        this._info.os = this._readOsPrettyName();
        this._info.kernel = this._readKernelVersion();
        this._info.host = this._readHostProduct() ?? GLib.get_host_name();
        this._info.cpu = this._readCpuModel();
        this._info.shell = this._readShellName();
        this._info.resolution = this._readResolution();
        this._info.de = GLib.getenv('XDG_CURRENT_DESKTOP') ?? 'GNOME';
        this._render();

        const distroKey = this._settings.distro ?? 'linux';
        this._runCommandAsync(this._packageCommand(distroKey)).then(out => {
            const count = parseInt(out, 10);
            this._info.packages = Number.isFinite(count) ? String(count) : 'Unknown';
            this._render();
        });

        this._runCommandAsync([
            'bash', '-lc',
            "lspci 2>/dev/null | grep -Ei 'vga|3d|display' | head -n1 | sed -E 's/^[^:]+: //'",
        ]).then(out => {
            this._info.gpu = out || 'Unknown';
            this._render();
        });

        const shellPath = GLib.getenv('SHELL') ?? '/bin/bash';
        this._runCommandAsync([shellPath, '--version']).then(out => {
            const match = out.match(/(\d+\.\d+(?:\.\d+)?)/);
            if (match)
                this._info.shell = `${this._readShellName()} ${match[1]}`;
            this._render();
        });
    }

    /** @private uptime/memory are the only two stats worth re-sampling on
     * a timer - everything else in this._info is effectively constant
     * for the life of a session. */
    _updateDynamicInfo() {
        this._info.uptime = this._formatUptime(this._readUptimeSeconds());

        const {totalKb, usedKb} = this._metrics.getMemoryUsage();
        this._info.memory = `${this._formatGb(usedKb)}/${this._formatGb(totalKb)}`;

        this._render();
    }

    /** @private the package-manager query to run for a given "distro"
     * setting value - "generic" (and any distro without a real Linux
     * package manager, e.g. Windows/macOS/Android) tries each known
     * package manager in turn and stops at the first one that's actually
     * installed, since there's no single convention to assume there. */
    _packageCommand(distroKey) {
        const PACMAN = ['bash', '-lc', 'pacman -Qq 2>/dev/null | wc -l'];
        const DPKG = ['bash', '-lc', "dpkg -l 2>/dev/null | grep -c '^ii'"];
        const RPM = ['bash', '-lc', 'rpm -qa 2>/dev/null | wc -l'];
        const APK = ['bash', '-lc', 'apk info 2>/dev/null | wc -l'];
        const ZYPPER = ['bash', '-lc', 'rpm -qa 2>/dev/null | wc -l'];
        const PORTAGE = ['bash', '-lc', 'qlist -I 2>/dev/null | wc -l'];
        const NIX = ['bash', '-lc', 'nix-store -q --requisites /run/current-system/sw 2>/dev/null | wc -l'];
        const GUIX = ['bash', '-lc', 'guix package --list-installed 2>/dev/null | wc -l'];
        const PKG_BSD = ['bash', '-lc', 'pkg info 2>/dev/null | wc -l'];
        const SLACKPKG = ['bash', '-lc', 'ls /var/log/packages 2>/dev/null | wc -l'];
        const GENERIC = ['bash', '-lc',
            'if command -v pacman >/dev/null; then pacman -Qq | wc -l; ' +
            "elif command -v dpkg >/dev/null; then dpkg -l | grep -c '^ii'; " +
            'elif command -v rpm >/dev/null; then rpm -qa | wc -l; ' +
            'elif command -v apk >/dev/null; then apk info | wc -l; ' +
            'elif command -v guix >/dev/null; then guix package --list-installed | wc -l; ' +
            'elif command -v nix-store >/dev/null; then nix-store -q --requisites /run/current-system/sw | wc -l; ' +
            'elif command -v pkg >/dev/null; then pkg info | wc -l; ' +
            'else echo 0; fi'];

        // Arch-based
        const ARCH_BASED = ['arch', 'manjaro', 'endeavouros'];
        // Debian-based
        const DEBIAN_BASED = [
            'debian', 'ubuntu', 'linuxmint', 'pop', 'devuan', 'kali',
            'raspbian', 'bunsenlabs', 'crunchbang', 'siduction', 'quirinux',
            'elementary', 'armbian',
        ];
        // RPM-based (Fedora family / RHEL family)
        const RPM_BASED = ['fedora', 'centos', 'rhel', 'rocky', 'nobara'];

        if (ARCH_BASED.includes(distroKey))
            return PACMAN;
        if (DEBIAN_BASED.includes(distroKey))
            return DPKG;
        if (RPM_BASED.includes(distroKey))
            return RPM;
        switch (distroKey) {
        case 'alpine':
            return APK;
        case 'opensuse':
            return ZYPPER;
        case 'gentoo':
            return PORTAGE;
        case 'nixos':
            return NIX;
        case 'guix':
            return GUIX;
        case 'freebsd':
        case 'netbsd':
        case 'openbsd':
            return PKG_BSD;
        case 'slackware':
            return SLACKPKG;
        // No conventional Linux package manager on these - fall through
        // to the auto-detecting GENERIC command instead of guessing.
        case 'darwin':
        case 'windows':
        case 'android':
        case 'linux':
        case 'buildroot':
        case 'enso':
        case 'moevalent':
        case 'univalent':
        case 'parabola':
        default:
            return GENERIC;
        }
    }

    /** @private runs argv to completion asynchronously (never blocks the
     * Shell's main loop - see file header) and resolves with trimmed
     * stdout, or '' on any spawn/exit/parse failure. Never rejects -
     * every caller above just checks the resolved string, same
     * never-throw convention every other widget.js method here follows. */
    _runCommandAsync(argv) {
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
                proc.communicate_utf8_async(null, this._cancellable, (source, res) => {
                    try {
                        const [, stdout] = source.communicate_utf8_finish(res);
                        resolve((stdout ?? '').trim());
                    } catch (e) {
                        resolve('');
                    }
                });
            } catch (e) {
                resolve('');
            }
        });
    }

    /** @private PRETTY_NAME out of /etc/os-release, e.g. "Ubuntu 24.04.2 LTS". */
    _readOsPrettyName() {
        try {
            const [ok, contents] = GLib.file_get_contents('/etc/os-release');
            if (!ok)
                return 'Linux';
            const text = new TextDecoder().decode(contents);
            const match = text.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
            return match ? match[1] : 'Linux';
        } catch (e) {
            return 'Linux';
        }
    }

    /** @private e.g. "6.8.0-generic". */
    _readKernelVersion() {
        try {
            const [ok, contents] = GLib.file_get_contents('/proc/sys/kernel/osrelease');
            return ok ? new TextDecoder().decode(contents).trim() : 'Unknown';
        } catch (e) {
            return 'Unknown';
        }
    }

    /** @private DMI product name (e.g. "XPS 15 9530") - null (not
     * "Unknown") on read failure so the caller can fall back to the
     * hostname instead, since plenty of real hardware just doesn't expose
     * this file rather than it being an actual error. */
    _readHostProduct() {
        try {
            const [ok, contents] = GLib.file_get_contents('/sys/class/dmi/id/product_name');
            const text = ok ? new TextDecoder().decode(contents).trim() : '';
            return text || null;
        } catch (e) {
            return null;
        }
    }

    /** @private /proc/cpuinfo's first "model name" line, whitespace-collapsed. */
    _readCpuModel() {
        try {
            const [ok, contents] = GLib.file_get_contents('/proc/cpuinfo');
            if (!ok)
                return 'Unknown';
            const text = new TextDecoder().decode(contents);
            const match = text.match(/^model name\s*:\s*(.+)$/m);
            return match ? match[1].replace(/\s+/g, ' ').trim() : 'Unknown';
        } catch (e) {
            return 'Unknown';
        }
    }

    /** @private just $SHELL's basename (e.g. "bash") - _fetchStaticInfo()
     * appends a version number to this once (if ever) its own
     * `<shell> --version` subprocess resolves. */
    _readShellName() {
        const shellPath = GLib.getenv('SHELL');
        if (!shellPath)
            return 'Unknown';
        return shellPath.split('/').pop();
    }

    /** @private primary monitor's "WIDTHxHEIGHT" - `global` is the Shell
     * process's own singleton (same one lib/dragController.js reads
     * global.stage from), not an import; widget.js runs in that same
     * process, so it's reachable here too. */
    _readResolution() {
        try {
            const monitorIndex = global.display.get_primary_monitor();
            const geometry = global.display.get_monitor_geometry(monitorIndex);
            return `${geometry.width}x${geometry.height}`;
        } catch (e) {
            return 'Unknown';
        }
    }

    /** @private raw seconds since boot, the first field of /proc/uptime. */
    _readUptimeSeconds() {
        try {
            const [ok, contents] = GLib.file_get_contents('/proc/uptime');
            if (!ok)
                return 0;
            const text = new TextDecoder().decode(contents);
            return parseFloat(text.split(' ')[0]) || 0;
        } catch (e) {
            return 0;
        }
    }

    /** @private seconds -> "1d 2h 30m" (or "2h 30m" / "30m" once the
     * larger units are zero), matching the reference screenshot's format. */
    _formatUptime(seconds) {
        const days = Math.floor(seconds / 86400);
        const hours = Math.floor((seconds % 86400) / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);

        const parts = [];
        if (days > 0)
            parts.push(`${days}d`);
        if (days > 0 || hours > 0)
            parts.push(`${hours}h`);
        parts.push(`${minutes}m`);
        return parts.join(' ');
    }

    /** @private kB -> "N GB" (1 decimal place under 10GB, whole number at
     * or above it - matches how most system-info tools trim precision as
     * the number gets bigger). */
    _formatGb(kb) {
        const gb = kb / 1024 / 1024;
        return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)}GB`;
    }
}
