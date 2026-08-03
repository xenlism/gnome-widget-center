/** Endeavour OS Logo */

// Auto-converted from archey4's Python logo module.
// LOGO strings keep the original '{c[N]}' placeholders, which index into COLORS.

export const COLORS = [
    "#ff0000",
    "#cd00cd",
    "#0000ee",
];

export const LOGO = [
    "{c[0]}                     ./{c[1]}o{c[2]}.{c[0]}               ",
    "{c[0]}                   ./{c[1]}sssso{c[2]}-{c[0]}             ",
    "{c[0]}                 `:{c[1]}osssssss+{c[2]}-{c[0]}           ",
    "{c[0]}               `:+{c[1]}sssssssssso{c[2]}/.{c[0]}         ",
    "{c[0]}             `-/{c[1]}ssssssssssssso{c[2]}/.{c[0]}        ",
    "{c[0]}           `-/+{c[1]}sssssssssssssssso{c[2]}+:`{c[0]}     ",
    "{c[0]}         `-:/+{c[1]}sssssssssssssssssso{c[2]}/.{c[0]}     ",
    "{c[0]}       `.://o{c[1]}sssssssssssssssssssso{c[2]}++-{c[0]}   ",
    "{c[0]}      .://+{c[1]}ssssssssssssssssssssssso{c[2]}++:{c[0]}  ",
    "{c[0]}    .:///o{c[1]}ssssssssssssssssssssssssso{c[2]}++:{c[0]} ",
    "{c[0]}  `:////{c[1]}ssssssssssssssssssssssssssso{c[2]}+++.{c[0]}",
    "{c[0]}`-////+{c[1]}ssssssssssssssssssssssssssso{c[2]}++++-{c[0]}",
    "{c[0]} `..-+{c[1]}oosssssssssssssssssssssssso{c[2]}+++++/`{c[0]}",
    "{c[0]}   {c[2]}./++++++++++++++++++++++++++++++/:.{c[0]}  ",
    "{c[0]}  {c[2]}`:::::::::::::::::::::::::------``{c[0]}    ",
];

// Registry of all variants defined by this logo module, keyed by variant name.
// 'default' is the primary logo archey4 uses unless a variant is explicitly selected.
export const VARIANTS = {
    "default": {colors: COLORS, logo: LOGO},
};

export default VARIANTS.default;
