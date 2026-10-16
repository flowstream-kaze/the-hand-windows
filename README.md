# The Hand for Windows

A self-contained Windows 10/11 x64 media downloader powered by yt-dlp and FFmpeg.

Run one portable executable, paste a media URL in the browser interface, choose video quality or MP3, and save the completed file normally. The app runs only on a random `127.0.0.1` port; it does not expose a public server.

## Portable release

The release executable includes:

- The Hand local server and browser interface
- Node.js 22 LTS
- yt-dlp
- FFmpeg and FFprobe

No installation, Python, Node.js, FFmpeg, Docker, or browser extension is required. The executable temporarily unpacks its runtime while open and removes it after the local server exits. Job data is stored under `%TEMP%\TheHandWindows` and stale jobs are removed on the next launch.

The current release is unsigned, so Windows SmartScreen may show an **Unknown publisher** warning.

## Development

Requirements: Node.js 20+, yt-dlp, and FFmpeg/FFprobe on `PATH`.

```bash
npm test
npm start
```

Then open <http://127.0.0.1:8787>.

## Build the Windows executable

On Debian/Ubuntu:

```bash
sudo apt-get install p7zip-full gcc-mingw-w64-x86-64-posix ffmpeg curl
portable/build-windows-x64.sh
```

The build verifies pinned SHA-256 checksums for every downloaded runtime component. See [`portable/README.md`](portable/README.md) for packaging details.

## Security

The server binds to loopback, rejects credentials/custom ports/private-network targets, rate-limits expensive requests, runs subprocesses without a shell, and applies download size/time limits. It still processes untrusted remote media, so keep yt-dlp current and do not expose the service publicly.

## License

GPL-3.0. See [`LICENSE`](LICENSE) and [`portable/THIRD-PARTY-NOTICES.txt`](portable/THIRD-PARTY-NOTICES.txt).
