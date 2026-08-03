/** Guix System logo */

// Auto-converted from archey4's Python logo module.
// LOGO strings keep the original '{c[N]}' placeholders, which index into COLORS.

export const COLORS = [
    "#ffff00",
    "#cd0000",
    "#cdcd00",
];

export const LOGO = [
    "{c[0]} +                                    ? ",
    "{c[0]} ??                                  ?{c[2]}I{c[0]} ",
    "{c[0]}  {c[2]}??{c[1]}I{c[0]}?   I??N              $???    $?{c[1]}?{c[2]}??{c[0]}",
    "{c[0]}   {c[2]}?{c[1]}III7{c[0]}$???????          ??????${c[1]}7III?Z{c[0]} ",
    "{c[0]}     {c[1]}OI77{c[0]}$$?????         ?????$${c[1]}77IIII{c[0]}  ",
    "{c[0]}           ?????        $????           ",
    "{c[0]}            ???{c[1]}ID{c[0]}      $????            ",
    "{c[0]}             {c[1]}IIII{c[0]}     $+????            ",
    "{c[0]}             {c[1]}IIIII{c[0]}    $????             ",
    "{c[0]}              {c[1]}IIII{c[0]}   $?????             ",
    "{c[0]}              {c[1]}IIIII{c[0]}  $????              ",
    "{c[0]}               {c[1]}II77{c[0]} $????$              ",
    "{c[0]}               {c[1]}7777{c[2]}+${c[0]}????               ",
    "{c[0]}                {c[1]}77{c[2]}++?${c[0]}??$               ",
    "{c[0]}                {c[1]}N{c[2]}?+???${c[0]}?                ",
];

// Registry of all variants defined by this logo module, keyed by variant name.
// 'default' is the primary logo archey4 uses unless a variant is explicitly selected.
export const VARIANTS = {
    "default": {colors: COLORS, logo: LOGO},
};

export default VARIANTS.default;
