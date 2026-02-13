# Twitch VOD Manager

Twitch VOD Manager is a desktop app for browsing Twitch VODs, queueing downloads, creating clips, cutting local videos, and merging files.

The current codebase is TypeScript + Electron and ships Windows installer releases with in-app auto-update support.

## Documentation

- Full docs workspace: `docs/`
- Docs index: `docs/src/pages/index.astro`

Key guides:

- [Getting Started](docs/src/pages/getting-started.mdx)
- [Features](docs/src/pages/features.mdx)
- [Configuration](docs/src/pages/configuration.mdx)
- [Troubleshooting](docs/src/pages/troubleshooting.mdx)
- [Development](docs/src/pages/development.mdx)
- [Release Process](docs/src/pages/release-process.mdx)

## Main Features

- Streamer list with Twitch Helix VOD browser
- Queue-based VOD downloads
- Clip extraction workflow from VOD metadata
- Local video cutter with preview frame extraction
- Local video merge workflow
- GitHub release based in-app updates

## Requirements

- Windows 10/11
- Node.js 18+ and npm (for local development)
- `streamlink` in `PATH`
- `ffmpeg` and `ffprobe` in `PATH`

Optional (recommended for authenticated mode):

- Twitch app `Client ID` and `Client Secret`

## Run from source

```bash
cd "typescript-version"
npm install
npm run build
npm start
```

## Build installer

```bash
cd "typescript-version"
npm run dist:win
```

Output artifacts are generated in `typescript-version/release/`.

## Repository Structure

- `typescript-version/` - Electron app source and build config
- `docs/` - Astro + MDX documentation site
- `server_files/` - legacy release metadata files

## Auto-Update Notes

For updates to reach installed clients, each release must include:

- `latest.yml`
- `Twitch-VOD-Manager-Setup-<version>.exe`
- `Twitch-VOD-Manager-Setup-<version>.exe.blockmap`

See [Release Process](docs/src/pages/release-process.mdx) for the full checklist.
