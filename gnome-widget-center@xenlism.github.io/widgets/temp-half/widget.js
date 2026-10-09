import Clutter from "gi://Clutter";
import St from "gi://St";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { createLayeredCard, applyLayeredCardStyle } from "../../lib/shell/cardLayers.js";
import Cairo from "cairo";

// Card layers, card style and background blur come from the host's
// lib/shell/cardLayers.js; sensor scan and ring drawing live in this file.

// ---------------------------------------------------------------- settings
const DEFAULTS = {
    "ring-1-sensor": "cpu",
    "ring-1-custom-sensor": "",
    "ring-1-color": "#FF8A3D",
    "ring-1-thickness": 10,
    "ring-1-min": 30,
    "ring-1-max": 100,
    "label": "",
    "ring-track-color": "#FFFFFF26",
    "text-font-size": 26,
    "text-color": "#FFFFFFFF",
    "label-font-size": 11,
    "label-color": "#FFFFFFB3",
    "unit": "C",
    "refresh-seconds": 3,
    "card-shadow-angle": 90,
    "card-shadow-distance": 6
};

// Every card-* key (WIDGET_API 9.3.1). The host fills these from the active
// theme pack's appearance.cardSettings before our own defaults are used.
const CARD = {
    "card-background-color": "#000000F5", "card-opacity": 100,
    "card-corner-radius-enabled": true, "card-corner-radius": 18,
    "card-border-enabled": false, "card-border-color": "#FFFFFF33", "card-border-width": 1,
    "card-shadow-enabled": false, "card-shadow-color": "#000000", "card-shadow-opacity": 30,
    "card-shadow-blur": 16, "card-shadow-angle": 90, "card-shadow-distance": 6,
    "card-blur-enabled": false, "card-blur-radius": 24,
};

const SIZE = 148; // 1x1 block = 176px, minus 14px card padding each side

const n = (v, d) => (Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ------------------------------------------------------------------ colors
export function parseColor(hex, fb = "#FFFFFFFF") {
    for (const v of [hex, fb, "#FFFFFFFF"]) {
        let h = typeof v === "string" ? v.trim().replace(/^#/, "") : "";
        if (h.length === 3) h = [...h].map(c => c + c).join("");
        if (/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(h)) {
            const b = i => parseInt(h.slice(i, i + 2), 16);
            return { r: b(0), g: b(2), b: b(4), a: h.length === 8 ? b(6) / 255 : 1 };
        }
    }
}

// St CSS does not understand 8-digit hex, so go through rgba().
export const css = (hex, fb) => {
    const c = parseColor(hex, fb);
    return `rgba(${c.r}, ${c.g}, ${c.b}, ${Math.round(c.a * 1000) / 1000})`;
};

// ----------------------------------------------------------------- sensors
const HWMON = "/sys/class/hwmon";
const THERMAL = "/sys/class/thermal";

// Preset -> regex over "<chip> <label>" (hwmon) or "thermal <type>" (thermal zones).
export const PRESETS = {
    cpu: /coretemp|k10temp|zenpower|x86_pkg_temp|cpu|soc|tctl|tdie|package/i,
    gpu: /amdgpu|nouveau|radeon|nvidia|gpu|edge|junction/i,
    nvme: /nvme|composite/i,
    disk: /drivetemp|sata|hdd|ssd/i,
    wifi: /iwlwifi|wifi|wlan|mt79|ath\d|rtw/i,
    battery: /\bbat|battery/i,
    acpi: /acpitz|acpi/i,
};
export const LABELS = { auto: "MAX", cpu: "CPU", gpu: "GPU", nvme: "NVMe", disk: "Disk", wifi: "Wi-Fi", battery: "Battery", acpi: "ACPI", custom: "Custom" };

function readText(path) {
    return new Promise(resolve => {
        Gio.File.new_for_path(path).load_contents_async(null, (file, res) => {
            try {
                resolve(new TextDecoder().decode(file.load_contents_finish(res)[1]));
            } catch (_e) {
                resolve(null);
            }
        });
    });
}

function writeText(path, text) {
    return new Promise((resolve, reject) => {
        const bytes = new TextEncoder().encode(text);
        Gio.File.new_for_path(path).replace_contents_bytes_async(new GLib.Bytes(bytes), null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null, (file, res) => {
                try {
                    file.replace_contents_finish(res);
                    resolve();
                } catch (e) {
                    reject(e);
                }
            });
    });
}

function listDir(path) {
    const names = [];
    try {
        const dir = GLib.Dir.open(path, 0);
        let name;
        while ((name = dir.read_name()) !== null) names.push(name);
    } catch (_e) { /* directory missing */ }
    return names.sort();
}

export async function scanSensors() {
    const out = [];
    for (const h of listDir(HWMON)) {
        const base = `${HWMON}/${h}`;
        const chip = ((await readText(`${base}/name`)) ?? h).trim();
        for (const f of listDir(base)) {
            const m = /^temp(\d+)_input$/.exec(f);
            if (!m) continue;
            const label = ((await readText(`${base}/temp${m[1]}_label`)) ?? `temp${m[1]}`).trim();
            out.push({ desc: `${chip} ${label}`, path: `${base}/${f}` });
        }
    }
    for (const z of listDir(THERMAL)) {
        if (!/^thermal_zone\d+$/.test(z)) continue;
        const type = ((await readText(`${THERMAL}/${z}/type`)) ?? z).trim();
        out.push({ desc: `thermal ${type}`, path: `${THERMAL}/${z}/temp` });
    }
    return out;
}

// auto = every sensor (hottest wins); presets = regex; custom = "/path" or a name substring.
export function selectSensors(sensors, sel, custom) {
    if (sel === "auto") return sensors;
    if (sel === "custom") {
        const c = String(custom ?? "").trim();
        if (!c) return [];
        if (c.startsWith("/")) return [{ desc: c, path: c }];
        return sensors.filter(s => s.desc.toLowerCase().includes(c.toLowerCase()));
    }
    const re = PRESETS[sel];
    return re ? sensors.filter(s => re.test(s.desc)) : [];
}

// Kernel reports milli-degrees; some files report plain degrees. 0/garbage = unused sensor.
export function parseCelsius(text) {
    const v = parseFloat(text);
    if (!Number.isFinite(v)) return null;
    const c = Math.abs(v) > 200 ? v / 1000 : v;
    return c > 0 && c < 150 ? c : null;
}

async function readTemp(sensors, sel, custom, cache) {
    const vals = await Promise.all(selectSensors(sensors, sel, custom).map(s => {
        if (!cache.has(s.path)) cache.set(s.path, readText(s.path).then(parseCelsius));
        return cache.get(s.path);
    }));
    const ok = vals.filter(v => v !== null);
    return ok.length ? Math.max(...ok) : null;
}

export const toFraction = (c, min, max) => (c === null || max <= min ? 0 : clamp((c - min) / (max - min), 0, 1));

export function fmtTemp(c, unit) {
    if (c === null || c === undefined) return "--";
    return unit === "F" ? `${Math.round(c * 1.8 + 32)}°F` : `${Math.round(c)}°C`;
}

// ------------------------------------------------------------------ drawing
function textStyle(color, size, bold) {
    return `color: ${css(color)}; font-size: ${n(size, 14)}px; text-align: center;${bold ? " font-weight: bold;" : ""}`;
}

function setRgba(cr, c) {
    cr.setSourceRGBA(c.r / 255, c.g / 255, c.b / 255, c.a);
}

function clearCairo(cr) {
    cr.setOperator(Cairo.Operator.CLEAR);
    cr.paint();
    cr.setOperator(Cairo.Operator.OVER);
}

function strokeArc(cr, cx, cy, r, t, start, sweep, track, color, frac) {
    if (r <= 0) return;
    cr.setLineWidth(t);
    cr.setLineCap(Cairo.LineCap.ROUND);
    setRgba(cr, track);
    cr.arc(cx, cy, r, start, start + sweep);
    cr.stroke();
    if (frac > 0) {
        setRgba(cr, color);
        cr.arc(cx, cy, r, start, start + sweep * frac);
        cr.stroke();
    }
}
const HALF_H = Math.round(SIZE / 2) + 8;

export default class TempHalfWidget {
    constructor(api, metadata = null) {
        this._api = api;
        this._settings = api.settings;
        this._metadata = metadata;
        this._alive = false;
        this._timer = 0;
        this._repaintId = 0;
        this._sensors = [];
        this._ticks = 0;
        this._temps = {};
        // A Child must not offer "Add Widget" itself (no grandchildren).
        if (metadata?.parent) this._addChild = undefined;
    }

    enable() {
        this._alive = true;
        this._start();
    }

    disable() {
        this._alive = false;
        this._stop();
        if (this._repaintId && this._area) this._area.disconnect(this._repaintId);
        this._repaintId = 0;
    }

    getDefaultSettings() {
        return { ...CARD, ...DEFAULTS };
    }

    onSettingsChanged() {
        if (!this._alive) return;
        this._start();
        this._render();
    }

    _start() {
        this._stop();
        this._refresh(true);
        const secs = clamp(Math.round(n(this._settings["refresh-seconds"], 3)), 1, 60);
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, secs, () => {
            this._refresh(false);
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stop() {
        if (this._timer) GLib.source_remove(this._timer);
        this._timer = 0;
    }

    async _refresh(rescan) {
        try {
            // Retry the scan every 10th tick while nothing was found (module loaded late).
            if (rescan || (!this._sensors.length && this._ticks++ % 10 === 0)) this._sensors = await scanSensors();
            if (!this._alive) return;
            const s = this._settings;
            const cache = new Map();
            const temps = {};
            await Promise.all(this._ringIds().map(async i => {
                temps[i] = await readTemp(this._sensors, s[`ring-${i}-sensor`], s[`ring-${i}-custom-sensor`], cache);
            }));
            if (!this._alive) return;
            this._temps = temps;
            this._render();
        } catch (e) {
            this._api.logger?.error?.(`temperature refresh failed: ${e.message}`);
        }
    }

    // [{min, max, thickness, color}] helpers shared by every ring widget.
    _ring(i) {
        const s = this._settings;
        return {
            c: this._temps[i] ?? null,
            min: n(s[`ring-${i}-min`], 30),
            max: n(s[`ring-${i}-max`], 100),
            t: clamp(n(s[`ring-${i}-thickness`], 10), 2, 30),
            color: parseColor(s[`ring-${i}-color`], DEFAULTS[`ring-${i}-color`]),
            track: parseColor(s["ring-track-color"], DEFAULTS["ring-track-color"]),
        };
    }

    _label(i) {
        const s = this._settings;
        const custom = String(s.label ?? "").trim();
        return custom || LABELS[s[`ring-${i}-sensor`]] || "";
    }

    _ringIds() {
        return [1];
    }

    buildActor() {
        this._layers = createLayeredCard();
        this._actor = this._layers.root;
        const column = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true,
        });
        this._layers.content.add_child(column);
        this._area = new St.DrawingArea({ width: SIZE, height: HALF_H });
        this._repaintId = this._area.connect("repaint", () => this._paint());
        column.add_child(this._area);
        this._value = new St.Label({ text: "--", x_align: Clutter.ActorAlign.CENTER });
        this._caption = new St.Label({ text: "", x_align: Clutter.ActorAlign.CENTER });
        column.add_child(this._value);
        column.add_child(this._caption);
        this._render();
        return this._actor;
    }

    _render() {
        if (!this._actor) return;
        const s = this._settings;
        applyLayeredCardStyle(this._layers, s);
        this._value.set_text(fmtTemp(this._temps[1] ?? null, s.unit));
        this._value.set_style(textStyle(s["text-color"], s["text-font-size"], true));
        this._caption.set_text(this._label(1));
        this._caption.set_style(textStyle(s["label-color"], s["label-font-size"], false));
        this._area.queue_repaint();
    }

    // Top half-circle, filling left -> right. Round caps overhang the baseline by t/2.
    _paint() {
        const cr = this._area.get_context();
        try {
            clearCairo(cr);
            const r = this._ring(1);
            const cy = HALF_H - r.t / 2 - 2;
            const radius = Math.min(SIZE / 2 - r.t / 2 - 2, cy - r.t / 2 - 2);
            strokeArc(cr, SIZE / 2, cy, radius, r.t, Math.PI, Math.PI, r.track, r.color, toFraction(r.c, r.min, r.max));
        } finally {
            cr.$dispose();
        }
    }

    // Architect: the host adds an "Add Widget" button to the edit-mode toolbar when this
    // method exists. It clones this widget (settings included) into a new Child folder
    // under ~/.local/share/gnome-widget-center/widgets/; the Child loads this same class.
    async _addChild() {
        try {
            const api = this._api;
            const stamp = GLib.DateTime.new_now_local().format("%Y%m%d%H%M%S");
            const id = `${this._metadata.id}-ring-${stamp}`.replace(/[^a-zA-Z0-9._-]/g, "-");
            const src = GLib.build_filenamev([api.path.me, "child"]);
            const dest = GLib.build_filenamev([GLib.get_user_data_dir(), "gnome-widget-center", "widgets", id]);
            GLib.mkdir_with_parents(dest, 0o755);
            for (const f of ["config.json", "widget.js"])
                await writeText(`${dest}/${f}`, await readText(`${src}/${f}`));
            const meta = JSON.parse(await readText(`${src}/metadata.json`));
            meta.id = id;
            meta.parent = this._metadata.id;
            meta.name = this._metadata.name;
            await writeText(`${dest}/metadata.json`, JSON.stringify(meta, null, 4));
            // Seed the Child's settings with ours so it starts as an exact copy.
            const cfg = GLib.build_filenamev([GLib.get_user_config_dir(), "gnome-widget-center", "widgets"]);
            GLib.mkdir_with_parents(cfg, 0o755);
            await writeText(`${cfg}/${id}.json`, JSON.stringify({ _schemaVersion: 1, ...this._settings }, null, 2));
            api.logger?.info?.(`temperature: created child "${id}"`);
            api.host?.rescan?.();
        } catch (e) {
            this._api.logger?.error?.(`temperature: failed to create child: ${e.message}`);
        }
    }

    // Async metadata read (no synchronous file IO in the constructor).
    static async createInstance(api) {
        const raw = await readText(`${api.path.me}/metadata.json`);
        return new this(api, raw ? JSON.parse(raw) : null);
    }
}
