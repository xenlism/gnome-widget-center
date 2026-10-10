// Tiny i18n: tr("English", "ไทย"). Thai when the locale is th_*, otherwise English. Override with GWC_LANG=th|en.
import GLib from "gi://GLib";

const lang = (GLib.getenv("GWC_LANG") || GLib.getenv("LC_ALL") || GLib.getenv("LC_MESSAGES") || GLib.getenv("LANG") || "en").toLowerCase();
export const isThai = lang.startsWith("th");
export const tr = (en, th) => (isThai && th) ? th : en;
