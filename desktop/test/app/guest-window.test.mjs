import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDist } from '../helpers.mjs';

const { GuestWindow } = loadDist('guest/guest-window.js');

const RECT = { x: 0, y: 40, width: 800, height: 600 };
const PARENT = Buffer.alloc(8);

/** A fake Win32 layer that records what it was asked to do. */
function fakeEmbed(over = {}) {
  const calls = [];
  return {
    calls,
    waitForWindow: async (pid) => {
      calls.push(`wait:${pid}`);
      return 'HWND';
    },
    embedWindow: (child, parent, bounds) => {
      calls.push(`embed:${bounds.width}x${bounds.height}`);
      return true;
    },
    moveWindow: (child, bounds) => {
      calls.push(`move:${bounds.x},${bounds.y},${bounds.width}x${bounds.height}`);
      return true;
    },
    setWindowVisible: (child, visible) => {
      calls.push(`visible:${visible}`);
      return true;
    },
    isLiveWindow: (child) => child === 'HWND',
    captureWindowStyles: () => {
      calls.push('capture');
      return { style: 0x1234, exStyle: 0x5678 };
    },
    releaseWindow: (child, styles) => {
      calls.push(`release:${styles ? `${styles.style}/${styles.exStyle}` : 'null'}`);
      return true;
    },
    ...over,
  };
}

const windowFor = (embed) => new GuestWindow({ embed, attachTimeoutMs: 50 });

// ── Attaching ──────────────────────────────────────────────────────────────────────────────────

test('a found window is embedded and becomes the attached one', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);

  assert.equal(await guest.attach(1234, PARENT, RECT), true);
  assert.equal(guest.isAttached(), true);
  assert.deepEqual(embed.calls, ['wait:1234', 'capture', 'embed:800x600']);
});

test('concurrent attaches share one attempt, not one poll each', async () => {
  // The renderer reports its viewport on every resize, and a guest that just started gets several
  // while the window is still being waited for. Each starting its own 60s poll would be a leak.
  const embed = fakeEmbed();
  const guest = windowFor(embed);

  const [a, b, c] = await Promise.all([
    guest.attach(1234, PARENT, RECT),
    guest.attach(1234, PARENT, RECT),
    guest.attach(1234, PARENT, RECT),
  ]);

  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(embed.calls.filter((c) => c.startsWith('wait:')).length, 1);
});

test('attaching when already attached just repositions', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  assert.equal(await guest.attach(1234, PARENT, { ...RECT, width: 900 }), true);
  assert.deepEqual(embed.calls, ['move:0,40,900x600'], 'no second wait, no second embed');
});

// ── Every failure falls back rather than throwing ──────────────────────────────────────────────

test('a guest that never paints reports failure instead of hanging the caller', async () => {
  const embed = fakeEmbed({ waitForWindow: async () => null });
  const guest = windowFor(embed);

  assert.equal(await guest.attach(1234, PARENT, RECT), false);
  assert.equal(guest.isAttached(), false, 'the caller mirrors instead');
});

test('a refused SetParent is a false, not an exception', async () => {
  const embed = fakeEmbed({ embedWindow: () => false });
  const guest = windowFor(embed);

  assert.equal(await guest.attach(1234, PARENT, RECT), false);
  assert.equal(guest.isAttached(), false);
});

test('a throwing Win32 layer degrades to mirroring', async () => {
  // koffi failing to load, or a driver rejecting a reparented Qt surface, must not take the app
  // down — it must leave the user with the slow path that still works.
  const boom = () => {
    throw new Error('koffi unavailable');
  };

  for (const over of [{ waitForWindow: async () => boom() }, { embedWindow: boom }]) {
    const guest = windowFor(fakeEmbed(over));
    assert.equal(await guest.attach(1234, PARENT, RECT), false);
    assert.equal(guest.isAttached(), false);
  }
});

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────

test('an unchanged rectangle is not re-applied', async () => {
  // ResizeObserver fires for layout changes that leave the viewport where it was, and every
  // SetWindowPos on a live GPU surface is a real repaint.
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.setBounds({ ...RECT });
  assert.deepEqual(embed.calls, []);

  guest.setBounds({ ...RECT, width: 640 });
  assert.deepEqual(embed.calls, ['move:0,40,640x600']);
});

test('bounds on a detached window are refused, not crashed on', () => {
  const guest = windowFor(fakeEmbed());

  assert.equal(guest.setBounds(RECT), false);
  assert.equal(guest.setVisible(true), false);
});

// ── Visibility: the airspace rule ──────────────────────────────────────────────────────────────

test('hiding and showing is deduplicated', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  // embedWindow already showed it, so this is a no-op.
  guest.setVisible(true);
  assert.deepEqual(embed.calls, []);

  guest.setVisible(false);
  guest.setVisible(false);
  assert.deepEqual(embed.calls, ['visible:false'], 'hiding twice hides once');

  guest.setVisible(true);
  assert.deepEqual(embed.calls, ['visible:false', 'visible:true']);
});

// ── Teardown ───────────────────────────────────────────────────────────────────────────────────

test('detaching gives the window back to the desktop, with its original styles', async () => {
  // Windows destroys child windows with their parent. A guest window still parented to ours when
  // the app closes is destroyed with it while the emulator keeps running — which is exactly how a
  // live emulator ended up with no screen and every later start found nothing to embed.
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.detach();

  assert.deepEqual(embed.calls, ['release:4660/22136'], 'released with the styles captured at embed');
  assert.equal(guest.isAttached(), false);
});

test('styles are captured before embedding overwrites them', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);

  await guest.attach(1234, PARENT, RECT);

  assert.ok(embed.calls.indexOf('capture') < embed.calls.indexOf('embed:800x600'));
});

test('detaching twice releases once', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.detach();
  guest.detach();

  assert.equal(embed.calls.filter((c) => c.startsWith('release')).length, 1);
});

test('a release that throws still forgets the window', async () => {
  // Quitting must not be blocked by a window that has already gone.
  const embed = fakeEmbed({
    releaseWindow: () => {
      throw new Error('window already destroyed');
    },
  });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);

  guest.detach();

  assert.equal(guest.isAttached(), false);
});

test('detaching a window that already died does not try to release it', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;
  embed.isLiveWindow = () => false;

  guest.detach();

  assert.deepEqual(embed.calls, []);
});

test('a window that died underneath us reads as detached', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);

  embed.isLiveWindow = () => false;

  assert.equal(guest.isAttached(), false);
  assert.equal(guest.setBounds({ ...RECT, width: 100 }), false);
});
