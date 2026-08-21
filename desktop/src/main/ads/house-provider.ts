import type { SlotId } from '../../shared/ads-types';
import type { AdProvider, Fill, FillContext } from './provider';

export interface HouseCampaign {
  id: string;
  slots: SlotId[];
  /** Relative selection weight among eligible campaigns. Must be > 0. */
  weight: number;
  headline: string;
  body: string;
  cta: string;
  advertiser: string;
  clickUrl: string;
  imageUrl?: string | null;
}

/**
 * The bottom of the waterfall: promotion for the project itself.
 *
 * These are text-rendered rather than image creatives, so they ship with no binary assets and
 * survive being shown offline — which matters because the slot most likely to be visible is the
 * setup wizard's, on a machine that may still be downloading a 4 GiB SDK.
 *
 * Replace or extend these to promote whatever a given build should promote; they are ordinary
 * data, not part of the fill logic.
 */
export const DEFAULT_HOUSE_CAMPAIGNS: HouseCampaign[] = [
  {
    id: 'house-star',
    slots: ['wizard-footer', 'rail'],
    weight: 3,
    headline: 'open-emulator is open source',
    body: 'Built in the open, from the hypervisor up. Stars help other people find it.',
    cta: 'Star on GitHub',
    advertiser: 'open-emulator',
    clickUrl: 'https://github.com/filipgal16/open-emulator',
  },
  {
    id: 'house-issues',
    slots: ['wizard-footer', 'rail'],
    weight: 2,
    headline: 'Something not working?',
    body: 'Boot failures and setup problems are worth reporting — most get fixed from one log.',
    cta: 'Open an issue',
    advertiser: 'open-emulator',
    clickUrl: 'https://github.com/filipgal16/open-emulator/issues',
  },
  {
    id: 'house-apps',
    slots: ['library-tile'],
    weight: 2,
    headline: 'Install an APK',
    body: 'Drop a file on the window, or run open-emu install path/to/app.apk.',
    cta: 'See the docs',
    advertiser: 'open-emulator',
    clickUrl: 'https://github.com/filipgal16/open-emulator#android-guest-api-30--android-11',
  },
  {
    id: 'house-contribute',
    slots: ['rail'],
    weight: 1,
    headline: 'Know your way around KVM?',
    body: 'The VMM is heading for long mode and virtio. Contributors welcome.',
    cta: 'Read the source',
    advertiser: 'open-emulator',
    clickUrl: 'https://github.com/filipgal16/open-emulator#next-steps',
  },
];

export class HouseProvider implements AdProvider {
  readonly source = 'house' as const;

  constructor(
    private readonly campaigns: HouseCampaign[] = DEFAULT_HOUSE_CAMPAIGNS,
    private readonly random: () => number = Math.random,
  ) {}

  async fill(slot: SlotId, ctx: FillContext): Promise<Fill | null> {
    const eligible = this.campaigns.filter(
      (c) => c.slots.includes(slot) && c.weight > 0 && !ctx.excluded.has(c.id),
    );
    // Frequency caps apply to house ads too, so this genuinely can come up empty. A blank slot is
    // better than showing a capped creative anyway.
    if (eligible.length === 0) return null;

    const total = eligible.reduce((sum, c) => sum + c.weight, 0);
    let ticket = this.random() * total;
    // `pick` is only a fallback for float drift at the very top of the range; the loop below
    // normally settles on an earlier entry.
    let pick = eligible[eligible.length - 1];
    for (const candidate of eligible) {
      ticket -= candidate.weight;
      if (ticket < 0) {
        pick = candidate;
        break;
      }
    }

    return {
      campaignId: pick.id,
      headline: pick.headline,
      body: pick.body,
      cta: pick.cta,
      advertiser: pick.advertiser,
      imageUrl: pick.imageUrl ?? null,
      clickUrl: pick.clickUrl,
    };
  }
}
