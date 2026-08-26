import GLib from "gi://GLib";

import Gio from "gi://Gio";

const PORTAL_BUS_NAME = "org.freedesktop.portal.Desktop";

const PORTAL_OBJECT_PATH = "/org/freedesktop/portal/desktop";

const SCREENSHOT_IFACE = "org.freedesktop.portal.Screenshot";

const REQUEST_IFACE = "org.freedesktop.portal.Request";

const REQUEST_TIMEOUT_MS = 20000;

let tokenCounter = 0;

function nextHandleToken() {
    tokenCounter += 1;
    return `gwc_screenshot_${GLib.get_monotonic_time()}_${tokenCounter}`;
}

export function captureDesktopScreenshotViaPortal() {
    return new Promise((resolve, reject) => {
        const connection = Gio.DBus.session;
        let settled = false;
        let subscriptionId = null;
        let timeoutId = null;
        const finish = (fn, arg) => {
            if (settled) return;
            settled = true;
            if (subscriptionId !== null) {
                connection.signal_unsubscribe(subscriptionId);
                subscriptionId = null;
            }
            if (timeoutId !== null) {
                GLib.source_remove(timeoutId);
                timeoutId = null;
            }
            fn(arg);
        };
        try {
            const uniqueName = connection.get_unique_name();
            const sender = uniqueName.replace(/^:/, "").replace(/\./g, "_");
            const handleToken = nextHandleToken();
            const requestPath = `/org/freedesktop/portal/desktop/request/${sender}/${handleToken}`;
            subscriptionId = connection.signal_subscribe(PORTAL_BUS_NAME, REQUEST_IFACE, "Response", requestPath, null, Gio.DBusSignalFlags.NONE, (conn, sender_, objectPath, iface, signal, params) => {
                try {
                    const [ responseCode, results ] = params.deep_unpack();
                    if (responseCode !== 0) {
                        finish(reject, new Error(responseCode === 1 ? "Screenshot was cancelled" : "Screenshot portal request failed"));
                        return;
                    }
                    const uriVariant = results?.uri;
                    const uri = uriVariant?.unpack ? uriVariant.unpack() : uriVariant;
                    if (!uri) {
                        finish(reject, new Error("Screenshot portal returned no image"));
                        return;
                    }
                    const path = Gio.File.new_for_uri(uri).get_path();
                    finish(resolve, path || uri);
                } catch (e) {
                    finish(reject, e);
                }
            });
            timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REQUEST_TIMEOUT_MS, () => {
                finish(reject, new Error("Screenshot portal request timed out"));
                return GLib.SOURCE_REMOVE;
            });
            const options = {
                handle_token: GLib.Variant.new("s", handleToken),
                interactive: GLib.Variant.new("b", false)
            };
            connection.call(PORTAL_BUS_NAME, PORTAL_OBJECT_PATH, SCREENSHOT_IFACE, "Screenshot", new GLib.Variant("(sa{sv})", [ "", options ]), new GLib.VariantType("(o)"), Gio.DBusCallFlags.NONE, -1, null, (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch (e) {
                    finish(reject, e);
                }
            });
        } catch (e) {
            finish(reject, e);
        }
    });
}
