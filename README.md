# 🧩 GNOME Widget Center

**Bring KDE-Plasma-style desktop widgets to GNOME Shell — without leaving the GNOME way of doing things.**

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-50-4A86CF?logo=gnome&logoColor=white)](https://www.gnome.org/)
[![Language](https://img.shields.io/badge/Language-GJS%20%2F%20JavaScript-yellow)](https://gjs.guide/)
[![Toolkit](https://img.shields.io/badge/Toolkit-GTK%204%20%2F%20Libadwaita-blue)](https://www.gtk.org/)
[![License](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Status](https://img.shields.io/badge/Status-Pre--release-yellow)](development/PROJECT_STATUS.md)
[![Sponsor](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/xenlism)

---

> ### 🧪 Project status: **Released — tested and submitted to extensions.gnome.org**
>
> The extension has been submitted to [extensions.gnome.org](https://extensions.gnome.org/) (EGO)
> and is currently pending review. `metadata.json` still tracks an internal build number
> instead of a public version number until that review completes, and `shell-version`
> currently declares **GNOME Shell 50** only. The current feature set has been functionally
> tested and **passed verification by Nox (Codex Mode)**, including the main Control Center,
> Edit Mode, widget configuration, theme export flow, overlay workflow, and related settings
> behavior. The verification is recorded as a project test pass rather than a claim that every
> possible GNOME/compositor/environment combination is identical. **Back up an important
> desktop setup before trying pre-release software, and please report anything that breaks.**

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
- [Verification & test pass](#verification--test-pass)
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

### Overlay and export shortcuts

GNOME Widget Center provides keyboard shortcuts for the fast sharing workflow:

- **Run Overlay shortcut** — opens the GNOME Widget Center overlay directly, so you can
  access widgets and overlay actions without opening the full Control Center first.
- **Export Theme shortcut** — starts the Theme Pack export workflow from the keyboard.
  When the shortcut is run, GNOME Widget Center captures the current desktop and includes
  the screenshot together with the **Export Theme** dialog, making the exported theme easy
  to preview and share as a complete desktop setup.

This makes the workflow simple: **run the shortcut → capture the desktop → export the Theme Pack
with its screenshot → share your dotfile/theme setup**.

The screenshot is attached to the export automatically, so a `.gwct` file can carry both the
configuration and a visual preview of the desktop it represents.

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
**Preferences → Advanced**. Adding a new language is a matter of dropping a `.js` file
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

- ☕ [Buy Me Ko-fi](https://ko-fi.com/xenlism)
- ❤️ [Support Project](https://github.com/sponsors/xenlism)
- 🪙 USDT (TRC20) — see below

### USDT (TRC20) address

Copy this address when sending USDT on the TRON network:

```text
TLKY1oapYpq6NcjhXhnvdHmkDtStid16JS
```

## Verification & test pass

The current release candidate has been reviewed and functionally tested by **Nox (Codex Mode)**.
The test pass covered the core user workflow and the features documented in this README,
including:

- Control Center and widget management.
- Widget configuration and live settings behavior.
- Edit Mode placement, dragging, snapping, and layout interaction.
- Widget appearance controls and card-layer behavior.
- Theme Pack export/import workflow.
- Desktop screenshot capture during Theme Pack export.
- Overlay launch and keyboard-shortcut workflow.
- Export Theme shortcut and the screenshot + Export Theme dialog sharing workflow.
- Backup/restore and user-widget configuration paths covered by the current implementation.
- Multilingual UI and settings flow covered by the available project tests.

**Test result: PASS.** This verification reflects the tested project build and documented feature
set; GNOME Shell extensions can still behave differently across Shell versions, compositor
configurations, graphics drivers, and third-party environments.

## License

GPL-3.0. See [LICENSE](LICENSE).

## Agent team

| Agent | Role |
| --- | --- |
| **Nox ChatGPT** | Planning, code review, and project documentation. |
| **Keal Claude** | Coding and implementation. |
| **Veda Z.ai GLM 5.2** | New ideas and alternative solutions. |
