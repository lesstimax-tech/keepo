/** Utilitaires partagés KEEPO */
window.KEEPO = window.KEEPO || {};

KEEPO.isUuid = function (value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
};

KEEPO.escapeHtml = function (text) {
  const div = document.createElement("span");
  div.textContent = text;
  return div.innerHTML;
};

KEEPO.showToast = function (message, type) {
  type = type || "error";
  let toast = document.getElementById("toastMessage");
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "toastMessage";
    toast.className = "toast-notification";
    document.body.appendChild(toast);
  }
  toast.innerHTML = type === "error" ? "⚠️ " + KEEPO.escapeHtml(message) : "✅ " + KEEPO.escapeHtml(message);
  toast.className = "toast-notification show toast-" + type;
  clearTimeout(KEEPO._toastTimer);
  KEEPO._toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, 4000);
};

KEEPO.setButtonLoading = function (buttonId, isLoading, originalText) {
  const btn = document.getElementById(buttonId);
  if (!btn) return;
  if (isLoading) {
    btn.disabled = true;
    btn.style.opacity = "0.7";
    btn.innerText = "⏳ Chargement…";
  } else {
    btn.disabled = false;
    btn.style.opacity = "1";
    btn.innerText = originalText;
  }
};

/** Seuil d'affichage barre de progression (min des récompenses ou défaut 10) */
KEEPO.getPointsThreshold = function (rewards) {
  if (!rewards || !rewards.length) return 10;
  const mins = rewards.map(function (r) {
    return r.points_required != null ? r.points_required : r.points;
  }).filter(function (n) { return typeof n === "number" && n > 0; });
  return mins.length ? Math.min.apply(null, mins) : 10;
};

KEEPO.renderQrInto = function (container, data, size) {
  size = size || 150;
  container.innerHTML = "";
  if (typeof QRCode !== "undefined") {
    const canvas = document.createElement("canvas");
    QRCode.toCanvas(canvas, String(data), { width: size, margin: 1, color: { dark: "#0a0911", light: "#ffffff" } }, function (err) {
      if (err) {
        container.textContent = "QR indisponible";
        return;
      }
      container.appendChild(canvas);
    });
    return;
  }
  const img = document.createElement("img");
  img.alt = "QR Code";
  img.width = size;
  img.height = size;
  img.src = "https://api.qrserver.com/v1/create-qr-code/?size=" + size + "x" + size + "&data=" + encodeURIComponent(data);
  container.appendChild(img);
};

KEEPO.getOAuthRedirectUrl = function () {
  return window.location.origin + window.location.pathname;
};
