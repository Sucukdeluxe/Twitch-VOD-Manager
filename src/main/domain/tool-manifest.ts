import type { ExternalToolManifest } from './managed-tools';

export const APPLICATION_TOOL_MANIFEST: Record<'streamlink' | 'ffmpeg', ExternalToolManifest> = {
    streamlink: {
        id: 'streamlink',
        version: '8.4.0',
        sourceUrl: 'https://github.com/streamlink/windows-builds/releases/download/8.4.0-1/streamlink-8.4.0-1-py314-x86_64.zip',
        archiveName: 'streamlink-8.4.0-1-py314-x86_64.zip',
        sha256: 'a8d3bd2b409e6d1b1f7a0e2a5c0cbfba619775e475da3f31285af08d680fb71c',
        executables: ['streamlink.exe']
    },
    ffmpeg: {
        id: 'ffmpeg',
        version: '8.1.2',
        sourceUrl: 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip',
        archiveName: 'ffmpeg-8.1.2-essentials_build.zip',
        sha256: 'db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec',
        executables: ['ffmpeg.exe', 'ffprobe.exe']
    }
};
