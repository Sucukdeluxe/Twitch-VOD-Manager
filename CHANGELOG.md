# Changelog

## 1.0.14 - 2026-08-12

- Provision the Electron binary with a bounded retry before Windows CI smoke tests.

## 1.0.13 - 2026-08-12

- Apply the Windows CI retry to both directory and installer packaging.

## 1.0.12 - 2026-08-12

- Retry transient Electron download failures once while packaging on Windows CI.

## 1.0.11 - 2026-08-12

- Stabilize the Windows CI secure-storage test without invoking Electron's binary bootstrap outside Electron.

## 1.0.10 - 2026-08-12

- Ignore malformed updater events without a version instead of showing an unusable update prompt.
- Keep the cutter source selection out of the loaded editor layout and render each export profile indicator exactly once.

## 1.0.9 - 2026-08-12

- Waited for managed-tool checksum streams to close before promoting verified installations, preventing intermittent Windows repair failures caused by open file handles.

## 1.0.8 - 2026-08-12

- Updated the Windows CI runtime to Node.js 24.11.1, resolving the SQLite native-module crash that interrupted verification workers on Node.js 22.13.0.
- Corrected the file-capability test expectation for canonical Windows output paths, including 8.3 temporary-directory aliases.

## 1.0.7 - 2026-08-12

- Replaced versioned Windows Start menu shortcuts with one stable application entry, migrated legacy shortcuts during upgrades and refreshed the Windows Shell registration.
- Kept the application icon consistent across the installer, desktop shortcut, Start menu entry, taskbar and relaunch metadata.
- Repaired upgrades after incomplete per-user installations so missing program files are restored before shortcuts are refreshed.
- Fixed the available-update popover so pointer movement from the Update button into its actions remains reliable across the full button width.
- Added a smooth expandable changelog section to the update dialog.

## 1.0.6 - 2026-08-12

- Hardened queue process ownership, persisted state transitions and protected file access across downloads, imports, exports and local media tools.
- Added verified managed tool installation with version pinning, archive checksums, atomic recovery and repair status controls.
- Improved keyboard navigation, dialog focus handling, accessible virtualized chat and event viewers, context menus and command-palette behavior.
- Added cutter project recovery, export profiles, rotation and audio-stream choices, hardware encoder verification and safer media replacement handling.
- Added global download bandwidth limits and configurable download windows that apply consistently across queue and clip jobs.
- Added Windows quality, packaging and security gates, including public-file allowlist validation and packaged-media checks.
- Fixed Windows taskbar identity so development and installed windows publish an explicit application icon and relaunch metadata.

## 1.0.5 - 2026-08-11

- Added a complete local video editor for MP4, M4V, MOV, WebM, MKV, TS and AVI files with frame-accurate trimming, removable ranges, undo and redo, timeline zoom and atomic exports.
- Added a responsive desktop player with smooth scrubbing, keyboard controls, volume interaction, fullscreen playback and synchronized playback state.
- Added high-resolution video thumbnails and a reusable waveform timeline that remain sharp across zoom levels without blocking the first usable view.
- Added precise timeline handles, mouse-wheel zoom anchored to the pointer and smooth navigation for short and long recordings.
- Added safe source validation, cancellable exports and protection against partial or overwritten output files.
- Added a confirmation step before replacing an active edit and reset playback controls correctly when another video is opened.
- Improved editor layout, timestamp readability, metadata alignment, action contrast and language-selection contrast across supported window sizes.

## 1.0.4 - 2026-08-11

- Added smooth entrance and exit motion for the VOD selection action dock, including Windows systems with reduced animations enabled.
- Fixed stale Windows desktop and Start menu icons with version-specific shortcut icon resources and an explicit Shell refresh after installation.
- Kept icon resources available for pinned and copied shortcuts across upgrades while cleaning them up during a full uninstall.
- Updated the public product overview with a real Twitch channel example.

## 1.0.3 - 2026-08-10

- Added animated selection markers across the main navigation, sidebar modes, language control, streamer list and settings pages.
- Reorganized Settings into dedicated pages with a responsive two-column download configuration and clearer public-mode guidance.
- Added startup preloading and silent five-minute background refreshes for configured streamers and their VOD libraries.
- Improved VOD cards with stable one-line titles, localized dates, clearer view counts, persistent duration badges and high-resolution hover previews.
- Added an optional split Streamer and Queue sidebar, compact streamer context actions and space-efficient merge-order selection.
- Improved queue accuracy with real zero-percent starts, stable progress metadata and pause or continue support without restarting the download.
- Added safe partial-file handling so incomplete downloads are removed after cancellation, normal shutdown or crash recovery and final names only appear after verification.
- Replaced Electron branding across the window, taskbar, installer, uninstaller and notifications with the Twitch VOD Manager identity.
- Improved German localization, date formatting, text-selection behavior, responsive navigation labels and update-dialog layout.
- Added a Windows hot-reload development workflow for renderer and main-process changes.
- Updated the public documentation with a complete feature overview, privacy details, setup guidance and an isolated product screenshot.

## 1.0.2 - 2026-08-10

- Redesigned the desktop workspace with compact top navigation, contextual sidebars and dedicated toolbars for all seven areas.
- Added Light, Dark and System appearance modes with improved contrast and responsive layouts from 1280 to 2048 pixels.
- Added a persistent update control with download, postpone and dismiss actions.
- Added searchable settings, synchronized section navigation and clearer empty, queue and busy states.
- Improved German and English localization, including locale-aware dates and accessibility labels.
- Hardened the release test suite with isolated application data, browser profiles, downloads and offline network fixtures.
- Updated the desktop runtime and Windows packaging stack with current security fixes.

## 1.0.1 - 2026-08-05

- New clean public release line based on the complete desktop application.
- Twitch VOD, clip, trim, split, merge, queue, history and automation workflows.
- Streamer profiles, VOD previews, themes, localization and command palette.
- Resumable downloads, integrity checks, secure local storage and SQLite migration.
- Automatic update checks and downloads through GitHub Releases.
