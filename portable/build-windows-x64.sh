#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PORTABLE_DIR="$ROOT/portable"
CACHE="$PORTABLE_DIR/.cache"
BUILD="$PORTABLE_DIR/.build"
PAYLOAD="$BUILD/payload"
DIST="$PORTABLE_DIR/dist"
OUTPUT="$DIST/The-Hand-Windows-v1.0.0-x64.exe"

NODE_VERSION=22.23.3
NODE_ARCHIVE="node-v${NODE_VERSION}-win-x64.zip"
NODE_SHA256=2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71
YTDLP_VERSION=2026.08.19
YTDLP_SHA256=66674953fe251b89f4d08c5f0e35e0728679bd67ab3d7d05c0562af101dd3e7a
FFMPEG_VERSION=9.0.2
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}-essentials_build.7z"
FFMPEG_SHA256=4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077
LZMA_VERSION=23.01
LZMA_ARCHIVE="lzma2301.7z"
LZMA_SHA256=317dd834d6bbfd95433488b832e823cd3d4d420101436422c03af88507dd1370

for command in curl 7z ffmpeg x86_64-w64-mingw32-gcc x86_64-w64-mingw32-windres sha256sum; do
  command -v "$command" >/dev/null || { echo "Missing build dependency: $command" >&2; exit 1; }
done

mkdir -p "$CACHE" "$DIST"

download() {
  local url=$1 destination=$2 expected=$3
  if [[ -f "$destination" ]] && echo "$expected  $destination" | sha256sum --check --status; then
    return
  fi
  rm -f "$destination"
  curl --fail --location --retry 3 --output "$destination" "$url"
  echo "$expected  $destination" | sha256sum --check --status || {
    echo "Checksum mismatch: $destination" >&2
    rm -f "$destination"
    exit 1
  }
}

download "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}" "$CACHE/$NODE_ARCHIVE" "$NODE_SHA256"
download "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp.exe" "$CACHE/yt-dlp-${YTDLP_VERSION}.exe" "$YTDLP_SHA256"
download "https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/${FFMPEG_ARCHIVE}" "$CACHE/$FFMPEG_ARCHIVE" "$FFMPEG_SHA256"
download "https://www.7-zip.org/a/$LZMA_ARCHIVE" "$CACHE/$LZMA_ARCHIVE" "$LZMA_SHA256"

rm -rf "$BUILD"
mkdir -p "$PAYLOAD/runtime" "$PAYLOAD/tools" "$PAYLOAD/web" "$PAYLOAD/docs" "$BUILD/node" "$BUILD/ffmpeg" "$BUILD/lzma"

7z x -y -o"$BUILD/node" "$CACHE/$NODE_ARCHIVE" >/dev/null
7z x -y -o"$BUILD/ffmpeg" "$CACHE/$FFMPEG_ARCHIVE" >/dev/null
7z x -y -o"$BUILD/lzma" "$CACHE/$LZMA_ARCHIVE" >/dev/null

NODE_ROOT="$BUILD/node/node-v${NODE_VERSION}-win-x64"
FFMPEG_BIN=$(find "$BUILD/ffmpeg" -type d -path '*/bin' -print -quit)
[[ -x "$NODE_ROOT/node.exe" || -f "$NODE_ROOT/node.exe" ]] || { echo "node.exe missing from runtime archive" >&2; exit 1; }
[[ -n "$FFMPEG_BIN" && -f "$FFMPEG_BIN/ffmpeg.exe" && -f "$FFMPEG_BIN/ffprobe.exe" ]] || {
  echo "FFmpeg tools missing from runtime archive" >&2
  exit 1
}

cp "$NODE_ROOT/node.exe" "$PAYLOAD/runtime/"
cp "$NODE_ROOT/LICENSE" "$PAYLOAD/docs/Node-LICENSE.txt"
cp "$CACHE/yt-dlp-${YTDLP_VERSION}.exe" "$PAYLOAD/tools/yt-dlp.exe"
cp "$FFMPEG_BIN/ffmpeg.exe" "$FFMPEG_BIN/ffprobe.exe" "$PAYLOAD/tools/"
cp -a "$ROOT/public" "$ROOT/server" "$PAYLOAD/web/"
cp "$PORTABLE_DIR/THIRD-PARTY-NOTICES.txt" "$PAYLOAD/docs/"

x86_64-w64-mingw32-gcc -Os -s -static -municode -mwindows \
  "$PORTABLE_DIR/launcher.c" -o "$PAYLOAD/launcher.exe"

ffmpeg -hide_banner -loglevel error -y -i "$ROOT/public/icon.svg" -vf scale=256:256 "$BUILD/icon.ico"
cat > "$BUILD/resource.rc" <<'RC'
#include <windows.h>
1 ICON "icon.ico"
VS_VERSION_INFO VERSIONINFO
 FILEVERSION 1,0,0,0
 PRODUCTVERSION 1,0,0,0
 FILEFLAGSMASK 0x3fL
 FILEFLAGS 0x0L
 FILEOS 0x40004L
 FILETYPE 0x1L
 FILESUBTYPE 0x0L
BEGIN
 BLOCK "StringFileInfo"
 BEGIN
  BLOCK "040904b0"
  BEGIN
   VALUE "CompanyName", "flowstream-kaze\0"
   VALUE "FileDescription", "The Hand for Windows\0"
   VALUE "FileVersion", "1.0.0\0"
   VALUE "InternalName", "TheHandWindows\0"
   VALUE "LegalCopyright", "GPL-3.0\0"
   VALUE "OriginalFilename", "The-Hand-Windows-v1.0.0-x64.exe\0"
   VALUE "ProductName", "The Hand for Windows\0"
   VALUE "ProductVersion", "1.0.0\0"
  END
 END
 BLOCK "VarFileInfo"
 BEGIN
  VALUE "Translation", 0x409, 1200
 END
END
RC
(
  cd "$BUILD"
  x86_64-w64-mingw32-windres resource.rc resource.o
  LZMA_C="$BUILD/lzma/C"
  SOURCES=(7zAlloc.c 7zArcIn.c 7zBuf.c 7zBuf2.c 7zCrc.c 7zCrcOpt.c 7zFile.c 7zDec.c 7zStream.c Bcj2.c Bra.c Bra86.c BraIA64.c CpuArch.c Delta.c DllSecur.c Lzma2Dec.c LzmaDec.c)
  SOURCE_PATHS=()
  for source in "${SOURCES[@]}"; do SOURCE_PATHS+=("$LZMA_C/$source"); done
  x86_64-w64-mingw32-gcc -Os -s -mwindows -DZ7_EXTRACT_ONLY \
    -I"$LZMA_C" -I"$LZMA_C/Util/SfxSetup" \
    "$LZMA_C/Util/SfxSetup/SfxSetup.c" "${SOURCE_PATHS[@]}" resource.o \
    -lole32 -lshell32 -o sfx.exe
)

rm -f "$BUILD/payload.7z" "$OUTPUT"
(
  cd "$PAYLOAD"
  # The compact GUI SFX runs the sole root executable, waits for it, then removes
  # its temporary extraction directory. A solid archive keeps the handoff small.
  7z a -t7z -mx=9 -m0=lzma2 -ms=on -mmt=on "$BUILD/payload.7z" . >/dev/null
)
cat "$BUILD/sfx.exe" "$BUILD/payload.7z" > "$OUTPUT"
chmod +x "$OUTPUT"
(
  cd "$DIST"
  sha256sum "$(basename "$OUTPUT")" | tee "$(basename "$OUTPUT").sha256"
)
echo "Built $OUTPUT ($(du -h --apparent-size "$OUTPUT" | cut -f1))"
