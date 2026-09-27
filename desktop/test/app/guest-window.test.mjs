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
    // Where the window actually is. Defaults to "exactly where it was put", so the watchdog is a
    // no-op unless a test says otherwise.
    childBounds: (child, parent) => over.actual ?? null,
    // No natural size known: the placement is the whole viewport until the emulator shapes itself.
    clientSize: () => over.natural ?? null,
    hideOwnedWindows: () => 0,
    ...over,
  };
}

// The watchdog is driven by hand through `check()` in these tests; the interval only has to be
// long enough never to fire on its own.
const windowFor = (embed) => new GuestWindow({ embed, attachTimeoutMs: 50, watchIntervalMs: 60_000 });

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

// ── The watchdog ───────────────────────────────────────────────────────────────────────────────

test('a window that reshaped itself is fitted and centred at its new aspect, not forced back', async () => {
  // The emulator keeps the panel's aspect ratio whatever it is told. Forcing the pane's shape back
  // on a timer made it flicker between the two forever; the shape is its call, the position ours.
  const embed = fakeEmbed({ actual: { x: 0, y: 40, width: 381, height: 678 } });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.check();

  // 381:678 fitted into 800x600 → height 600, width 337, centred → x = (800-337)/2 = 232 (rounded).
  assert.deepEqual(embed.calls, ['move:232,40,337x600']);
});

test('a reshaped window that fits keeps its exact size and is only centred', async () => {
  // Qt corrected our 477x849 to 476x848 and, believing itself top-level, re-applied that geometry
  // in screen coordinates — landing offset by the parent's origin. Re-deriving 477x849 from the
  // aspect ratio gave it something to correct again, twice a second. Its size stands; we centre.
  const embed = fakeEmbed({ actual: { x: 601, y: 323, width: 476, height: 500 } });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.check();

  // Same 476x500, centred in 800x600 at (0,40): x = 162, y = 40 + 50 = 90.
  assert.deepEqual(embed.calls, ['move:162,90,476x500']);
});

test('a window already at the size we would choose is accepted, not nudged', async () => {
  const embed = fakeEmbed({ actual: { x: 231, y: 40, width: 338, height: 600 } });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.check();

  assert.deepEqual(embed.calls, [], 'within rounding of the fit — leave it alone');
});

test('the emulator’s natural shape is used for the very first placement', async () => {
  // Read before embedding, so the first thing on screen is already the fitted rectangle rather
  // than a full-pane one that Qt shrinks a moment later.
  const embed = fakeEmbed({ natural: { width: 720, height: 1280 } });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);

  // 9:16 into 800x600 → 338x600 centred at x=231.
  assert.deepEqual(embed.calls, ['wait:1234', 'capture', 'embed:338x600']);
  assert.deepEqual(guest.placement(), { x: 231, y: 40, width: 338, height: 600 });
});

test('a new viewport keeps the aspect and re-centres', async () => {
  const embed = fakeEmbed({ natural: { width: 720, height: 1280 } });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.setBounds({ x: 0, y: 40, width: 400, height: 1000 });

  // Now width-limited: 400 wide → 711 tall, centred vertically at 40 + (1000-711)/2.
  assert.deepEqual(embed.calls, ['move:0,185,400x711']);
});

test('a window that is where it belongs is left alone', async () => {
  const embed = fakeEmbed({ actual: { ...RECT } });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.check();

  assert.deepEqual(embed.calls, []);
});

test('a hidden window is not moved — hidden is the airspace escape hatch, not drift', async () => {
  const embed = fakeEmbed({ actual: { x: 9, y: 9, width: 9, height: 9 } });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  guest.setVisible(false);
  embed.calls.length = 0;

  guest.check();

  assert.deepEqual(embed.calls, []);
});

test('the emulator’s floating toolbar is hidden on attach', async () => {
  const embed = fakeEmbed({
    hideOwnedWindows: () => {
      embed.calls.push('hide-owned');
      return 1;
    },
  });
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);

  assert.ok(embed.calls.includes('hide-owned'));
});
