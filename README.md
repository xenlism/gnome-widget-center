# GNOME Widget Center
[![Language](https://img.shields.io/badge/Language-GJS%20%2F%20JavaScript-yellow)](https://gjs.guide/)
[![Toolkit](https://img.shields.io/badge/Toolkit-GTK%204.0-blue)](https://www.gtk.org/)
[![License](https://img.shields.io/badge/License-GPL%203.0-blue.svg)](LICENSE)

A modern desktop widget platform for GNOME Shell built with GJS, GTK4 and Libadwaita.

> **Status:** Pre-Alpha

---

## Overview

GNOME Widget Center is a modern desktop widget platform inspired by KDE Plasma Widgets while following the GNOME Human Interface Guidelines (HIG).

The project is built around three main components:

- GNOME Shell Extension
- GNOME Widget Center Application
- Widget SDK

Widgets never interact directly with GNOME Shell internals. Instead, they communicate exclusively through the Widget SDK, providing a stable and maintainable development environment.

---

## Screenshots

### Dashboard

![Dashboard](assets/screenshots/dashboard.png)

### Desktop

![Desktop](assets/screenshots/desktop.png)

---

## Current Status

| Component | Status |
|-----------|--------|
| Architecture | ✅ Complete |
| Specifications | ✅ Complete |
| Widget SDK Design | ✅ Complete |
| Theme Package Design | ✅ Complete |
| Widget Loader | 🚧 In Progress |
| Widget Layer | 🚧 In Progress |
| Settings Store | 🚧 In Progress |
| Preferences | ⏳ Planned |
| Widget Repository | ⏳ Planned |

---

## Vision

GNOME Widget Center aims to provide:

- Desktop Widgets
- Stable Widget SDK
- Theme Packages
- Widget Repository
- Multi-monitor Support
- GTK4 Preferences
- High Performance
- Developer-friendly APIs

---

## Features

### Desktop Widgets

- Desktop Widget Layer
- Fixed-size Widgets
- 16px Grid Layout
- Drag & Drop
- Desktop Edit Mode
- Right-click Context Menu

### Widget SDK

Widgets communicate through the SDK instead of directly accessing GNOME Shell.

Planned SDK modules include:

- Configuration
- Dashboard
- Theme
- Media
- Network
- Notifications
- Storage
- Logger
- Repository
- AI

### Theme Packages

Theme Packages replace traditional backup and restore.

A package can include:

- Desktop Layout
- Installed Widgets
- Widget Settings
- Theme Configuration
- Wallpaper (Optional)
- Fonts (Optional)

### Widget Repository

Planned features:

- Install Widgets
- Update Widgets
- Search
- Categories
- Ratings
- Screenshots

---

## Architecture

```text
GNOME Widget Center Application
            │
            ▼
       Widget SDK
            │
            ▼
      Widget Runtime
            │
            ▼
GNOME Shell Extension
            │
            ▼
      Desktop Widget Layer
```

---

## Project Structure

```text
development/
├── architecture/
├── roadmap/
├── specifications/
├── tasks/
└── tools/

products/
├── application/
├── extension/
├── sdk/
├── widgets/
└── assets/

website/

docs/
```

---

## Roadmap

### Phase 0 — Foundation

- ✅ Project setup
- ✅ Repository structure
- ✅ Architecture
- ✅ Specifications

### Phase 1 — Core Runtime

- Widget Loader
- Widget Layer
- Widget Runtime
- Settings Store
- Drag Runtime

**Milestone:** Desktop widgets can be displayed.

### Phase 2 — Desktop Experience

- Preferences
- Widget Configuration
- Desktop Edit Mode
- Multi-monitor Support

**Milestone:** Users can manage widgets visually.

### Phase 3 — Widget SDK

- Widget SDK
- Example Widgets
- Hot Reload
- Developer Documentation

**Milestone:** Third-party widget development.

### Phase 4 — Public Preview

- Testing
- Packaging
- Documentation
- Preview Release

### Phase 5 — Themes

- Theme Manager
- Theme Packages
- Import / Export
- Theme Sharing

### Phase 6 — Widget Repository

- Online Repository
- Widget Installation
- Widget Updates
- Ratings
- Categories

### Future

- AI Widgets
- Cloud Synchronization
- Online Theme Store
- Community Marketplace

---

## Technology

- GJS
- GTK4
- Libadwaita
- GObject
- GSettings
- Meson
- Flatpak

---

## Contributing

Development documentation is available in the `development` directory.

Contributions, bug reports and feature suggestions are welcome.

---

## License

GNU General Public License v3.0