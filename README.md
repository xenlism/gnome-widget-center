<div align="center">

# 🧩 GNOME Widget Center

**Bring KDE-Plasma-style desktop widgets to GNOME Shell — without leaving the GNOME way of doing things.**

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-4A86CF?logo=gnome&logoColor=white)](https://www.gnome.org/)
[![Language](https://img.shields.io/badge/Language-GJS%20%2F%20JavaScript-yellow)](https://gjs.guide/)
[![Toolkit](https://img.shields.io/badge/Toolkit-GTK%204%20%2F%20Libadwaita-blue)](https://www.gtk.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Pre--release-yellow)](development/PROJECT_STATUS.md)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/xenlism)

</div>

---

> ### ⏳ Project status: **pre-release — submitted to extensions.gnome.org, awaiting review**
>
> The extension has been submitted to [extensions.gnome.org](https://extensions.gnome.org/) (EGO)
> and is currently pending review. `metadata.json` still tracks an internal build number
> instead of a public version number until that review completes, and `shell-version`
> currently declares **GNOME Shell 50** only. The code is functionally complete for
> everything described below and has passed syntax checks and mocked unit tests, but most
> of it has **not yet been confirmed end-to-end on real GNOME Shell hardware** — see
> [`development/PROJECT_STATUS.md`](development/PROJECT_STATUS.md), including its "Latest
> manual test pass" section, for the exact verification state of each feature before you
> treat this changelog as a "works on my machine" guarantee. **Back up an important desktop
> setup before trying it, and please report anything that breaks.**

---

## Table of contents

- [What it is](#what-it-is)
- [Screenshots](#screenshots)
- [Highlights](#highlights)
- [Widgets and Widget-Architects](#widgets-and-widget-architects)
- [Make every widget yours](#make-every-widget-yours)
- [Theme Packs — share a whole desktop setup](#theme-packs--share-a-whole-desktop-setup)
- [Backup & restore](#backup--restore)
- [Multilingual out of the box](#multilingual-out-of-the-box)
- [User files and folders](#user-files-and-folders)
- [Build your own widgets](#build-your-own-widgets)
- [Install](#install)
- [Project layout](#project-layout)
- [Support development](#support-development)
- [License](#license)
- [Agent team](#agent-team)

---

## What it is

**GNOME Widget Center** is a GNOME Shell extension that lets you drop live, configurable
widgets straight onto your desktop — clocks, calendars, weather, system monitors, media
controls, app launchers, and more — and arrange them visually, the way you would in KDE
Plasma, while staying inside the [GNOME Human Interface Guidelines](https://developer.gnome.org/hig/).

Everything is managed from a single **Control Center**: turn widgets on or off, drag them
into place, tune their appearance, package the whole look as a shareable **Theme Pack**, and
back the entire thing up — all without restarting GNOME Shell.

## Screenshots

![Desktop with several widgets arranged on it](assets/desktop.png)

### Edit Mode

![Drag-and-drop Edit Mode with snapping guides](assets/editmode.png)

[▶ Watch the Edit Mode video](assets/editmode.mp4)

## Highlights

- 🖱️ **One Control Center** to add, enable, disable, and configure every desktop widget.
- ✏️ **Edit Mode** — drag-and-drop placement with snapping, a grid, and multi-monitor support.
- 🎨 **Deep per-widget styling** — background, border, shadow, blur, opacity, and corner radius, mixed and matched freely.
- 📦 **Theme Packs** — export, import, and share a complete desktop look as a single `.gwct` file, screenshot included.
- 💾 **Password-protected full backups** (`.gwcbak`, AES‑256 / PBKDF2) that cover every widget's settings, host preferences, and installed widget files.
- 🧱 **Bring your own widgets** — install user widgets without touching the extension itself.
- 🌍 **Localized UI** across the Control Center, the overlay, and settings dialogs.
- 🏗️ **Widget-Architects** — one widget design that spawns any number of independently-configured children.

Out of the box the extension ships **55 ready-to-use widgets** across clocks, calendars,
weather, system monitors (CPU/RAM/disk/network, in bar, circular, and "geek" archey-style
layouts), media controls, launchers, and utility panels — plus one bundled Theme Pack
(`Geek-Minimal-Half-Moon`) to try the concept immediately.

## Widgets and Widget-Architects

GNOME Widget Center supports two kinds of building blocks.

### Widgets

Ready-to-use desktop components — clocks, calendars, weather, system monitors, media
controls, launchers, shortcuts, and more. Each widget only exposes the settings that make
sense for its job, so a simple clock stays simple while a system monitor can offer much
richer controls.

### Widget-Architects

A Widget-Architect is a widget that creates its own **child widgets** — ideal when you want
several instances of the same design with different settings, like one launcher tile per
app, or several info cards showing different data.

1. Add the Architect widget to the desktop.
2. Enter **Edit Mode** and select/right-click the Architect widget.
3. Click **+ Add Widget** in its edit toolbar.
4. Configure the new child. It's an independent widget instance that still shares the
   Architect's underlying design.

The `+ Add Widget` action only ever appears on the Architect parent, so a child can't
accidentally spawn grandchildren.

## Make every widget yours

Most themeable widgets expose a common set of visual controls you can combine freely:

| Setting | What it changes | Ideas to try |
| --- | --- | --- |
| **Background color** | The card's fill color; alpha controls transparency. | A translucent dark card over a busy wallpaper, or a solid accent card for a launcher. |
| **Corner radius** | How rounded the card's corners are. | Large radius for soft, modern cards; off for sharp dashboard panels. |
| **Shadow** | A drop shadow with adjustable color, opacity, blur, distance, and direction. | A subtle dark shadow to separate transparent cards from a busy wallpaper. |
| **Background blur** | Softens whatever sits behind a translucent card. | Pair with a transparent background for a glass-like look. |
| **Border color and width** | An outline around the card. | A low-opacity border to define a card without weighing it down. |
| **Opacity** | Fades the whole widget, text and icons included. | Lower it for background info; keep controls at full opacity for legibility. |

> **Blur note:** background blur depends on GNOME Shell and your graphics/compositor stack.
> A known GNOME limitation can make blur unavailable or inconsistent on some systems — every
> other appearance setting keeps working normally regardless.

There's no single "correct" style: mix transparency, blur, soft shadows, and rounded corners
for a glassmorphism look, or go opaque with square corners and borders for a crisp dashboard.
Every setting is per-widget, so your clock, launcher, and monitor can each have their own
character.

## Theme Packs — share a whole desktop setup

A Theme Pack captures more than colors — it makes an entire widget layout and its
configuration portable. Export a setup to share with someone else, keep versioned desktop
looks around, or move your setup to another machine. Importing a pack restores the saved
appearance and widget configuration in one step.

Press **Super + Delete** any time while preparing a Theme Pack to capture your desktop — the
screenshot is attached to the export automatically, making shared packs easier to preview
and recognize.

## Backup & restore

For everything a Theme Pack doesn't cover — secrets included — there's a full,
password-protected backup format (`.gwcbak`, AES‑256 with a PBKDF2-derived key). It captures
appearance, every widget's settings (including passwords and API keys), host preferences,
and the widget files themselves for anything you installed yourself, and can restore the
whole thing back in one pass.

## Multilingual out of the box

The Control Center, the in-session overlay, and every settings dialog and confirmation
prompt are localized. Six languages currently ship complete UI translations:

| Code | Language |
| --- | --- |
| `en` | English |
| `th` | ไทย (Thai) |
| `de` | Deutsch (German) |
| `es` | Español (Spanish) |
| `ja` | 日本語 (Japanese) |
| `zh` | 中文 (Chinese, Simplified) |

The extension follows your system locale automatically, or you can force a language from
**Preferences → Advanced**. Adding a new language is a matter of dropping a `<code>.js` file
into `gnome-widget-center@xenlism.github.io/i18n/` with the same keys as
[`i18n/en.js`](gnome-widget-center@xenlism.github.io/i18n/en.js) — the loader
(`i18n/index.js`) picks it up automatically, no build step required.

## User files and folders

GNOME Widget Center keeps your content separate from the extension itself, which makes
upgrades safer and your work easy to back up or share.

| Folder | Purpose |
| --- | --- |
| `~/.config/gnome-widget-center/themepacks` | Your downloaded and exported Theme Packs. |
| `~/.config/gnome-widget-center/widgets` | Your per-widget configuration and settings. |
| `~/.local/share/gnome-widget-center/widgets` | Your installed user widgets, including Architect-created children. |

## Build your own widgets

The extension is designed to make widget development approachable. A widget can describe
its preferences declaratively in `config.json`; the Control Center reads that file and
generates the settings UI for you — text, colors, fonts, switches, numeric controls,
dropdowns, and more — no custom preferences window required for common cases.

Start from the included templates:

- [`development/widget-templates/template`](development/widget-templates/template) — a normal widget.
- [`development/widget-templates/architect-template`](development/widget-templates/architect-template) — a Widget-Architect that creates configurable children.

Then read [Creating Widgets](docs/CREATING_WIDGETS.md) and the
[Widget API reference](gnome-widget-center@xenlism.github.io/WIDGET_API.md) for the full
development workflow and available APIs.

## Install

1. Extract the release archive and open a terminal in the extracted folder.
2. Run:

   ```bash
   chmod +x install.sh
   ./install.sh
   ```

   The installer reads the extension UUID from
   `gnome-widget-center@xenlism.github.io/metadata.json`, installs it under
   `~/.local/share/gnome-shell/extensions/`, recompiles the bundled GSettings schema, and
   attempts to enable it. Any existing installation is moved to a timestamped backup folder
   first.

3. If it doesn't enable automatically, open **Extensions** and enable **GNOME Widget
   Center** by hand. On Wayland, log out and back in if it doesn't appear right away.

To update, extract a newer archive and run `./install.sh` again.

## Project layout

```
gnome-widget-center-main/
├── gnome-widget-center@xenlism.github.io/   # the extension itself (installed as-is)
│   ├── extension.js, prefs.js               # entry points
│   ├── lib/                                 # host logic (loader, layout, settings, i18n…)
│   ├── i18n/                                # en / th / de / es / ja / zh translations
│   ├── widgets/                             # 55 bundled widgets
│   ├── themepacks/                          # bundled Theme Pack(s)
│   └── schemas/                             # GSettings schema
├── development/                             # roadmap, project status, templates, tests, docs
├── docs/                                    # user-facing docs (Creating Widgets, etc.)
├── assets/                                  # README screenshots/video
└── install.sh                               # installer used above
```

## Support development

If GNOME Widget Center makes your desktop better, please consider supporting its continued
development — contributions help fund maintenance, bug fixes, documentation, and new
widgets.

[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor_on_GitHub-GitHub_Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/xenlism)

- [GitHub Sponsors](https://github.com/sponsors/xenlism)
- [![Support on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/xenlism)
- USDT (TRC20) — see below

### USDT (TRC20) address

Copy this address when sending USDT on the TRON network:

```text
TLKY1oapYpq6NcjhXhnvdHmkDtStid16JS
```

## License

GPL-3.0. See [LICENSE](LICENSE).

## Agent team

| Agent | Role |
| --- | --- |
| **Nox ChatGPT** | Planning, code review, and project documentation. |
| **Keal Claude** | Coding and implementation. |
| **Veda Z.ai GLM 5.2** | New ideas and alternative solutions. |
