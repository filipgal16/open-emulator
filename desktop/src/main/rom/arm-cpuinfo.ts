/**
 * The `/proc/cpuinfo` an ARM app sees on an x86 guest.
 *
 * Google's ARM translator (`libndk_translation`) does not pass the real `/proc/cpuinfo` through to
 * translated code — it is an x86 one, and ARM code would not know what to make of it. It serves
 * `/system/etc/cpuinfo.arm64.txt` (and `cpuinfo.arm.txt` for 32-bit) instead, and Google's images
 * ship those describing **one** processor, numbered 1:
 *
 *     processor	: 1
 *     BogoMIPS	: 1.00
 *     Features	: fp asimd evtstrm aes pmull …
 *     CPU implementer	: 0x41
 *     …
 *
 * An engine that counts cores from that file believes the device has one. Unity does: measured on
 * a 6-core guest it logged `SystemInfo CPU = x86-64, Cores = 1` and `1 big (mask: 0x2)`, started no
 * `Job.Worker` threads and no `UnityGfxDeviceWorker`, and ran the whole game on its main thread.
 * With the file listing six processors it logged `Cores = 6`, `6 big (mask: 0x3f)`, and started
 * five workers and the render thread.
 *
 * So the ROM repeats the stock entry once per guest core, numbered from 0 as the kernel does.
 * Everything else — the feature list, the implementer and part — stays byte-for-byte Google's:
 * it describes what the translator can execute, which is not ours to restate.
 */

const PROCESSOR_LINE = /^processor[ \t]*:[ \t]*\d+[ \t]*$/m;

/**
 * Throws if `stock` is not the one-entry-or-more file described above — an image that ships
 * something else is one this transform was not measured against.
 */
export function expandArmCpuinfo(stock: Buffer, cores: number): Buffer {
  if (!Number.isInteger(cores) || cores < 1) throw new Error(`cannot describe ${cores} CPU cores`);

  const text = stock.toString('utf8').replace(/\r\n/g, '\n');
  // Entries are separated by a blank line, as in the kernel's own output. The first one is the
  // template, so running this over a file that already lists several gives the same result.
  const entry = text.split(/\n{2,}/).find((block) => PROCESSOR_LINE.test(block));
  if (entry === undefined) throw new Error('the cpuinfo file has no "processor : N" entry to repeat');
  const template = entry.replace(/^\n+|\n+$/g, '');
  if (template.match(new RegExp(PROCESSOR_LINE.source, 'gm'))?.length !== 1) {
    throw new Error('one cpuinfo entry names more than one processor');
  }

  const entries: string[] = [];
  for (let cpu = 0; cpu < cores; cpu += 1) {
    entries.push(template.replace(PROCESSOR_LINE, `processor\t: ${cpu}`));
  }
  // Each entry ends with a blank line, the last included: that is what the kernel prints, and
  // what a parser splitting on blank lines expects.
  return Buffer.from(`${entries.join('\n\n')}\n\n`, 'utf8');
}
