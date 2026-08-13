// Website-only ad slot loader. Unlike the desktop app (see
// docs/LEGAL.md — AdSense/Ad Manager forbid desktop-app placements), this
// is an ordinary browser page, so a standard AdSense unit is policy-clean
// here. Stays fully inert — no script injected, slot stays hidden — until
// both (a) ad-config.json has a real client/slot id and (b) the visitor
// has accepted the consent banner.
(function () {
  function loadAdSense(client) {
    if (document.querySelector('script[data-oe-adsense]')) return;
    var script = document.createElement("script");
    script.async = true;
    script.src = "https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=" + encodeURIComponent(client);
    script.crossOrigin = "anonymous";
    script.setAttribute("data-oe-adsense", "1");
    document.head.appendChild(script);
  }

  function render(config) {
    var slotEl = document.getElementById("site-ad-slot");
    if (!slotEl || !config.provider || !config.client || !config.slot) return;
    if (!window.oeConsent || !window.oeConsent.accepted()) return;

    if (config.provider === "adsense") {
      slotEl.innerHTML =
        '<ins class="adsbygoogle" style="display:block" data-ad-client="' +
        config.client +
        '" data-ad-slot="' +
        config.slot +
        '" data-ad-format="auto" data-full-width-responsive="true"></ins>';
      slotEl.hidden = false;
      loadAdSense(config.client);
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {
        /* adsbygoogle not ready yet — harmless, the tag still renders once the script loads */
      }
    }
  }

  function init() {
    fetch("/ad-config.json")
      .then(function (res) {
        return res.json();
      })
      .then(render)
      .catch(function () {
        /* no config, or config file missing — leave the slot hidden */
      });
  }

  document.addEventListener("DOMContentLoaded", init);
  window.addEventListener("oe:consent-changed", init);
})();
