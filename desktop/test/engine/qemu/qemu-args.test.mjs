import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../../helpers.mjs';

const { qemuArgs, kernelCommandLine, createDataDiskArgs, DATA_DEVICE } = loadDist('engine/qemu/args.js');

const input = (over = {}) => ({
  kernelPath: 'C:\oe\kernel', initrdPath: 'C:\oe\initrd-oe.img', isoPath: 'C:\oe\android.iso',
  dataDiskPath: 'C:\oe\data.qcow2', srcDir: '', cores: 4, ramMb: 3072,
  accel: 'whpx', adbPort: 5555, headless: false, ...over,
});

const valueAfter = (args, flag) => args[args.indexOf(flag) + 1];

test('WHPX disables the in-kernel interrupt controller', () => {
  // WHPX does not implement it, and QEMU fails to start rather than falling back — so this is the
  // difference between booting and not booting at all.
  assert.match(valueAfter(qemuArgs(input()), '-accel'), /^whpx,kernel-irqchip=off$/);
});

test('without acceleration it says tcg explicitly rather than defaulting', () => {
  assert.equal(valueAfter(qemuArgs(input({ accel: 'tcg' })), '-accel'), 'tcg');
  assert.equal(valueAfter(qemuArgs(input({ accel: 'tcg' })), '-cpu'), 'qemu64');
});

test('the guest boots from the extracted kernel, not the ISO boot menu', () => {
  // A menu waits for a keypress, and this has to come up unattended — which is the entire reason
  // the ISO is parsed rather than handed to QEMU as a bootable disc.
  const args = qemuArgs(input());

  assert.equal(valueAfter(args, '-kernel'), 'C:\oe\kernel');
  assert.equal(valueAfter(args, '-initrd'), 'C:\oe\initrd-oe.img');
});

test('the ISO stays attached, because system.sfs is still read from it', () => {
  const args = qemuArgs(input());
  assert.ok(args.some((a) => a.includes('android.iso') && a.includes('media=cdrom')));
});

test('the data disk is the only virtio block device, which fixes it at /dev/vda', () => {
  const args = qemuArgs(input());
  const virtioDrives = args.filter((a) => a.startsWith('file=') && a.includes('if=virtio'));

  assert.equal(virtioDrives.length, 1, 'a second virtio disk would shift the guest to the wrong device');
  assert.equal(DATA_DEVICE, '/dev/vda');
  assert.match(kernelCommandLine({ srcDir: '' }), /DATA=\/dev\/vda/);
});

test('SRC is empty for an ISO release and named for an installed layout', () => {
  assert.match(kernelCommandLine({ srcDir: '' }), /SRC= /);
  assert.match(kernelCommandLine({ srcDir: '/android-9.0-r2' }), /SRC=\/android-9\.0-r2/);
});

test('SELinux is permissive and modesetting is off', () => {
  // Enforcing SELinux does not complete boot under QEMU; KMS against a virtual GPU can land on a
  // black screen that reads as a hang rather than a graphics failure.
  const cmdline = kernelCommandLine({ srcDir: '' });

  assert.match(cmdline, /androidboot\.selinux=permissive/);
  assert.match(cmdline, /nomodeset/);
});

test('adb is forwarded from the host port to the guest', () => {
  const args = qemuArgs(input({ adbPort: 5599 }));
  assert.ok(args.some((a) => a === 'user,id=n0,hostfwd=tcp::5599-:5555'));
});

test('a windowed run gets a real SDL window to embed', () => {
  const windowed = qemuArgs(input({ headless: false }));
  const headless = qemuArgs(input({ headless: true }));

  assert.equal(valueAfter(windowed, '-display'), 'sdl');
  assert.equal(valueAfter(headless, '-display'), 'none');
});

test('a serial log is attached only when asked for', () => {
  assert.ok(!qemuArgs(input()).includes('-serial'));
  assert.equal(valueAfter(qemuArgs(input({ logPath: 'C:\oe\qemu.log' })), '-serial'), 'file:C:\oe\qemu.log');
});

test('cores and memory are passed through', () => {
  const args = qemuArgs(input({ cores: 8, ramMb: 4096 }));
  assert.equal(valueAfter(args, '-smp'), '8');
  assert.equal(valueAfter(args, '-m'), '4096');
});

test('the data disk is created as qcow2 at the requested size', () => {
  assert.deepEqual(createDataDiskArgs('C:\oe\data.qcow2', 8),
    ['create', '-f', 'qcow2', 'C:\oe\data.qcow2', '8G']);
});
