// prefsKeys.js - keyboard helpers shared by the preferences shortcut rows.
import Gdk from "gi://Gdk";

export function isModifierKeyval(keyval) {
    return [ Gdk.KEY_Control_L, Gdk.KEY_Control_R, Gdk.KEY_Shift_L, Gdk.KEY_Shift_R, Gdk.KEY_Alt_L, Gdk.KEY_Alt_R, Gdk.KEY_Super_L, Gdk.KEY_Super_R, Gdk.KEY_Meta_L, Gdk.KEY_Meta_R, Gdk.KEY_Hyper_L, Gdk.KEY_Hyper_R, Gdk.KEY_ISO_Level3_Shift, Gdk.KEY_ISO_Level5_Shift, Gdk.KEY_Caps_Lock, Gdk.KEY_Shift_Lock, Gdk.KEY_Num_Lock, Gdk.KEY_Scroll_Lock ].includes(keyval);
}
