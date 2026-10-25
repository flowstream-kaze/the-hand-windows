# Portable Windows x64 build

Version 1.0.2 packages The Hand as one self-extracting executable for 64-bit Windows 10/11.

## Runtime behavior

1. The executable extracts its embedded runtime into a random Windows temporary directory.
2. It starts the server on a random `127.0.0.1` port and opens the default browser.
3. The browser saves completed files using its normal download behavior.
4. **Update yt-dlp** installs a checksum-verified copy under `%LOCALAPPDATA%\TheHandWindows\tools`; it persists across launches and falls back to the bundled copy if damaged. Delete `%LOCALAPPDATA%\TheHandWindows` while the app is closed to remove the update and reset to the bundled version.
5. The server exits after 15 minutes without an open page, active job, file transfer, or yt-dlp update.
6. The self-extractor removes its runtime directory after the server exits.
7. Incomplete job data under `%TEMP%\TheHandWindows\jobs` is removed on the next launch.

No installer or external runtime is required. Internet access is still required to inspect and download media. The executable is unsigned, so Windows SmartScreen may show an **Unknown publisher** warning.

## Build

From the repository root on Debian/Ubuntu:

```bash
sudo apt-get install p7zip-full gcc-mingw-w64-x86-64-posix ffmpeg curl
portable/build-windows-x64.sh
```

The script downloads pinned component releases, verifies every SHA-256 digest, cross-compiles the launcher and branded self-extractor, and writes:

```text
portable/dist/The-Hand-Windows-v1.0.2-x64.exe
```
