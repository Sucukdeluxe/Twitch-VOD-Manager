# Twitch VOD Manager

Twitch VOD Manager is a Windows desktop application for finding, downloading, trimming, splitting, merging and organizing Twitch VODs and clips.

## Features

- Search streamers and browse available VODs
- Download complete VODs or precise time ranges
- Split long recordings into configurable parts
- Merge related downloads and track group progress
- Resume interrupted downloads and verify completed files
- Manage queues, history, profiles and per-streamer automation
- Capture live streams and Twitch chat
- Navigate a compact workspace with contextual sidebars and dedicated toolbars
- Use Light, Dark and System themes with German and English localization
- Search settings and jump directly to individual configuration areas
- Receive application updates through GitHub Releases

## Installation

Download the current Windows installer from [GitHub Releases](https://github.com/Sucukdeluxe/Twitch-VOD-Manager/releases/latest).

The application stores its settings and local database on the computer where it is installed. No Twitch credentials, user settings, download history or personal data are included in this repository or its release files.

## Development

Requirements:

- Node.js 22.13 or newer
- Windows for building the NSIS installer

```powershell
npm ci
npm run test:e2e:release
npm run dist:win
```

## License

Twitch VOD Manager is available under the [MIT License](LICENSE).
