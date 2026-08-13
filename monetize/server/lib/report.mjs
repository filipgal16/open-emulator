import { readEvents } from "./store.mjs";

// This is the rate card: what to show a prospective direct sponsor, and
// the honest "is this worth an affiliate network's time" number. All
// revenue figures are *estimates* off configured cpmCents/payoutCents —
// there is no real money moving through this server.
export async function buildReport(root, config, { sinceDays = 30 } = {}) {
  const events = await readEvents(root, { sinceDays });
  const byCreative = new Map();

  const creativeMeta = new Map();
  for (const [slot, creatives] of Object.entries(config.slots || {})) {
    for (const creative of creatives || []) {
      creativeMeta.set(creative.id, { ...creative, slot });
    }
  }

  const bump = (id, field) => {
    const row = byCreative.get(id) || { id, impressions: 0, clicks: 0, conversions: 0, conversionValueCents: 0 };
    row[field] += 1;
    byCreative.set(id, row);
  };

  for (const event of events) {
    if (event.type === "impression" && event.id) bump(event.id, "impressions");
    if (event.type === "click" && event.id) bump(event.id, "clicks");
    if (event.type === "conversion" && event.id) {
      const row = byCreative.get(event.id) || {
        id: event.id,
        impressions: 0,
        clicks: 0,
        conversions: 0,
        conversionValueCents: 0
      };
      row.conversions += 1;
      row.conversionValueCents += Number(event.amountCents) || 0;
      byCreative.set(event.id, row);
    }
  }

  const rows = [...byCreative.values()].map((row) => {
    const meta = creativeMeta.get(row.id) || {};
    const ctr = row.impressions ? row.clicks / row.impressions : 0;
    const cpmRevenueCents = (row.impressions / 1000) * (Number(meta.cpmCents) || 0);
    const clickRevenueCents = row.clicks * (Number(meta.payoutCentsPerClick) || 0);
    const estimatedRevenueCents = Math.round(cpmRevenueCents + clickRevenueCents + row.conversionValueCents);
    return {
      id: row.id,
      slot: meta.slot || "unknown",
      title: meta.title || row.id,
      impressions: row.impressions,
      clicks: row.clicks,
      ctr: Number(ctr.toFixed(4)),
      conversions: row.conversions,
      estimatedRevenueCents
    };
  });

  rows.sort((a, b) => b.estimatedRevenueCents - a.estimatedRevenueCents);

  const totals = rows.reduce(
    (acc, row) => ({
      impressions: acc.impressions + row.impressions,
      clicks: acc.clicks + row.clicks,
      conversions: acc.conversions + row.conversions,
      estimatedRevenueCents: acc.estimatedRevenueCents + row.estimatedRevenueCents
    }),
    { impressions: 0, clicks: 0, conversions: 0, estimatedRevenueCents: 0 }
  );
  totals.ctr = totals.impressions ? Number((totals.clicks / totals.impressions).toFixed(4)) : 0;
  totals.estimatedEcpmCents = totals.impressions ? Math.round((totals.estimatedRevenueCents / totals.impressions) * 1000) : 0;

  return { sinceDays, generatedAt: new Date().toISOString(), totals, creatives: rows };
}
