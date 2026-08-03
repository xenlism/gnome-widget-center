/** Raspbian logo */

// Auto-converted from archey4's Python logo module.
// LOGO strings keep the original '{c[N]}' placeholders, which index into COLORS.

export const COLORS = [
    "#ff0000",
    "#00cd00",
];

export const LOGO = [
    "{c[0]}   {c[1]}.',;:cc;,'.{c[0]}    {c[1]}.,;::c:,,.{c[0]} ",
    "{c[0]}  {c[1]},ooolcloooo:{c[0]}  {c[1]}'oooooccloo:{c[0]} ",
    "{c[0]}  {c[1]}.looooc;;:ol{c[0]}  {c[1]}:oc;;:ooooo'{c[0]} ",
    "{c[0]}    {c[1]};oooooo:{c[0]}      {c[1]},ooooooc.{c[0]}  ",
    "{c[0]}      {c[1]}.,:;'.{c[0]}       {c[1]}.;:;'.{c[0]}    ",
    "{c[0]}      .dQ. .d0Q0Q0. '0Q.     ",
    "{c[0]}    .0Q0'   'Q0Q0Q'  'Q0Q.   ",
    "{c[0]}    ''  .odo.    .odo.  ''   ",
    "{c[0]}   .  .0Q0Q0Q'  .0Q0Q0Q.  .  ",
    "{c[0]} ,0Q .0Q0Q0Q0Q  'Q0Q0Q0b. 0Q.",
    "{c[0]} :Q0  Q0Q0Q0Q    'Q0Q0Q0  Q0'",
    "{c[0]} '0    '0Q0' .0Q0. '0'    'Q'",
    "{c[0]}   .oo.     .0Q0Q0.    .oo.  ",
    "{c[0]}   'Q0Q0.  '0Q0Q0Q0. .Q0Q0b  ",
    "{c[0]}    'Q0Q0.  '0Q0Q0' .d0Q0Q'  ",
    "{c[0]}     'Q0Q'    ..    '0Q.'    ",
    "{c[0]}           .0Q0Q0Q.          ",
    "{c[0]}            '0Q0Q'           ",
];

// Registry of all variants defined by this logo module, keyed by variant name.
// 'default' is the primary logo archey4 uses unless a variant is explicitly selected.
export const VARIANTS = {
    "default": {colors: COLORS, logo: LOGO},
};

export default VARIANTS.default;
