/** Red Hat logo */

// Auto-converted from archey4's Python logo module.
// LOGO strings keep the original '{c[N]}' placeholders, which index into COLORS.

export const COLORS = [
    "#ff0000",
    "#ffffff",
];

export const LOGO = [
    "{c[0]}            .MM:..:MMMMMMM.               ",
    "{c[0]}           MMMMMMMMMMMMMMMMMM             ",
    "{c[0]}           MMMMMMMMMMMMMMMMMMMM.          ",
    "{c[0]}          MMMMMMMMMMMMMMMMMMMMMM          ",
    "{c[0]}         ,MMMMMMMMMMMMMMMMMMMMMM:         ",
    "{c[0]}         MMMMMMMMMMMMMMMMMMMMMMMM         ",
    "{c[0]}   .MMMM'  MMMMMMMMMMMMMMMMMMMMMM         ",
    "{c[0]} MMMMMM    `MMMMMMMMMMMMMMMMMMMM.         ",
    "{c[0]} MMMMMMMM      MMMMMMMMMMMMMMMMMM .       ",
    "{c[0]} MMMMMMMMM.       `MMMMMMMMMMMMM' MM.     ",
    "{c[0]} `MMMMMMMMMMMMM.        `\"\"`     ,MMMMM.  ",
    "{c[0]} `MMMMMMMMMMMMMMMMM:.         .:MMMMMMMM. ",
    "{c[0]}     MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM ",
    "{c[0]}       MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM: ",
    "{c[0]}          MMMMMMMMMMMMMMMMMMMMMMMMMMMMMM  ",
    "{c[0]}             `MMMMMMMMMMMMMMMMMMMMMMMM:   ",
    "{c[0]}                 ``MMMMMMMMMMMMMMMMM'     ",
    "{c[0]}                           `\"\"`           ",
    "{c[1]}              R e d   H a t               ",
];

export const COLORS_HAT = COLORS;

export const LOGO_HAT = LOGO;

export const COLORS_SHADOWMAN = [
    "#ff0000",
    "#ffffff",
    "#cd0000",
];

export const LOGO_SHADOWMAN = [
    "{c[0]}              {c[2]}\\`.-..........\\`{c[0]}            ",
    "{c[0]}             {c[2]}\\`////////::.\\`-/.{c[0]}           ",
    "{c[0]}             {c[2]}-: ....-////////.{c[0]}            ",
    "{c[0]}             {c[2]}//:-::///////////\\`{c[0]}          ",
    "{c[0]}      {c[2]}\\`--::: \\`-://////////////:{c[0]}         ",
    "{c[0]}      {c[2]}//////-    \\`\\`.-://///////{c[0]} .\\`     ",
    "{c[0]}      {c[2]}\\`://////:-.\\`    :///////::///:\\`{c[0]}  ",
    "{c[0]}        {c[2]}.-/////////:---/////////////:{c[0]}     ",
    "{c[0]}           {c[2]}.-://////////////////////.{c[0]}     ",
    "{c[0]}          {c[1]}yMN+\\`.-${c[2]}::///////////////-\\`{c[0]}   ",
    "{c[0]}       {c[1]}.-\\`:NMMNMs\\`  \\`..-------..\\`{c[0]}     ",
    "{c[0]}        {c[1]}MN+/mMMMMMhoooyysshsss{c[0]}            ",
    "{c[0]} {c[1]}MMM    MMMMMMMMMMMMMMyyddMMM+{c[0]}            ",
    "{c[0]}  {c[1]}MMMM   MMMMMMMMMMMMMNdyNMMh\\`     hyhMMM{c[0]}",
    "{c[0]}   {c[1]}MMMMMMMMMMMMMMMMyoNNNMMM+.   MMMMMMMM{c[0]}  ",
    "{c[0]}    {c[1]}MMNMMMNNMMMMMNM+ mhsMNyyyyMNMMMMsMM{c[0]}   ",
];

// Registry of all variants defined by this logo module, keyed by variant name.
// 'default' is the primary logo archey4 uses unless a variant is explicitly selected.
export const VARIANTS = {
    "default": {colors: COLORS, logo: LOGO},
    "HAT": {colors: COLORS_HAT, logo: LOGO_HAT},
    "SHADOWMAN": {colors: COLORS_SHADOWMAN, logo: LOGO_SHADOWMAN},
};

export default VARIANTS.default;
