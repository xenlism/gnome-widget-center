/** Armbian logo */

// Auto-converted from archey4's Python logo module.
// LOGO strings keep the original '{c[N]}' placeholders, which index into COLORS.

export const COLORS = [
    "#ff0000",
    "#e5e5e5",
];

export const LOGO = [
    "{c[1]}                 ..                 ",
    "{c[1]}             `:]x**j-,'             ",
    "{c[1]}        .,+t***********z\\<\"         ",
    "{c[1]}        ?******************;        ",
    "{c[1]}       '*n` .'`^,;;,^`'. ,cc.       ",
    "{c[1]}       -<.                .[l       ",
    "{c[1]}      //     ^^      ^^    \\\\       ",
    "{c[1]}      !^         {c[0]}^^{c[1]}         \":      ",
    "{c[1]}     'tt}}`     {c[0]}!~]rj_{c[1]}     \")t/.     ",
    "{c[1]}     Itttt?'   {c[0]}~~]rr]{c[1]}   `{{tttt,     ",
    "{c[1]}     \\tttttt!\"\"I{c[0]}_]r({c[1]}\"\"\"~tttttt1     ",
    "{c[1]}   '_tttttttttttt{c[0]})f{c[1]}tttttttttttti.   ",
    "{c[1]}  \\*ztttttttttttttttttttttttttf**[  ",
    "{c[1]} l**c)tttttttttttttttttttttttt(z**, ",
    "{c[1]} .z*x.`tttttttttttttttttttttttt.`u*n",
    "{c[1]} >`   (tttttttttttttttttttttt]   \"I ",
    "{c[1]}      ,tttttttttttttttttttttt`      ",
    "{c[1]}      ./ttttt{c[0]}f{c[1]}tttttttt{c[0]}f{c[1]}ttttt(       ",
    "{c[1]}       'I){c[0]}))(\\()({c[1]}tt{c[0]}))|\\()({c[1]}{{;'       ",
    "{c[1]}         {c[0]}.~~~~~~~|)~~~~~~~<{c[1]}         ",
    "{c[1]}         '{c[0]}[)))))1{c[1]}|({c[0]}))))))){c[1]}?         ",
    "{c[1]}           {c[0]}\",,,\"{c[1]}    {c[0]}\",,,^{c[1]}           ",
];

export const COLORS_CHIPSET = COLORS;

export const LOGO_CHIPSET = [
    "{c[0]}    \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588   ",
    "{c[0]}   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588  ",
    "{c[0]} \u2584\u2584\u2588\u2588                   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588    \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588    \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588   \u2588\u2588         \u2588\u2588   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588   \u2588\u2588         \u2588\u2588   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588   \u2588\u2588         \u2588\u2588   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588   \u2588\u2588         \u2588\u2588   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588   \u2588\u2588         \u2588\u2588   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588   \u2588\u2588         \u2588\u2588   \u2588\u2588\u2584\u2584",
    "{c[0]} \u2584\u2584\u2588\u2588                   \u2588\u2588\u2584\u2584",
    "{c[0]}   \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588  ",
    "{c[0]}    \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588 \u2588   ",
];

// Registry of all variants defined by this logo module, keyed by variant name.
// 'default' is the primary logo archey4 uses unless a variant is explicitly selected.
export const VARIANTS = {
    "default": {colors: COLORS, logo: LOGO},
    "CHIPSET": {colors: COLORS_CHIPSET, logo: LOGO_CHIPSET},
};

export default VARIANTS.default;
