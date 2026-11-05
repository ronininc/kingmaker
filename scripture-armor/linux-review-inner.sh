#!/bin/sh
# linux-review-inner.sh — stage 2 of the Linux review sandbox.
#
# Runs INSIDE `unshare --mount --net --pid --fork --propagation private`,
# still privileged in the new mount namespace. It builds a fresh pivot
# root that contains ONLY:
#   /usr                       host /usr, bind-mounted read-only (node + libc + coreutils)
#   /armor/scripture-armor     the Armor code root, bind-mounted read-only
#   /armor/lib, /armor/package.json   only when the caller's code root has them
#                              (the stock review-worker resolves ../lib/rea.mjs)
#   /roots/<n>                 each caller-supplied readRoot, bind-mounted read-only
#   /work/upload               the single target file, bind-mounted read-only
#   /work/scratch              the only writable directory (tmpfs-backed review dir)
#   /dev                       tmpfs with null/zero/full/random/urandom only
#   /proc                      fresh procfs for the new PID namespace
#   /tmp                       empty tmpfs
#   /etc/ld.so.cache           the host loader cache, bind-mounted read-only
# Everything else on the host filesystem — home, vaults, protected roots,
# other tenants' data — is simply not present after pivot_root; the old
# root is detached. Then privileges are dropped to an unprivileged uid
# with no capabilities and no_new_privs, rlimits are applied, and the
# requested command is exec'd.
#
# argv: WORKDIR CODEDIR LIBDIR|- PKGJSON|- DROP_UID DROP_GID NROOTS ROOT... -- CMD...
set -u
WORK=$1; CODE=$2; LIB=$3; PKG=$4; DUID=$5; DGID=$6; NROOTS=$7; shift 7
fail() { echo "linux-review-inner: $1" >&2; exit 91; }

NEW="$WORK/.pivot"
mkdir -p "$NEW" || fail mkdir-pivot
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$NEW" || fail tmpfs-root
mkdir -p "$NEW/usr" "$NEW/work" "$NEW/armor" "$NEW/dev" \
         "$NEW/proc" "$NEW/tmp" "$NEW/etc" "$NEW/roots"
# The caller's umask/setgid parents can leave these at 2770; the worker
# runs as uid 65534 and needs plain traverse/read on the structure.
chmod 755 "$NEW" "$NEW/etc" "$NEW/roots" "$NEW/proc" "$NEW/tmp"
mount --bind /usr "$NEW/usr" || fail bind-usr
mount -o remount,ro,bind,nosuid,nodev "$NEW/usr" || fail ro-usr
ln -s usr/bin "$NEW/bin"
ln -s usr/lib "$NEW/lib"
ln -s usr/lib64 "$NEW/lib64"

# The Armor code root is COPIED onto a fresh tmpfs and mode-relaxed
# (a+rX), not bind-mounted: on this VM the workspace overlay denies every
# non-root uid regardless of DAC bits, so a bind of the caller's tree is
# unreadable by the dropped-privilege worker. The copy is byte-identical
# (the adapter hashes the worker entry point before/after in its proof
# harness), lives only inside the sandbox, and dies with the namespace.
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$NEW/armor" || fail tmpfs-armor
cp -a "$CODE" "$NEW/armor/scripture-armor" || fail copy-code
if [ "$LIB" != "-" ]; then
  cp -a "$LIB" "$NEW/armor/lib" || fail copy-lib
fi
if [ "$PKG" != "-" ]; then
  cp -a "$PKG" "$NEW/armor/package.json" || fail copy-pkg
fi
chmod -R a+rX "$NEW/armor" || fail relax-armor

# /work is a fresh tmpfs too: the target file is copied in read-only, and
# scratch is the sandbox's only writable directory. Nothing the worker
# writes ever touches the host filesystem.
mount -t tmpfs -o mode=755,nosuid,nodev tmpfs "$NEW/work" || fail tmpfs-work
cp -a "$WORK/upload" "$NEW/work/upload" || fail copy-upload
chmod 444 "$NEW/work/upload" || fail relax-upload
mkdir -p "$NEW/work/scratch"
chmod 777 "$NEW/work/scratch" || fail relax-scratch

i=0
while [ $i -lt $NROOTS ]; do
  mkdir -p "$NEW/roots/$i"
  mount --bind "$1" "$NEW/roots/$i" || fail bind-root
  mount -o remount,ro,bind,nosuid,nodev "$NEW/roots/$i" || fail ro-root
  shift; i=$((i + 1))
done
[ "${1:-}" = "--" ] && shift

mount -t tmpfs -o mode=755,nosuid tmpfs "$NEW/dev" || fail tmpfs-dev
# mknod(2) is refused on this VM even with CAP_MKNOD, so the five standard
# device nodes are bind-mounted from the host /dev instead — same set the
# Seatbelt profile exposes (/dev/null, /dev/random, /dev/urandom) plus
# zero/full, which node's runtime expects.
for d in null zero full random urandom; do
  touch "$NEW/dev/$d"
  mount --bind "/dev/$d" "$NEW/dev/$d" || fail bind-dev
done
ln -s /proc/self/fd "$NEW/dev/fd"
mount -t proc -o nosuid,nodev,noexec proc "$NEW/proc" || fail proc
mount -t tmpfs -o mode=1777,nosuid,nodev tmpfs "$NEW/tmp" || fail tmpfs-tmp
touch "$NEW/etc/ld.so.cache"
mount --bind /etc/ld.so.cache "$NEW/etc/ld.so.cache" || fail bind-ldcache
mount -o remount,ro,bind "$NEW/etc/ld.so.cache" || fail ro-ldcache
if [ -d /etc/ssl ]; then
  mkdir -p "$NEW/etc/ssl"
  mount --bind /etc/ssl "$NEW/etc/ssl" || fail bind-ssl
  mount -o remount,ro,bind,nosuid,nodev "$NEW/etc/ssl" || fail ro-ssl
fi

hostname armor-review 2>/dev/null || true
cd "$NEW" || fail cd-newroot
mkdir -p .old
/sbin/pivot_root . .old || fail pivot
cd /
umount -l /.old || fail umount-old
rmdir /.old
cd /work/scratch || fail cd-scratch

exec /usr/bin/prlimit --cpu=20 --fsize=16777216 --nproc=256 --nofile=256 --core=0 \
  /usr/bin/setpriv --reuid="$DUID" --regid="$DGID" --clear-groups \
    --inh-caps=-all --no-new-privs -- "$@"
