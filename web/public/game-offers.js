// Renders one sponsored offer from the same ad server the desktop app's
// Game Center panel uses (see monetize/server, desktop/lib/ads.js). Reads
// the server URL from ad-config.json's adServerUrl — empty by default, so
// this makes zero network calls on a fresh clone. Consent-gated the same
// way the site-wide rail is (see consent.js), since this is still a
// sponsored placement even though it's rendered natively, not via a
// third-party script.
(function () {
  function render(creative) {
    const box = document.getElementById("sponsored-offer");
    if (!box || !creative) return;
    document.getElementById("sponsored-offer-text").textContent = `${creative.title} — ${creative.body}`;
    const cta = document.getElementById("sponsored-offer-cta");
    cta.textContent = creative.cta || "Learn more";
    cta.href = creative.clickUrl && creative.clickUrl.startsWith("/")
      ? `${window.__oeAdServerUrl}${creative.clickUrl}`
      : creative.clickUrl || "#";
    box.hidden = false;
  }

  function pick(creatives) {
    if (!creatives || !creatives.length) return null;
    const total = creatives.reduce((sum, c) => sum + (Number(c.weight) || 1), 0);
    let roll = Math.random() * total;
    for (const creative of creatives) {
      roll -= Number(creative.weight) || 1;
      if (roll <= 0) return creative;
    }
    return creatives[0];
  }

  function init() {
    if (!window.oeConsent || !window.oeConsent.accepted()) return;
    fetch("/ad-config.json")
      .then((res) => res.json())
      .then((config) => {
        if (!config.adServerUrl) return;
        window.__oeAdServerUrl = config.adServerUrl.replace(/\/$/, "");
        return fetch(`${window.__oeAdServerUrl}/v1/campaigns`).then((res) => res.json());
      })
      .then((campaigns) => {
        if (!campaigns) return;
        render(pick(campaigns.slots && campaigns.slots["games-page"]));
      })
      .catch(() => {
        /* no ad server configured, or unreachable — leave the slot hidden */
      });
  }

  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("oe:consent-changed", init);
})();
