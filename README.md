# GNOME Widget Center

[![Language](https://img.shields.io/badge/Language-GJS%20%2F%20JavaScript-yellow)](https://gjs.guide/)
[![Toolkit](https://img.shields.io/badge/Toolkit-GTK%204.0-blue)](https://www.gtk.org/)
[![License](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](LICENSE)

A desktop widget platform for GNOME Shell, built with GJS, GTK4, and
Libadwaita.

> **Status:** Alpha / preview. The current codebase is feature-rich and
> has passed static JavaScript checks, but a complete clean-session
> real-hardware GNOME Shell sign-off is still pending.

------------------------------------------------------------------------

## Overview

GNOME Widget Center brings desktop widgets to GNOME Shell in the spirit
of KDE Plasma Widgets while following GNOME Human Interface Guidelines
(HIG).

The current project is a GNOME Shell extension:

`gnome-widget-center@xenlism.github.io/`

It provides:

-   Widget discovery from bundled and user-installed widget folders.
-   Desktop rendering with fixed block sizes and free pixel placement.
-   Edit Mode drag-and-drop with magnetic snapping and collision-aware
    placement.
-   Per-widget settings generated from declarative `config.json`, with a
    custom `prefs.js` escape hatch.
-   A Control Center with Overview, Themes, and Preferences.
-   Widget screenshots shown in Overview cards when `metadata.json`
    declares a `screenshot`.
-   Appearance and theme management.
-   `.gwct` theme export/import.
-   Password-protected `.gwcbak` full backup and restore.

A widget communicates with the host through the `WidgetAPI` rather than
accessing GNOME Shell internals directly. See
`gnome-widget-center@xenlism.github.io/WIDGET_API.md` and
`gnome-widget-center@xenlism.github.io/SKILL.md`.

------------------------------------------------------------------------

## ❤️ Support Development

If GNOME Widget Center is useful to you, please consider supporting
development.

### Ko-fi

[![Support on
Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/xenlism)

### PayPal

[PayPal QR Code](assets/paypal.jpg)

### USDT (TRC20 Network)

[USDT TRC20 QR Code](assets/usdt.jpg)

Every contribution helps support development, maintenance, bug fixes,
and new features.

------------------------------------------------------------------------

## Screenshots

### Desktop

![Desktop](assets/desktop.png)

### Edit Mode

![Edit Mode](assets/editmode.png)

[▶️ Edit Mode video](assets/editmode.mp4)

### Widget Overview Cards

The Overview UI can use each widget's own screenshot:

``` json
{
  "id": "weather-dark",
  "name": "Weather (Dark)",
  "description": "Wide dark weather card...",
  "screenshot": "screenshot.png"
}
```

The image is resolved relative to the widget directory, so the example
above loads:

`widgets/weather-dark/screenshot.png`

This screenshot metadata is used by both the overlay Overview and the
extension Preferences Overview.

------------------------------------------------------------------------

## Current Project Status

  -----------------------------------------------------------------------
  Area                                Status
  ----------------------------------- -----------------------------------
  Widget discovery and loading        ✅ Implemented

  Bundled + user widget paths         ✅ Implemented

  Desktop widget rendering            ✅ Implemented

  Multi-monitor support               ✅ Implemented

  Per-widget settings and JSON        ✅ Implemented
  storage                             

  Declarative `config.json` settings  ✅ Implemented
  UI                                  

  Custom widget `prefs.js`            ✅ Implemented

  Live cross-process settings updates ✅ Implemented

  Control Center / Preferences        ✅ Implemented
  navigation                          

  Overview cards with metadata        ✅ Implemented
  screenshots                         

  Edit Mode                           ✅ Implemented

  Magnetic snapping / alignment       ✅ Implemented
  guides                              

  Appearance and theme service        ✅ Implemented

  `.gwct` theme export/import         ✅ Implemented

  `.gwcbak` full backup/restore       ✅ Implemented in code; runtime
                                      clean-machine test still pending

  Password-protected backup format    ✅ Implemented

  Backup archive path-traversal       ✅ Implemented
  validation                          

  Widget dependency checking          ✅ Implemented

  Internationalization                ✅ Implemented

  Bundled widget collection           ✅ Included

  Standalone GTK4 companion           ⏳ Not started
  application                         

  Installable Widget SDK / online     ⏳ Not started
  repository                          

  Full clean real-GNOME-Shell         🚧 Pending
  hardware sign-off                   
  -----------------------------------------------------------------------

### Verification note

The supplied project archive currently passes `node --check` across its
JavaScript files and contains the complete backup/restore
implementation.

The backup implementation checks for `tar`, creates a `.gwcbak` archive
containing host settings, widget settings, appearance data, and
user-installed widget files, then encrypts the archive using AES-256-CTR
with PBKDF2-HMAC-SHA256 key derivation and authenticates it with
HMAC-SHA256.

Restore verifies the backup header and authentication tag before
extraction, validates tar entry paths against traversal, restores
GSettings and widget files, then restores widget settings and themes.

A real GJS/GTK runtime test on a clean GNOME Shell session is still
required before describing backup/restore as fully hardware-verified.

------------------------------------------------------------------------

## Backup & Restore

### `.gwct` Theme Pack

`.gwct` is intended for theme/layout sharing.

It contains:

-   Desktop/widget positions.
-   Widget settings.
-   Appearance/theme configuration.

Sensitive fields are redacted during theme export.

### `.gwcbak` Full Backup

`.gwcbak` is intended as a personal "move house" backup rather than a
shareable theme.

A full backup includes:

-   Host extension settings.
-   Widget settings, including values that may contain passwords or API
    keys.
-   Appearance/theme state.
-   User-installed widget files.
-   A manifest describing the saved widget state.

Bundled widgets are not copied because they are supplied by the
extension itself.

Backups are password-protected and use:

-   AES-256-CTR for encryption.
-   PBKDF2-HMAC-SHA256 for key derivation.
-   HMAC-SHA256 for authentication/integrity checking.
-   A random salt and IV for each backup.

The backup format also validates archive paths before extraction to
prevent path traversal.

> **Security note:** the cryptographic primitives are implemented inside
> the project and have not received an independent security audit. Treat
> `.gwcbak` as protected application backup data, not as independently
> audited cryptographic software.

------------------------------------------------------------------------

## Features

### Desktop Widgets

-   Fixed-size widget blocks.
-   16px grid-based placement.
-   Free pixel positioning.
-   Magnetic snapping.
-   Alignment guides during drag.
-   Collision-aware placement.
-   Multi-monitor support.
-   Right-click widget actions.
-   Edit Mode overlay toolbar.
-   Per-widget appearance overrides.

### Widget Authoring

A widget can be added as a folder without a compiled schema.

Typical widget structure:

``` text
my-widget/
├── metadata.json
├── widget.js
├── screenshot.png
├── config.json
├── prefs.js
└── ...
```

`metadata.json` describes the widget identity, entry point, block type,
default position, and optional screenshot.

Example:

``` json
{
  "id": "my-widget",
  "name": "My Widget",
  "description": "Example widget",
  "version": "1.0.0",
  "author": "Developer",
  "api-version": 1,
  "entry": "widget.js",
  "block-type": "1x1",
  "screenshot": "screenshot.png"
}
```

Settings can be generated from `config.json`, while a custom `prefs.js`
can be used for more complex interfaces.

### Settings

The project supports declarative settings and custom settings pages,
including fields such as:

-   Text and textarea.
-   Boolean switches and checkboxes.
-   Dropdowns and radio choices.
-   Numeric controls.
-   Sliders.
-   Colors, fonts, and icons.
-   Files and folders.
-   Lists and object editors.
-   Location-related controls.
-   Conditional UI.

------------------------------------------------------------------------

## Themes

Theme state is handled by the theme service and can be applied globally
or per widget.

Theme packs use `.gwct` and can capture:

-   Appearance.
-   Widget layout.
-   Widget theme configuration.
-   Widget settings needed by the theme.

------------------------------------------------------------------------

## Widget Paths

Bundled widgets are shipped inside:

``` text
gnome-widget-center@xenlism.github.io/widgets/
```

User-installed widgets are loaded from:

``` text
~/.local/share/gnome-widget-center/widgets/
```

The backup system copies user-installed widget directories, while
bundled widgets are restored by reinstalling the extension.

------------------------------------------------------------------------

## Project Structure

``` text
development/
├── architecture/     # Architecture, contracts, and design notes
├── docs/             # Specifications and documentation
├── tasks/            # Task briefs and roadmap
└── tests/             # Test/e2e documentation

assets/                # Project screenshots and media

gnome-widget-center@xenlism.github.io/
├── lib/               # Host services and UI controllers
│   ├── crypto/        # Backup cryptographic primitives
│   ├── gjskit/        # GJS framework helpers
│   ├── backupService.js
│   ├── exportService.js
│   ├── themeService.js
│   ├── widgetLoader.js
│   ├── layoutEngine.js
│   ├── snapManager.js
│   ├── guideRenderer.js
│   ├── editModeDragController.js
│   └── ...
├── widgets/           # Bundled widgets
├── i18n/              # Translation data
├── schemas/           # GSettings schema
├── themepacks/        # Bundled .gwct theme packs
├── WIDGET_API.md      # Widget author contract
├── SKILL.md           # Condensed widget development guide
├── PROJECT_STATUS.md  # Project status and handover notes
├── extension.js       # GNOME Shell extension entry point
└── prefs.js           # Extension Preferences entry point
```

------------------------------------------------------------------------

## Technology

-   GJS / JavaScript
-   GNOME Shell
-   GTK4
-   Libadwaita
-   GObject / GSettings
-   Gio / GLib
-   Meson
-   GjsKit

------------------------------------------------------------------------

## Documentation

Start here when developing widgets:

-   `gnome-widget-center@xenlism.github.io/WIDGET_API.md`
-   `gnome-widget-center@xenlism.github.io/SKILL.md`
-   `gnome-widget-center@xenlism.github.io/PROJECT_STATUS.md`
-   `gnome-widget-center@xenlism.github.io/checklist.md`

------------------------------------------------------------------------

## Development Notes

The project currently contains both the main Preferences implementation
and the newer Preferences V2 controller. V2 provides the current
sidebar/accordion-style Preferences structure while preserving
compatibility with existing focus/navigation entry points.

The Overview card implementation is shared conceptually across the
overlay and Preferences surfaces: widget metadata is the source of the
card identity, description, and optional screenshot.

When adding a screenshot to a widget, keep the image inside the widget
directory and reference it from `metadata.json` using a relative path.

------------------------------------------------------------------------

## Vision

Longer term, GNOME Widget Center aims to grow beyond a single extension
into:

-   A stable documented Widget SDK.
-   A standalone GTK4 companion application.
-   A widget/theme repository with search, installation, updates, and
    ratings.
-   A broader host API for network, notifications, storage, and other
    services.

------------------------------------------------------------------------

## Contributing

Contributions, bug reports, testing reports, and feature suggestions are
welcome.

Before submitting changes, run JavaScript syntax checks and test the
affected functionality in a real GNOME Shell session when possible.


------------------------------------------------------------------------

## License

GNU General Public License v3.0

------------------------------------------------------------------------

## 👥 Visitor

![](https://github-visitor-counter-tau.vercel.app/api?username=xenlism&repo=gnome-widget-center&displayMode=topCountries&theme=transparent&showlabels=true&text=949494)
