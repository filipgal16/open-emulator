import { useEffect, useRef, useState } from 'react';
import type { AdsState, Creative, SlotId } from '../../shared/ads-types';
import { SLOTS } from '../../shared/ads-types';

/** Fraction of the slot that must be on screen before an impression can start counting. */
const VIEWABLE_RATIO = 0.5;
/** How long it must stay that way. A creative that flashes past was not an impression. */
const VIEWABLE_DWELL_MS = 1000;

/** `tag` = a third-party view is layered over us; `native` = we draw the creative ourselves. */
type Mode = 'deciding' | 'tag' | 'native';

interface Props {
  slot: SlotId;
  /** Lets a container (the interstitial) hide itself when nothing filled. */
  onFill?: (filled: boolean) => void;
}

/**
 * A single ad position. Renders nothing at all unless the main process says ads are active, so
 * an unconfigured build has no ad markup in the DOM whatsoever.
 *
 * Two ways a slot can fill. Normally the main process hands back a `Creative` and this component
 * draws it — it never learns a destination URL and never touches the network. When a third-party
 * network is configured, the slot instead reserves space and reports its bounds so an isolated
 * view can be positioned over it; if that view paints nothing, it falls back to the native path.
 */
export function AdSlot({ slot, onFill }: Props) {
  const [state, setState] = useState<AdsState | null>(null);
  const [mode, setMode] = useState<Mode>('deciding');
  const [tagTimeoutMs, setTagTimeoutMs] = useState(4000);
  const [creative, setCreative] = useState<Creative | null>(null);
  const [visible, setVisible] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  // Held as state rather than a ref: the host element only exists once a creative has arrived,
  // and the observer effect has to run at that moment. Keyed on a ref it would never attach.
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const reported = useRef(new Set<string>());
  const notifyFill = useRef(onFill);
  const onTagResult = useRef<(filled: boolean) => void>(() => undefined);

  const active = state?.active === true;
  const spec = SLOTS[slot];

  useEffect(() => {
    notifyFill.current = onFill;
  }, [onFill]);

  // Registered exactly once. The preload bridge has no way to remove a listener, so doing this
  // inside the tag effect would stack up another one on every remount.
  useEffect(() => {
    window.openEmu.onAdsTagResult((resultSlot, filled) => {
      if (resultSlot === slot) onTagResult.current(filled);
    });
  }, [slot]);

  useEffect(() => {
    let live = true;
    window.openEmu.adsState().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  // Decide once per activation whether a third-party tag gets first refusal on this slot.
  useEffect(() => {
    if (!active) {
      setMode('deciding');
      return;
    }
    let live = true;
    window.openEmu.adsTagPlan(slot).then((plan) => {
      if (!live) return;
      if (plan?.enabled) setTagTimeoutMs(plan.timeoutMs);
      setMode(plan?.enabled ? 'tag' : 'native');
    });
    return () => {
      live = false;
    };
  }, [active, slot]);

  // Tag mode: reserve the space, report where it is, and give the network a bounded amount of
  // time to paint something before handing the slot back to native inventory.
  useEffect(() => {
    if (mode !== 'tag' || !host) return;
    let live = true;

    const report = (mount: boolean) => {
      const rect = host.getBoundingClientRect();
      const bounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
      if (mount) window.openEmu.adsMountTag(slot, bounds);
      else window.openEmu.adsUpdateTagBounds(slot, bounds);
    };

    report(true);

    // The overlay is positioned by the OS, not by CSS, so every layout change has to be pushed
    // across or the ad visibly detaches from its slot.
    const observer = new ResizeObserver(() => report(false));
    observer.observe(host);
    const onResize = () => report(false);
    window.addEventListener('resize', onResize);

    onTagResult.current = (filled) => {
      if (live && !filled) setMode('native');
    };
    // A tag that never reports either way must not hold the slot hostage — after the configured
    // timeout the space goes back to inventory that will actually pay.
    const timeout = window.setTimeout(() => {
      if (!live) return;
      window.openEmu.adsUnmountTag(slot);
      setMode('native');
    }, tagTimeoutMs);

    return () => {
      live = false;
      onTagResult.current = () => undefined;
      observer.disconnect();
      window.removeEventListener('resize', onResize);
      window.clearTimeout(timeout);
      window.openEmu.adsUnmountTag(slot);
    };
  }, [mode, host, slot, tagTimeoutMs]);

  // Fill on activation, then rotate. A rotation that comes back empty (every campaign capped,
  // say) keeps the current creative rather than blanking the slot.
  useEffect(() => {
    if (mode !== 'native') return;
    let live = true;
    let announced = false;

    const fill = () => {
      window.openEmu.adsRequest(slot).then((next) => {
        if (!live) return;
        if (next) setCreative(next);
        if (!announced) {
          announced = true;
          notifyFill.current?.(next !== null);
        }
      });
    };

    fill();
    if (spec.rotateAfterMs <= 0) return () => { live = false; };

    const timer = window.setInterval(fill, spec.rotateAfterMs);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [mode, slot, spec.rotateAfterMs]);

  useEffect(() => {
    if (!host) {
      setVisible(false);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry.intersectionRatio >= VIEWABLE_RATIO),
      { threshold: [0, VIEWABLE_RATIO, 1] },
    );
    observer.observe(host);
    return () => observer.disconnect();
  }, [host]);

  useEffect(() => {
    const sync = () => setFocused(document.hasFocus() && document.visibilityState === 'visible');
    window.addEventListener('focus', sync);
    window.addEventListener('blur', sync);
    document.addEventListener('visibilitychange', sync);
    sync();
    return () => {
      window.removeEventListener('focus', sync);
      window.removeEventListener('blur', sync);
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  // The viewability gate. Counting an impression the user could not possibly have seen is how
  // networks end up clawing revenue back as invalid traffic, so the bar is on screen *and*
  // focused *and* still there a second later.
  useEffect(() => {
    if (!creative || !visible || !focused) return;
    if (reported.current.has(creative.token)) return;
    const token = creative.token;
    const timer = window.setTimeout(() => {
      reported.current.add(token);
      window.openEmu.adsImpression(token);
    }, VIEWABLE_DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [creative, visible, focused]);

  if (!active) return null;

  // In tag mode the container is an empty, correctly-sized hole for the overlay to sit in.
  if (mode === 'tag') {
    return (
      <div
        ref={setHost}
        className={`ad-slot ad-slot-${slot} ad-slot-tag`}
        style={{ width: spec.width, height: spec.height }}
      />
    );
  }

  if (mode !== 'native' || !creative) return null;

  const label = creative.source === 'house' ? 'From the project' : 'Sponsored';

  async function hideAds() {
    setState(await window.openEmu.adsSetOptedOut(true));
  }

  return (
    <div ref={setHost} className={`ad-slot ad-slot-${slot}`} data-source={creative.source}>
      <div className="ad-meta">
        <span className="ad-label">{label}</span>
        <span className="ad-advertiser">{creative.advertiser}</span>
        <button type="button" className="ad-hide" title="Hide ads" aria-label="Hide ads" onClick={hideAds}>
          ✕
        </button>
      </div>
      <button type="button" className="ad-body" onClick={() => window.openEmu.adsClick(creative.token)}>
        {creative.imageUrl && <img className="ad-image" src={creative.imageUrl} alt="" />}
        <span className="ad-text">
          <span className="ad-headline">{creative.headline}</span>
          <span className="ad-copy">{creative.body}</span>
        </span>
        <span className="ad-cta">{creative.cta}</span>
      </button>
    </div>
  );
}
