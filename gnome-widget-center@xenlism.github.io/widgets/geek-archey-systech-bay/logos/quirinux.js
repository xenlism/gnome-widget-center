/** Quirinux logo */

// Auto-converted from archey4's Python logo module.
// LOGO strings keep the original '{c[N]}' placeholders, which index into COLORS.

export const COLORS = [
    "#ff00ff",
    "#ffffff",
];

export const LOGO = [
    "{c[0]}           @=++++++++++=@          ",
    "{c[0]}        =++++++++++++++++++=       ",
    "{c[0]}      *++++++++++++++++++++++*     ",
    "{c[0]}    =++++++++++++++++++++++++++=   ",
    "{c[0]}   *++++++++{c[1]}-..........-{c[0]}++++++++*  ",
    "{c[0]}  =++++++++{c[1]}..............{c[0]}++++++++= ",
    "{c[0]} @++++++++{c[1]}:.....:{c[0]}++{c[1]}:.....:{c[0]}++++++++@",
    "{c[0]} =++++++++{c[1]}:.....{c[0]}++++{c[1]}.....:{c[0]}++++++++=",
    "{c[0]} =++++++++{c[1]}:.....{c[0]}++++{c[1]}.....:{c[0]}++++++++=",
    "{c[0]} #++++++++{c[1]}:.....{c[0]}++++{c[1]}.....:{c[0]}++++++++#",
    "{c[0]}  +++++++++{c[1]}......{c[0]}--{c[1]}......{c[0]}+++++++++ ",
    "{c[0]}  @++++++++{c[1]}:............:{c[0]}++++++++@ ",
    "{c[0]}   @+++++++++++{c[1]}-....-{c[0]}+++++++++++@  ",
    "{c[0]}     *++++++++++{c[1]}::::{c[0]}++++++++++*    ",
    "{c[0]}       *++++++++++++++++++++*      ",
    "{c[0]}         @*++++++++++++++*@        ",
    "{c[0]}              @#====#@             ",
];

// Registry of all variants defined by this logo module, keyed by variant name.
// 'default' is the primary logo archey4 uses unless a variant is explicitly selected.
export const VARIANTS = {
    "default": {colors: COLORS, logo: LOGO},
};

export default VARIANTS.default;
