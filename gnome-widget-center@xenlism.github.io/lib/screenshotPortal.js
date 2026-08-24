import GLib from "gi://GLib";

import Gio from "gi://Gio";

// Captures the whole desktop via the xdg-desktop-portal Screenshot portal
// (org.freedesktop.portal.Screenshot), replacing the old direct call to
// org.gnome.Shell.Screenshot. Recent GNOME Shell versions reject that
// private interface for callers outside the Shell's own trusted set
// ("GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: Screenshot is
// not allowed"), even when the caller is this extension's own process.
// The portal is the interface actual applications are meant to use for
// this, is available from *any* process (the prefs app's separate GTK
// process as well as from inside the Shell process itself, since
// xdg-desktop-portal is a session service, not something scoped to a
// single caller identity), and doesn't get restricted the way the raw
// Shell interface now is.
//
// Used by both lib/themePackExportDialog.js (runs in the standalone
// widget-center-prefs-app.js process) and lib/globalScreenshotKeybinding.js
// (runs inside the Shell process via the extension) - same portal call
// works identically from either.
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

/**
 * Captures the desktop via the portal and returns a local filesystem path
 * to the resulting PNG. Rejects if the user declines the portal's own
 * permission prompt (some compositors/first calls show one), the request
 * times out, or the portal service isn't available at all (e.g. no
 * xdg-desktop-portal running - unlikely on a standard GNOME session, but
 * possible in minimal/headless test environments).
 */
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
            // Subscribe before making the call - the Request object doesn't
            // exist until the Screenshot() method runs, but a signal-match
            // rule registered ahead of time still catches it once it does.
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
                    // Actual success/failure arrives via the Response signal
                    // above, not this call's own return value - that just
                    // confirms the request was accepted and is in flight.
                } catch (e) {
                    finish(reject, e);
                }
            });
        } catch (e) {
            finish(reject, e);
        }
    });
}
