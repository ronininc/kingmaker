#!/usr/bin/env python3
"""drive-vm.py — boot the Alpine guest under QEMU (TCG, no KVM in
this sandbox), drive its serial console, install Node from the
ISO's own repo, fetch the peer bundle + engine block from the host
over the virtual link (QEMU slirp user-networking — the sandbox's
connect policy EPERMs direct host sockets to any tap subnet, see
TWO-ENDPOINT-PROOF.md), start the armor peer + rogue, then wait
for the host test run to finish and power the guest off.

All console I/O is logged to drive-vm.log verbatim.
"""
import os, sys, time
import pexpect

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(HERE, 'drive-vm.log'), 'wb')
DONE_FLAG = '/tmp/vm-tests-done.flag'

QEMU = [
    'qemu-system-x86_64',
    '-machine', 'accel=tcg', '-cpu', 'qemu64', '-m', '512', '-smp', '1',
    '-kernel', os.path.join(HERE, 'boot', 'vmlinuz-virt'),
    '-initrd', os.path.join(HERE, 'boot', 'initramfs-virt'),
    '-append', 'console=ttyS0,115200 modules=loop,squashfs,sd-mod,usb-storage panic=60',
    '-drive', f"file={os.path.join(HERE, 'alpine-virt.iso')},format=raw,media=cdrom,readonly=on",
    '-virtfs', f"local,path={os.path.join(HERE, 'share')},mount_tag=host0,security_model=none,readonly=on",
    '-netdev', 'user,id=n0,hostfwd=tcp::18731-:18731,hostfwd=tcp::18732-:18732,hostfwd=tcp::18733-:18733,hostfwd=tcp::18899-:8899',
    '-device', 'virtio-net-pci,netdev=n0,mac=52:54:00:77:00:02',
    '-display', 'none', '-serial', 'stdio', '-monitor', 'none',
]

def mark(msg):
    print(msg, flush=True)

child = pexpect.spawn(QEMU[0], QEMU[1:], timeout=60, encoding=None, logfile=LOG)
child.logfile_read = LOG

def run(cmd, sentinel, timeout=120):
    child.sendline(cmd)
    child.sendline(f'echo {sentinel}')
    child.expect(sentinel.encode(), timeout=timeout)
    child.expect(sentinel.encode(), timeout=10)  # the echoed command line itself can match first; wait for the output line too

try:
    mark('DRIVER: waiting for guest login prompt (TCG boot)...')
    child.expect(b'login:', timeout=600)
    time.sleep(1)
    child.sendline('root')
    child.expect(b'#', timeout=60)
    mark('DRIVER: logged in')

    run('ip link set eth0 up; udhcpc -i eth0 -t 10; ip -4 addr show eth0', 'SENT-NET-OK', 120)
    mark('DRIVER: guest network up (slirp DHCP)')

    # Node in the guest, two failed routes behind us (see report):
    # the ISO's apk route errored ("unable to select packages" —
    # cdrom repo unmounted in extracted-kernel boot), and the 55 MB
    # musl tarball over slirp did not finish in 300 s under TCG.
    # Route that needs no guest network transfer at all: a virtio-9p
    # share of the host's share/ dir (musl node binary + bundle +
    # engine block), mounted read-only by the guest.
    run('modprobe 9p 2>/dev/null; modprobe 9pnet_virtio 2>/dev/null; mkdir -p /mnt/host && mount -t 9p -o trans=virtio,version=9p2000.L host0 /mnt/host && ls /mnt/host', 'SENT-9P-OK', 180)
    # The musl Node build dynamically links libstdc++/libgcc, which
    # the virt ISO's minimal system lacks (and its repo doesn't
    # carry). The .so files ride the share (unpacked on the host
    # from the Alpine 3.24 main-repo apks) and are copied into the
    # guest's /usr/lib — a default musl search path.
    run('cp /mnt/host/guest-libs/usr/lib/libstdc++.so.6* /mnt/host/guest-libs/usr/lib/libgcc_s.so.1 /usr/lib/ && ls -la /usr/lib/libstdc++*', 'SENT-LIBS-OK', 120)
    child.sendline('/mnt/host/node-dist/bin/node --version')
    child.expect(rb'v22\.14\.0', timeout=120)  # raises unless the guest really runs node
    mark('DRIVER: node v22.14.0 (musl) verified running in guest via 9p share')

    run('mkdir -p /root/x && cd /root/x && tar xzf /mnt/host/bundle.tar.gz && cp /mnt/host/engine-block.txt . && ls', 'SENT-FETCH-OK', 180)
    mark('DRIVER: bundle + engine block staged in guest from the share')

    run('cd /root/x && (nohup /mnt/host/node-dist/bin/node peer-server.mjs > peer.log 2>&1 &) && (nohup /mnt/host/node-dist/bin/node rogue-server.mjs > rogue.log 2>&1 &) && sleep 3 && cat peer.log rogue.log', 'SENT-PEERS-OK', 120)
    mark('HOST-READY')

    t0 = time.time()
    while not os.path.exists(DONE_FLAG):
        if time.time() - t0 > 2400:
            mark('DRIVER: done-flag timeout — powering off anyway')
            break
        time.sleep(5)
    child.sendline('cat /root/x/evidence.json; poweroff')
    try:
        child.expect(pexpect.EOF, timeout=120)
    except pexpect.TIMEOUT:
        child.terminate(force=True)
    mark('DRIVER: guest powered off')
except Exception as e:
    mark(f'DRIVER-ERROR: {type(e).__name__}: {e}')
    try:
        child.terminate(force=True)
    except Exception:
        pass
    sys.exit(1)
