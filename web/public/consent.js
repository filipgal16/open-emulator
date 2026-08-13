(function () {
  var KEY = "oe_consent";

  function getConsent() {
    try {
      return window.localStorage.getItem(KEY);
    } catch {
      return null;
    }
  }

  function setConsent(value) {
    try {
      window.localStorage.setItem(KEY, value);
    } catch {
      /* localStorage unavailable (privacy mode) — banner just reappears next visit */
    }
    window.dispatchEvent(new CustomEvent("oe:consent-changed", { detail: { value: value } }));
  }

  window.oeConsent = {
    get: getConsent,
    accepted: function () {
      return getConsent() === "accepted";
    }
  };

  document.addEventListener("DOMContentLoaded", function () {
    var banner = document.getElementById("consent-banner");
    if (!banner) return;
    if (!getConsent()) banner.hidden = false;

    var accept = document.getElementById("consent-accept");
    var decline = document.getElementById("consent-decline");
    if (accept) {
      accept.addEventListener("click", function () {
        setConsent("accepted");
        banner.hidden = true;
      });
    }
    if (decline) {
      decline.addEventListener("click", function () {
        setConsent("declined");
        banner.hidden = true;
      });
    }
  });
})();
