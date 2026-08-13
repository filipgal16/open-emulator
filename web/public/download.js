(function () {
  function detectPlatform() {
    const platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    const ua = navigator.userAgent || "";
    if (/mac/i.test(platform) || /Mac/i.test(ua)) return "mac";
    if (/win/i.test(platform) || /Windows/i.test(ua)) return "windows";
    if (/linux/i.test(platform) || /Linux|X11/i.test(ua)) return "linux";
    return null;
  }

  var detected = detectPlatform();
  if (!detected) return;
  var card = document.querySelector('.platform-card[data-platform="' + detected + '"]');
  if (!card || card.querySelector(".tag.you")) return;
  var badge = document.createElement("span");
  badge.className = "tag you";
  badge.style.marginLeft = "8px";
  badge.textContent = "Your OS";
  var tag = card.querySelector(".tag");
  if (tag) tag.after(badge);
})();
