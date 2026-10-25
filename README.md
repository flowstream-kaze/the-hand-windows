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

### Updating yt-dlp

The footer shows the installed yt-dlp version. **Update yt-dlp** uses yt-dlp's official updater, which verifies `yt-dlp.exe` against the release's `SHA2-256SUMS`, and installs it under `%LOCALAPPDATA%\TheHandWindows\tools`. Updates survive portable-app restarts. A failed update leaves the previous copy intact; a missing or damaged copy is restored from the version bundled with The Hand. Updating is blocked while a lookup or download is active. Close The Hand and delete `%LOCALAPPDATA%\TheHandWindows` to remove the persistent update and return to the bundled version.

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

## Icons

The browser, PWA, and executable icons are derived from one 1024 px master, `branding/icon-source.png` — the same artwork used by the Android app in [`flowstream-kaze/the-hand`](https://github.com/flowstream-kaze/the-hand). Regenerate every size from it:

```bash
for size in 512 192 180 48 32 16; do
  ffmpeg -y -i branding/icon-source.png -vf scale=$size:$size:flags=lanczos,format=rgba \
    "public/scaled-$size.png"
done
```

Rename the results to `icon-512.png`, `icon-192.png`, `apple-touch-icon.png`, `favicon-48.png`, `favicon-32.png`, and `favicon-16.png`; `icon-maskable-512.png` is a copy of the 512 px render. `portable/build-windows-x64.sh` converts `public/icon-512.png` into the executable icon.

## Security

The server binds to loopback, rejects credentials/custom ports/private-network targets, rate-limits expensive requests, runs subprocesses without a shell, and applies download size/time limits. It still processes untrusted remote media, so keep yt-dlp current and do not expose the service publicly.

## License

GPL-3.0. See [`LICENSE`](LICENSE) and [`portable/THIRD-PARTY-NOTICES.txt`](portable/THIRD-PARTY-NOTICES.txt).
