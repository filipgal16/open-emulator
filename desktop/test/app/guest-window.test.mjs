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
  assert.deepEqual(embed.calls, ['wait:1234', 'embed:800x600']);
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

test('detaching forgets the window without touching it', async () => {
  // The emulator owns that window and is being asked to exit; un-parenting it mid-shutdown risks a
  // crash for no benefit.
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);
  embed.calls.length = 0;

  guest.detach();

  assert.equal(guest.isAttached(), false);
  assert.deepEqual(embed.calls, [], 'nothing was destroyed or re-parented');
});

test('a window that died underneath us reads as detached', async () => {
  const embed = fakeEmbed();
  const guest = windowFor(embed);
  await guest.attach(1234, PARENT, RECT);

  embed.isLiveWindow = () => false;

  assert.equal(guest.isAttached(), false);
  assert.equal(guest.setBounds({ ...RECT, width: 100 }), false);
});
