import Adw from "gi://Adw";

import Gtk from "gi://Gtk";

import Gdk from "gi://Gdk";

import Pango from "gi://Pango";

import Gio from "gi://Gio";

import GioUnix from "gi://GioUnix";

import GLib from "gi://GLib";

import Soup from "gi://Soup?version=3.0";

import { getSpecialFolderInfo } from "./fsUtils.js";

let _locationSearchSession = null;

function _getLocationSearchSession() {
    if (!_locationSearchSession) _locationSearchSession = new Soup.Session;
    return _locationSearchSession;
}

function _esc(text) {
    return GLib.markup_escape_text(String(text ?? ""), -1);
}

export function _textRow(field, current, set) {
    const row = new Adw.EntryRow({
        title: _esc(field.label),
        text: String(current ?? ""),
        show_apply_button: Boolean(field.pattern || field.minLength || field.maxLength)
    });
    if (field.description) row.set_tooltip_text(field.description);
    const validate = () => {
        const value = row.text;
        let ok = true;
        if (field.required && value.length === 0) ok = false;
        if (field.minLength !== undefined && value.length < field.minLength) ok = false;
        if (field.maxLength !== undefined && value.length > field.maxLength) ok = false;
        if (field.pattern && !new RegExp(field.pattern).test(value)) ok = false;
        row[ok ? "remove_css_class" : "add_css_class"]("error");
        return ok;
    };
    row.connect("notify::text", () => {
        if (validate()) set(row.text);
    });
    row.connect("apply", () => validate());
    validate();
    return row;
}

export function _locationRow(field, current, set) {
    const row = new Adw.EntryRow({
        title: _esc(field.label),
        text: String(current ?? ""),
        show_apply_button: Boolean(field.pattern || field.minLength || field.maxLength)
    });
    if (field.description) row.set_tooltip_text(field.description);
    const validate = () => {
        const value = row.text;
        let ok = true;
        if (field.required && value.length === 0) ok = false;
        if (field.minLength !== undefined && value.length < field.minLength) ok = false;
        if (field.maxLength !== undefined && value.length > field.maxLength) ok = false;
        if (field.pattern && !new RegExp(field.pattern).test(value)) ok = false;
        row[ok ? "remove_css_class" : "add_css_class"]("error");
        return ok;
    };
    row.connect("notify::text", () => {
        if (validate()) set(row.text);
    });
    row.connect("apply", () => validate());
    validate();
    const editButton = new Gtk.Button({
        icon_name: "system-search-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: [ "flat" ],
        tooltip_text: "Search city location"
    });
    editButton.connect("clicked", () => {
        const root = row.get_root();
        if (!root) {
            console.log("Cannot find parent window");
            return;
        }
        const dialog = new Gtk.Window({
            title: "Search Location",
            transient_for: root,
            modal: true,
            default_width: 400,
            default_height: 450,
            destroy_with_parent: true
        });
        const mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 12,
            margin_end: 12
        });
        const searchEntry = new Gtk.SearchEntry({
            placeholder_text: "Search city..."
        });
        mainBox.append(searchEntry);
        const listBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.SINGLE,
            css_classes: [ "boxed-list" ]
        });
        const scroller = new Gtk.ScrolledWindow({
            child: listBox,
            vexpand: true
        });
        mainBox.append(scroller);
        dialog.set_child(mainBox);
        const performSearch = keyword => {
            let child;
            while (child = listBox.get_first_child()) listBox.remove(child);
            if (!keyword || keyword.trim().length < 2) return;
            const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(keyword)}&count=10&language=en&format=json`;
            const message = Soup.Message.new("GET", url);
            const session = _getLocationSearchSession();
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (sess, res) => {
                try {
                    const bytes = sess.send_and_read_finish(res);
                    const data = JSON.parse(new TextDecoder("utf-8").decode(bytes.get_data()));
                    if (data.results && data.results.length > 0) {
                        for (const place of data.results) {
                            const placeRow = new Adw.ActionRow({
                                title: place.name,
                                subtitle: `${place.country || ""} • ${place.latitude}, ${place.longitude}`,
                                activatable: true
                            });
                            placeRow.connect("activated", () => {
                                const coords = `${place.latitude},${place.longitude}`;
                                row.text = coords;
                                if (validate()) set(coords);
                                dialog.close();
                            });
                            listBox.append(placeRow);
                        }
                    } else {
                        listBox.append(new Adw.ActionRow({
                            title: "No results found",
                            sensitive: false
                        }));
                    }
                } catch (e) {
                    logError(e, "Location search failed");
                }
            });
        };
        searchEntry.connect("changed", entry => performSearch(entry.get_text()));
        dialog.present();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            searchEntry.grab_focus();
            return GLib.SOURCE_REMOVE;
        });
    });
    const locateButton = new Gtk.Button({
        icon_name: "find-location-symbolic",
        valign: Gtk.Align.CENTER,
        css_classes: [ "flat" ],
        tooltip_text: "Detect from my IP address"
    });
    const spinner = new Gtk.Spinner({
        valign: Gtk.Align.CENTER,
        visible: false
    });
    locateButton.connect("clicked", () => {
        locateButton.visible = false;
        spinner.visible = true;
        spinner.spinning = true;
        _fetchIpLocationForPrefs().then(coords => {
            if (!coords) {
                row.add_css_class("error");
                row.set_tooltip_text("Could not detect your location - check your connection, or type coordinates directly.");
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 4e3, () => {
                    row.set_tooltip_text(field.description || "");
                    validate();
                    return GLib.SOURCE_REMOVE;
                });
                return;
            }
            const detected = `${coords.latitude.toFixed(6)},${coords.longitude.toFixed(6)}`;
            row.text = detected;
            if (validate()) set(detected);
        }).catch(e => {
            logError(e, "weather widget location field: IP lookup failed");
        }).finally(() => {
            spinner.spinning = false;
            spinner.visible = false;
            locateButton.visible = true;
        });
    });
    row.add_suffix(spinner);
    row.add_suffix(locateButton);
    row.add_suffix(editButton);
    return row;
}

let _ipLookupSession = null;

function _getIpLookupSession() {
    if (!_ipLookupSession) _ipLookupSession = new Soup.Session;
    return _ipLookupSession;
}

async function _fetchJsonForIpLookup(url) {
    const message = Soup.Message.new("GET", url);
    if (!message) throw new Error(`invalid URL: ${url}`);
    const bytes = await _getIpLookupSession().send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
    if (message.get_status() !== Soup.Status.OK) throw new Error(`HTTP ${message.get_status()} for ${url}`);
    const text = new TextDecoder("utf-8").decode(bytes.get_data());
    return JSON.parse(text);
}

async function _fetchIpLocationForPrefs() {
    const endpoints = [ {
        url: "http://ip-api.com/json/",
        parse: d => ({
            latitude: d.lat,
            longitude: d.lon
        })
    }, {
        url: "https://freeipapi.com/api/json",
        parse: d => ({
            latitude: d.latitude,
            longitude: d.longitude
        })
    }, {
        url: "https://ipwhois.io/json/",
        parse: d => ({
            latitude: d.latitude,
            longitude: d.longitude
        })
    } ];
    for (const {url: url, parse: parse} of endpoints) {
        try {
            const data = await _fetchJsonForIpLookup(url);
            const {latitude: latitude, longitude: longitude} = parse(data) ?? {};
            if (typeof latitude === "number" && typeof longitude === "number" && Number.isFinite(latitude) && Number.isFinite(longitude)) return {
                latitude: latitude,
                longitude: longitude
            };
        } catch (e) {}
    }
    return null;
}

export function _autocompleteRow(field, current, set, ctx) {
    const row = new Adw.EntryRow({
        title: _esc(field.label),
        text: String(current ?? "")
    });
    if (field.description) row.set_tooltip_text(field.description);
    const validate = () => {
        if (!field.pattern) return true;
        const ok = new RegExp(field.pattern).test(row.text);
        row[ok ? "remove_css_class" : "add_css_class"]("error");
        return ok;
    };
    validate();
    const listBox = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE
    });
    listBox.add_css_class("boxed-list");
    const popover = new Gtk.Popover({
        autohide: true,
        has_arrow: false
    });
    popover.set_parent(row);
    popover.set_child(listBox);
    let suppressSearch = false;
    let debounceId = null;
    const clearSuggestions = () => {
        let child;
        while (child = listBox.get_first_child()) listBox.remove(child);
    };
    const runSearch = keyword => {
        clearSuggestions();
        if (!keyword || !ctx) {
            popover.popdown();
            return;
        }
        ctx.loadAutocompleteFn(field.autocomplete).then(fn => fn(keyword)).then(results => {
            clearSuggestions();
            if (!Array.isArray(results) || results.length === 0) {
                popover.popdown();
                return;
            }
            for (const item of results) {
                const itemRow = new Adw.ActionRow({
                    title: item.label ?? String(item.value),
                    subtitle: item.subtitle ?? "",
                    activatable: true
                });
                itemRow.connect("activated", () => {
                    suppressSearch = true;
                    row.text = item.label ?? String(item.value);
                    suppressSearch = false;
                    validate();
                    set(item.value);
                    popover.popdown();
                    if (item.fields && typeof item.fields === "object") {
                        for (const [siblingId, siblingValue] of Object.entries(item.fields)) ctx.fillSibling(siblingId, siblingValue);
                    }
                });
                listBox.append(itemRow);
            }
            popover.popup();
        }).catch(e => {
            logError?.(e, `autocomplete "${field.autocomplete}" failed`);
            clearSuggestions();
            popover.popdown();
        });
    };
    row.connect("notify::text", () => {
        if (suppressSearch) return;
        validate();
        if (debounceId !== null) GLib.source_remove(debounceId);
        debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            debounceId = null;
            runSearch(row.text.trim());
            return GLib.SOURCE_REMOVE;
        });
    });
    row.connect("apply", () => {
        if (validate()) set(row.text);
    });
    ctx?.registerRow(field.id, value => {
        suppressSearch = true;
        row.text = String(value ?? "");
        suppressSearch = false;
        validate();
    });
    return row;
}

export function _textareaRow(field, current, set) {
    const outerRow = new Adw.PreferencesRow({
        activatable: false
    });
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12
    });
    outerRow.set_child(container);
    if (field.label || field.description) {
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2
        });
        if (field.label) header.append(new Gtk.Label({
            label: field.label,
            css_classes: [ "heading" ],
            halign: Gtk.Align.START,
            xalign: 0
        }));
        if (field.description) {
            header.append(new Gtk.Label({
                label: field.description,
                css_classes: [ "caption", "dim-label" ],
                halign: Gtk.Align.START,
                xalign: 0,
                wrap: true
            }));
        }
        container.append(header);
    }
    const buffer = new Gtk.TextBuffer({
        text: String(current ?? "")
    });
    const textView = new Gtk.TextView({
        buffer: buffer,
        wrap_mode: Gtk.WrapMode.WORD_CHAR,
        top_margin: 6,
        bottom_margin: 6,
        left_margin: 6,
        right_margin: 6
    });
    const scroller = new Gtk.ScrolledWindow({
        child: textView,
        min_content_height: 80,
        hscrollbar_policy: Gtk.PolicyType.NEVER,
        css_classes: [ "card" ],
        hexpand: true
    });
    buffer.connect("changed", () => {
        set(buffer.get_text(buffer.get_start_iter(), buffer.get_end_iter(), false));
    });
    container.append(scroller);
    return outerRow;
}

export function _passwordRow(field, current, set) {
    const row = new Adw.PasswordEntryRow({
        title: _esc(field.label),
        text: String(current ?? "")
    });
    if (field.description) row.set_tooltip_text(field.description);
    row.connect("notify::text", () => set(row.text));
    return row;
}

export function _switchRow(field, current, set) {
    const row = new Adw.SwitchRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || ""),
        active: Boolean(current)
    });
    row.connect("notify::active", () => set(row.active));
    return row;
}

export function _checkboxRow(field, current, set) {
    const row = new Adw.ActionRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || "")
    });
    const check = new Gtk.CheckButton({
        active: Boolean(current),
        valign: Gtk.Align.CENTER
    });
    check.connect("notify::active", () => set(check.active));
    row.add_suffix(check);
    row.set_activatable_widget(check);
    return row;
}

export function _dropdownRow(field, current, set) {
    const options = field.options.map(opt => typeof opt === "string" ? {
        value: opt,
        label: opt
    } : opt);
    const model = new Gtk.StringList({
        strings: options.map(opt => opt.label)
    });
    const row = new Adw.ComboRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || ""),
        model: model,
        enable_search: Boolean(field.searchable)
    });
    const currentIndex = options.findIndex(opt => opt.value === current);
    row.selected = currentIndex >= 0 ? currentIndex : 0;
    row.connect("notify::selected", () => set(options[row.selected]?.value));
    return row;
}

export function _spinRow(field, current, set) {
    const hasBounds = typeof field.min === "number" && typeof field.max === "number";
    const step = field.step ?? 1;
    const adjustment = new Gtk.Adjustment({
        lower: hasBounds ? field.min : -Number.MAX_SAFE_INTEGER,
        upper: hasBounds ? field.max : Number.MAX_SAFE_INTEGER,
        step_increment: step,
        page_increment: step * 4,
        value: current
    });
    const row = new Adw.SpinRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || (hasBounds ? `${field.min}–${field.max}${field.unit ?? ""}` : "")),
        adjustment: adjustment,
        digits: field.decimals ?? (Number.isInteger(step) ? 0 : 2)
    });
    row.connect("notify::value", () => set(row.value));
    return row;
}

export function _sliderRow(field, current, set) {
    const min = field.min ?? 0;
    const max = field.max ?? 100;
    const row = new Adw.ActionRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || "")
    });
    const scale = new Gtk.Scale({
        orientation: Gtk.Orientation.HORIZONTAL,
        adjustment: new Gtk.Adjustment({
            lower: min,
            upper: max,
            step_increment: field.step ?? 1,
            value: current ?? min
        }),
        draw_value: Boolean(field.showValue ?? true),
        hexpand: true,
        valign: Gtk.Align.CENTER,
        width_request: 160
    });
    scale.connect("value-changed", () => set(scale.get_value()));
    row.add_suffix(scale);
    row.set_activatable(false);
    return row;
}

export function _colorRow(field, current, set) {
    const row = new Adw.ActionRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || "")
    });
    const rgba = new Gdk.RGBA;
    rgba.parse(typeof current === "string" ? current : String(field.default));
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({
            with_alpha: Boolean(field.alpha)
        }),
        rgba: rgba,
        valign: Gtk.Align.CENTER
    });
    button.connect("notify::rgba", () => set(_rgbaToHex(button.rgba)));
    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}

function _rgbaToHex(rgba) {
    const channel = value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0");
    const hex = `#${channel(rgba.red)}${channel(rgba.green)}${channel(rgba.blue)}`;
    return rgba.alpha < 1 ? `${hex}${channel(rgba.alpha)}` : hex;
}

export function _fontRow(field, current, set) {
    const row = new Adw.ActionRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || "")
    });
    const button = new Gtk.FontDialogButton({
        dialog: new Gtk.FontDialog,
        valign: Gtk.Align.CENTER
    });
    const fallback = typeof field.default === "string" && field.default.length > 0 ? field.default : "Sans 10";
    const initial = typeof current === "string" && current.length > 0 ? current : fallback;
    try {
        button.set_font_desc(Pango.FontDescription.from_string(initial));
    } catch (e) {
        button.set_font_desc(Pango.FontDescription.from_string(fallback));
    }
    button.connect("notify::font-desc", () => {
        const desc = button.get_font_desc();
        if (!desc) return;
        set(desc.to_string());
    });
    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}

export function _iconRow(field, current, set) {
    const row = new Adw.EntryRow({
        title: _esc(field.label),
        text: String(current ?? "")
    });
    if (field.description) row.set_tooltip_text(field.description);
    const preview = new Gtk.Image({
        icon_name: String(current || "image-missing-symbolic")
    });
    row.add_suffix(preview);
    row.connect("notify::text", () => {
        preview.set_from_icon_name(row.text || "image-missing-symbolic");
        set(row.text);
    });
    return row;
}

export function _pathRow(field, current, set, {folder: folder}) {
    const row = new Adw.ActionRow({
        title: _esc(field.label),
        subtitle: current || field.placeholder || "Not set"
    });
    const button = new Gtk.Button({
        label: "Browse…",
        valign: Gtk.Align.CENTER
    });
    button.connect("clicked", () => {
        const dialog = new Gtk.FileDialog({
            title: field.label
        });
        if (!folder && Array.isArray(field.filters) && field.filters.length > 0) {
            const store = new Gio.ListStore({
                item_type: Gtk.FileFilter
            });
            for (const pattern of field.filters) {
                const filter = new Gtk.FileFilter;
                filter.set_name(pattern);
                filter.add_pattern(pattern);
                store.append(filter);
            }
            dialog.set_filters(store);
            dialog.set_default_filter(store.get_item(0));
        }
        const parent = button.get_root();
        const onPicked = (_dialog, result) => {
            try {
                const file = folder ? dialog.select_folder_finish(result) : dialog.open_finish(result);
                if (file) {
                    const path = file.get_path();
                    row.subtitle = path;
                    set(path);
                }
            } catch (e) {}
        };
        if (folder) dialog.select_folder(parent, null, onPicked); else dialog.open(parent, null, onPicked);
    });
    row.add_suffix(button);
    row.set_activatable_widget(button);
    return row;
}

export function _objectRow(field, current, set) {
    const row = new Adw.ExpanderRow({
        title: _esc(field.label),
        subtitle: _esc(field.description || "")
    });
    const base = current && typeof current === "object" ? current : {};
    for (const [key, propField] of Object.entries(field.properties)) {
        const propCurrent = key in base ? base[key] : propField.default;
        const liveProp = new Proxy({
            [key]: propCurrent
        }, {
            set(target, prop, value) {
                target[prop] = value;
                set({
                    ...current && typeof current === "object" ? current : {},
                    [key]: value
                });
                return true;
            }
        });
        const nestedField = {
            ...propField,
            id: key
        };
        row.add_row(_buildRow(nestedField, liveProp, () => {}));
    }
    return row;
}

export function _listRow(field, current, set) {
    const outerRow = new Adw.PreferencesRow({
        activatable: false
    });
    const container = new Gtk.Box({
        orientation: Gtk.Orientation.VERTICAL,
        spacing: 8,
        margin_top: 12,
        margin_bottom: 12,
        margin_start: 12,
        margin_end: 12
    });
    outerRow.set_child(container);
    if (field.label || field.description) {
        const header = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 2
        });
        if (field.label) header.append(new Gtk.Label({
            label: field.label,
            css_classes: [ "heading" ],
            halign: Gtk.Align.START,
            xalign: 0
        }));
        if (field.description) {
            header.append(new Gtk.Label({
                label: field.description,
                css_classes: [ "caption", "dim-label" ],
                halign: Gtk.Align.START,
                xalign: 0,
                wrap: true
            }));
        }
        container.append(header);
    }
    let items = Array.isArray(current) ? [ ...current ] : [];
    const isApplicationList = field.item?.dataType !== "object" && field.item?.format === "app";
    const isFolderList = field.item?.dataType !== "object" && field.item?.format === "folder";
    const withinBounds = delta => {
        const next = items.length + delta;
        if (field.minItems !== undefined && next < field.minItems) return false;
        if (field.maxItems !== undefined && next > field.maxItems) return false;
        return true;
    };
    const listBox = new Gtk.ListBox({
        selection_mode: Gtk.SelectionMode.NONE
    });
    listBox.add_css_class("boxed-list");
    container.append(listBox);
    const addContainer = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        halign: Gtk.Align.END,
        margin_top: 4
    });
    container.append(addContainer);
    const _clearBox = box => {
        let child;
        while (child = box.get_first_child()) box.remove(child);
    };
    const rerender = () => {
        _clearBox(listBox);
        items.forEach((item, index) => {
            listBox.append(_buildItemRow(item, index));
        });
        _clearBox(addContainer);
        if (field.addable !== false) {
            addContainer.append(isApplicationList ? _applicationAddWidget() : isFolderList ? _folderAddWidget() : _staticAddWidget());
        }
    };
    function _makeRemoveButton(index, extraCssClass) {
        const removeButton = new Gtk.Button({
            icon_name: "user-trash-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: [ "flat" ]
        });
        if (extraCssClass) removeButton.add_css_class(extraCssClass);
        removeButton.set_sensitive(withinBounds(-1));
        removeButton.connect("clicked", () => {
            items = items.filter((_, i) => i !== index);
            set([ ...items ]);
            rerender();
        });
        return removeButton;
    }
    function _buildItemRow(item, index) {
        const itemSchema = field.item;
        if (itemSchema.format === "app") return _applicationItemRow(item, index);
        if (itemSchema.format === "folder") return _folderItemRow(item, index);
        if (itemSchema.dataType === "object") {
            const objField = {
                ...itemSchema,
                id: `item-${index}`,
                label: `Item ${index + 1}`,
                fieldType: "object"
            };
            const expander = _objectRow(objField, item, updated => {
                items = items.map((it, i) => i === index ? updated : it);
                set([ ...items ]);
            });
            if (field.removable !== false) expander.add_action(_makeRemoveButton(index));
            return expander;
        }
        const primField = {
            ...itemSchema,
            id: `item-${index}`,
            label: `Item ${index + 1}`,
            fieldType: itemSchema.fieldType ?? (itemSchema.dataType === "boolean" ? "switch" : "text")
        };
        const liveItem = new Proxy({
            [primField.id]: item
        }, {
            set(target, prop, value) {
                target[prop] = value;
                items = items.map((it, i) => i === index ? value : it);
                set([ ...items ]);
                return true;
            }
        });
        const itemRow = _buildRow(primField, liveItem, () => {});
        if (field.removable !== false && itemRow.add_suffix) itemRow.add_suffix(_makeRemoveButton(index));
        return itemRow;
    }
    function _applicationItemRow(path, index) {
        const itemRow = new Adw.ActionRow;
        let displayName = GLib.path_get_basename(path);
        let gicon = null;
        try {
            if (path.endsWith(".desktop")) {
                const appInfo = GioUnix.DesktopAppInfo.new_from_filename(path);
                if (appInfo) {
                    displayName = appInfo.get_display_name();
                    gicon = appInfo.get_icon();
                }
            }
        } catch (e) {}
        itemRow.title = displayName;
        itemRow.subtitle = path;
        const icon = new Gtk.Image({
            pixel_size: 24,
            valign: Gtk.Align.CENTER
        });
        if (gicon) icon.set_from_gicon(gicon); else icon.set_from_icon_name("application-x-executable-symbolic");
        itemRow.add_prefix(icon);
        if (field.removable !== false) itemRow.add_suffix(_makeRemoveButton(index, "error"));
        return itemRow;
    }
    function _applicationAddWidget() {
        const scanDirectory = field.item.scanDirectory ?? "/usr/share/applications";
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER
        });
        const addButton = new Gtk.Button({
            icon_name: "list-add-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: [ "flat" ],
            tooltip_text: "Browse for an application",
            sensitive: withinBounds(1)
        });
        addButton.connect("clicked", () => {
            const dialog = new Gtk.FileDialog({
                title: field.label ?? "Add application"
            });
            dialog.set_initial_folder(Gio.File.new_for_path(scanDirectory));
            const filterStore = new Gio.ListStore({
                item_type: Gtk.FileFilter
            });
            const filter = new Gtk.FileFilter;
            filter.set_name("Desktop entries");
            filter.add_pattern("*.desktop");
            filterStore.append(filter);
            dialog.set_filters(filterStore);
            dialog.set_default_filter(filter);
            dialog.open(addButton.get_root(), null, (_dialog, result) => {
                try {
                    const file = dialog.open_finish(result);
                    const path = file?.get_path();
                    if (path && !items.includes(path)) {
                        items = [ ...items, path ];
                        set([ ...items ]);
                        rerender();
                    }
                } catch (e) {}
            });
        });
        box.append(addButton);
        return box;
    }
    function _folderItemRow(path, index) {
        const itemRow = new Adw.ActionRow;
        const special = getSpecialFolderInfo(path);
        itemRow.title = special?.label ?? (GLib.path_get_basename(path) || path);
        itemRow.subtitle = path;
        const icon = new Gtk.Image({
            icon_name: special ? `${special.icon}-symbolic` : "folder-symbolic",
            pixel_size: 24,
            valign: Gtk.Align.CENTER
        });
        itemRow.add_prefix(icon);
        if (field.removable !== false) itemRow.add_suffix(_makeRemoveButton(index, "error"));
        return itemRow;
    }
    function _addFolderPath(path) {
        if (path && !items.includes(path)) {
            items = [ ...items, path ];
            set([ ...items ]);
            rerender();
        }
    }
    function _folderAddWidget() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER
        });
        // Quick-pick popover for XDG special folders (Downloads, Documents,
        // Music, Pictures, Videos, Desktop, Public, Templates, Home) - added
        // so those don't require navigating the file dialog every time.
        const specialDirs = [ GLib.UserDirectory.DIRECTORY_DOWNLOAD, GLib.UserDirectory.DIRECTORY_DOCUMENTS, GLib.UserDirectory.DIRECTORY_MUSIC, GLib.UserDirectory.DIRECTORY_PICTURES, GLib.UserDirectory.DIRECTORY_VIDEOS, GLib.UserDirectory.DIRECTORY_DESKTOP, GLib.UserDirectory.DIRECTORY_PUBLIC_SHARE, GLib.UserDirectory.DIRECTORY_TEMPLATES ];
        const quickPaths = [];
        try {
            const home = GLib.get_home_dir();
            if (home) quickPaths.push(home);
        } catch (e) {}
        for (const dir of specialDirs) {
            try {
                const path = GLib.get_user_special_dir(dir);
                if (path && !quickPaths.includes(path)) quickPaths.push(path);
            } catch (e) {}
        }
        if (quickPaths.length) {
            const menuButton = new Gtk.MenuButton({
                icon_name: "pan-down-symbolic",
                valign: Gtk.Align.CENTER,
                css_classes: [ "flat" ],
                tooltip_text: "Quick-add a special folder",
                sensitive: withinBounds(1)
            });
            const popoverList = new Gtk.ListBox({
                selection_mode: Gtk.SelectionMode.NONE
            });
            popoverList.add_css_class("boxed-list");
            for (const path of quickPaths) {
                const info = getSpecialFolderInfo(path);
                const row = new Adw.ActionRow({
                    title: info?.label ?? (GLib.path_get_basename(path) || path),
                    activatable: true
                });
                row.add_prefix(new Gtk.Image({
                    icon_name: info ? `${info.icon}-symbolic` : "folder-symbolic",
                    pixel_size: 20,
                    valign: Gtk.Align.CENTER
                }));
                row.connect("activated", () => {
                    _addFolderPath(path);
                    popover.popdown();
                });
                popoverList.append(row);
            }
            const popover = new Gtk.Popover({
                child: popoverList
            });
            menuButton.set_popover(popover);
            box.append(menuButton);
        }
        const addButton = new Gtk.Button({
            icon_name: "list-add-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: [ "flat" ],
            tooltip_text: "Browse for a folder",
            sensitive: withinBounds(1)
        });
        addButton.connect("clicked", () => {
            const dialog = new Gtk.FileDialog({
                title: field.label ?? "Add folder"
            });
            if (field.item.scanDirectory) dialog.set_initial_folder(Gio.File.new_for_path(field.item.scanDirectory));
            dialog.select_folder(addButton.get_root(), null, (_dialog, result) => {
                try {
                    const file = dialog.select_folder_finish(result);
                    _addFolderPath(file?.get_path());
                } catch (e) {}
            });
        });
        box.append(addButton);
        return box;
    }
    function _staticAddWidget() {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER
        });
        const staging = _buildStagingControl(field.item);
        const addButton = new Gtk.Button({
            icon_name: "list-add-symbolic",
            valign: Gtk.Align.CENTER,
            css_classes: [ "flat" ],
            sensitive: withinBounds(1)
        });
        addButton.connect("clicked", () => {
            if (!withinBounds(1)) return;
            items = [ ...items, staging.getValue() ];
            set([ ...items ]);
            staging.reset();
            rerender();
        });
        box.append(staging.widget);
        box.append(addButton);
        return box;
    }
    rerender();
    return outerRow;
}

function _buildStagingControl(itemSchema) {
    const dataType = itemSchema.dataType ?? "string";
    const fieldType = itemSchema.fieldType ?? (dataType === "boolean" ? "switch" : dataType === "integer" || dataType === "number" ? "spinbutton" : "text");
    if (fieldType === "dropdown" || fieldType === "radio") {
        const options = (itemSchema.options ?? []).map(opt => typeof opt === "string" ? {
            value: opt,
            label: opt
        } : opt);
        const model = new Gtk.StringList({
            strings: options.map(opt => opt.label)
        });
        const dropDown = new Gtk.DropDown({
            model: model,
            valign: Gtk.Align.CENTER
        });
        return {
            widget: dropDown,
            getValue: () => options[dropDown.selected]?.value,
            reset: () => {
                dropDown.selected = 0;
            }
        };
    }
    if (fieldType === "switch" || fieldType === "checkbox") {
        const check = new Gtk.CheckButton({
            valign: Gtk.Align.CENTER,
            active: Boolean(itemSchema.default)
        });
        return {
            widget: check,
            getValue: () => check.active,
            reset: () => {
                check.active = Boolean(itemSchema.default);
            }
        };
    }
    if (fieldType === "spinbutton" || fieldType === "slider") {
        const step = itemSchema.step ?? 1;
        const adjustment = new Gtk.Adjustment({
            lower: itemSchema.min ?? -Number.MAX_SAFE_INTEGER,
            upper: itemSchema.max ?? Number.MAX_SAFE_INTEGER,
            step_increment: step,
            value: itemSchema.default ?? 0
        });
        const digits = itemSchema.decimals ?? (dataType === "integer" ? 0 : Number.isInteger(step) ? 0 : 2);
        const spin = new Gtk.SpinButton({
            adjustment: adjustment,
            valign: Gtk.Align.CENTER,
            digits: digits
        });
        return {
            widget: spin,
            getValue: () => dataType === "integer" ? Math.round(spin.get_value()) : spin.get_value(),
            reset: () => {
                spin.set_value(itemSchema.default ?? 0);
            }
        };
    }
    const entry = new Gtk.Entry({
        placeholder_text: itemSchema.placeholder ?? "",
        valign: Gtk.Align.CENTER
    });
    return {
        widget: entry,
        getValue: () => entry.get_text(),
        reset: () => {
            entry.set_text("");
        }
    };
}

function _scanApplications(directory, pattern) {
    const results = [];
    let regex = null;
    if (pattern) {
        try {
            regex = new RegExp(pattern, "i");
        } catch (e) {
            regex = null;
        }
    }
    try {
        const dir = Gio.File.new_for_path(directory);
        const enumerator = dir.enumerate_children("standard::name", Gio.FileQueryInfoFlags.NONE, null);
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (!name.endsWith(".desktop")) continue;
            if (regex && !regex.test(name)) continue;
            results.push(GLib.build_filenamev([ directory, name ]));
        }
    } catch (e) {}
    return results;
}