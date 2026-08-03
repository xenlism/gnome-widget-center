/** Linux logo (tux) */

// Auto-converted from archey4's Python logo module.
// LOGO strings keep the original '{c[N]}' placeholders, which index into COLORS.

export const COLORS = [
    "#ffffff",
    "#ffff00",
];

export const LOGO = [
    "{c[0]}          a8888b.       ",
    "{c[0]}         d888888b.      ",
    "{c[0]}         8P\"YP\"Y88      ",
    "{c[0]}         8|o||o|88      ",
    "{c[0]}         8{c[1]}\\vvvv/{c[0]}88      ",
    "{c[0]}         8{c[1]} \\vv/ {c[0]}Y8.     ",
    "{c[0]}        d/  {c[1]}`'{c[0]}  \\8b.    ",
    "{c[0]}      .dP   .     Y8b.  ",
    "{c[0]}     d8:'   \"   `::88b. ",
    "{c[0]}    d8\"           `Y88b ",
    "{c[0]}   :8P     '       :888 ",
    "{c[0]}    8a.    :      _a88P ",
    "{c[0]}  {c[1]}._/\"{c[0]}Yaa_ :    .{c[1]}| {c[0]}88P{c[1]}|{c[0]} ",
    "{c[0]} {c[1]}\\++++{c[0]}YP\"      `{c[1]}| {c[0]}8P{c[1]}++\\.{c[0]}",
    "{c[0]} {c[1]}/+++++\\.{c[0]}_____.d{c[1]}|+++++/{c[0]} ",
    "{c[0]}  {c[1]}\\++++++){c[0]}888888P{c[1]}\\+++/{c[0]}  ",
];

// Registry of all variants defined by this logo module, keyed by variant name.
// 'default' is the primary logo archey4 uses unless a variant is explicitly selected.
export const VARIANTS = {
    "default": {colors: COLORS, logo: LOGO},
};

export default VARIANTS.default;
