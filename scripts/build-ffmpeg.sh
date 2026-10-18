#!/bin/sh
# Build the ffmpeg + ffprobe that ship INSIDE Kingmaker.app (app/Resources/bin → Contents/Resources/bin), so "make an ad"
# works on a stock Mac with no Homebrew (lib/ad-video.mjs videoTools() looks there first).
#   - LGPL only (no --enable-gpl, no x264): video is encoded by Apple's own VideoToolbox (h264_videotoolbox), audio by
#     ffmpeg's native AAC. Kingmaker's source-available licence is unaffected; LICENSE.ffmpeg + the source URL ship beside it.
#   - Only what the ad needs: mov/mp4/wav/png/image2/concat in, mp4 out, and the scale/pad/fps/tpad/trim/setpts/overlay/
#     format/apad/atrim filters. Small, and nothing linked from Homebrew (otool -L shows only /usr/lib and /System).
#   scripts/build-ffmpeg.sh            → app/Resources/bin/{ffmpeg,ffprobe,LICENSE.ffmpeg}
set -eu
here="$(cd "$(dirname "$0")/.." && pwd -P)"
version="${FFMPEG_VERSION:-7.1.1}"
out="$here/app/Resources/bin"
work="${TMPDIR:-/tmp}/kingmaker-ffmpeg-$version"
mkdir -p "$work" "$out"
tarball="$work/ffmpeg-$version.tar.xz"
[ -f "$tarball" ] || curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$version.tar.xz" -o "$tarball"
rm -rf "$work/src" && mkdir -p "$work/src" && tar -xJf "$tarball" -C "$work/src" --strip-components 1
cd "$work/src"
# A clean PATH/PKG_CONFIG: never pick up a Homebrew library by accident.
PATH=/usr/bin:/bin:/usr/sbin:/sbin PKG_CONFIG_PATH= PKG_CONFIG_LIBDIR=/nonexistent ./configure \
  --prefix="$work/prefix" --arch=arm64 --cc=clang --extra-cflags='-mmacosx-version-min=13.0' --extra-ldflags='-mmacosx-version-min=13.0' \
  --disable-everything --disable-doc --disable-debug --disable-network --disable-autodetect --disable-ffplay \
  --enable-videotoolbox --enable-audiotoolbox --enable-zlib \
  --enable-protocol=file,pipe --enable-demuxer=mov,wav,image2,png_pipe,concat,lavfi \
  --enable-muxer=mp4,mov,wav,null --enable-decoder=h264,hevc,prores,png,pcm_s16le,pcm_f32le,aac,wrapped_avframe \
  --enable-encoder=h264_videotoolbox,aac,png,pcm_s16le,wrapped_avframe --enable-parser=h264,hevc,png,aac \
  --enable-bsf=h264_mp4toannexb,aac_adtstoasc --enable-indev=lavfi \
  --enable-filter=scale,pad,fps,tpad,trim,setpts,overlay,format,apad,atrim,aresample,aformat,anull,null,color,testsrc,sine,loop \
  --enable-swscale --enable-swresample
make -j"$(sysctl -n hw.ncpu)"
cp ffmpeg ffprobe "$out/"
cp COPYING.LGPLv2.1 "$out/LICENSE.ffmpeg"
printf 'ffmpeg %s, LGPL v2.1, built by scripts/build-ffmpeg.sh. Source: https://ffmpeg.org/releases/ffmpeg-%s.tar.xz\n' "$version" "$version" > "$out/README.ffmpeg"
"$out/ffmpeg" -hide_banner -version | head -1
otool -L "$out/ffmpeg" | grep -v -E '^\s+/(usr/lib|System)/' | sed -n '2,$p' | grep . && { echo "ffmpeg links outside the system: refusing" >&2; exit 1; } || true
echo "built $out/ffmpeg and ffprobe ($(du -sh "$out" | cut -f1))"
