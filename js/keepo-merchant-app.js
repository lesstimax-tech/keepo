/** Application commerçant KEEPO */
(function () {
  let currentMerchantId = null;
  let isDemoMode = false;
  let currentClient = { id: null, name: "", points: 0 };
  let totalCa = 0;
  let uniqueClientsCount = 0;
  let giftsDistributed = 0;
  let rewardsList = [];
  let pointsPerEuro = 0.1;
  let html5MerchantScanner = null;
  let scanLoopActive = false;

  window.activeQrCodeDesigner = null;

  async function init() {
    const auth = await KEEPO.requireAuth("commercant", { allowDemo: true });
    if (!auth) return;

    if (auth.demo) {
      isDemoMode = true;
      currentMerchantId = "MOCK_MERCHANT_UUID_9841";
      document.getElementById("view-onboarding").classList.add("active");
      return;
    }

    currentMerchantId = auth.session.user.id;
    isDemoMode = false;

    const { data: card } = await supabaseClient
      .from("merchant_cards")
      .select("*")
      .eq("merchant_id", currentMerchantId)
      .maybeSingle();

    if (card) {
      if (card.points_per_euro) pointsPerEuro = Number(card.points_per_euro);
      enableApplicationInterface();
      await loadCloudBackendData();
      await refreshHistoryFromDb();
    }
  }

  function enableApplicationInterface() {
    document.getElementById("burgerMenuButton").style.display = "flex";
    document.getElementById("badge-mode-text").innerText = "⚡ Terminal Actif";
    document.querySelectorAll(".app-view").forEach(function (v) { v.classList.remove("active"); });
    document.getElementById("view-scan").classList.add("active");
    startMerchantQrScanLoop();
  }

  async function openClientFromScan(clientId) {
    if (!KEEPO.isUuid(clientId) || clientId === currentMerchantId) {
      KEEPO.showToast("QR client invalide.", "error");
      return;
    }
    const points = await KEEPO.getClientBalance(currentMerchantId, clientId);
    const { data: profile } = await supabaseClient
      .from("profiles")
      .select("name")
      .eq("id", clientId)
      .maybeSingle();
    const label = profile && profile.name ? profile.name : "Client " + clientId.substring(0, 8);
    openAmountInputStep(label, clientId, points);
  }

  function startMerchantQrScanLoop() {
    if (isDemoMode || typeof Html5Qrcode === "undefined") return;
    const targetId = "merchant-qr-reader";
    let el = document.getElementById(targetId);
    if (!el) {
      el = document.createElement("div");
      el.id = targetId;
      el.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;";
      document.querySelector(".camera-container").appendChild(el);
    }
    if (html5MerchantScanner) return;

    html5MerchantScanner = new Html5Qrcode(targetId);
    html5MerchantScanner.start(
      { facingMode: "environment" },
      { fps: 8, qrbox: { width: 220, height: 220 } },
      function (decoded) {
        if (!scanLoopActive) return;
        scanLoopActive = false;
        openClientFromScan(decoded.trim()).finally(function () {
          setTimeout(function () { scanLoopActive = true; }, 2500);
        });
      },
      function () {}
    ).catch(function () {
      console.warn("Scanner QR commerçant indisponible");
    });
    scanLoopActive = true;
  }

  window.saveOnboardStep1 = async function () {
    const title = document.getElementById("onboard-title").value.trim();
    const color = document.getElementById("onboard-color").value;
    if (!title) {
      KEEPO.showToast("Nom requis.", "error");
      return;
    }
    document.getElementById("cardTitleInput").value = title;
    document.getElementById("cardColorPicker").value = color;
    updateCardPreview();
    if (!isDemoMode) {
      await supabaseClient.from("merchant_cards").upsert({
        merchant_id: currentMerchantId,
        title: title,
        color: color
      });
    }
    document.getElementById("onboard-1").classList.remove("active");
    document.getElementById("onboard-2").classList.add("active");
  };

  window.saveOnboardStep2 = async function () {
    const giftName = document.getElementById("onboard-gift-name").value.trim();
    const giftPts = parseInt(document.getElementById("onboard-gift-pts").value, 10);
    if (!giftName || isNaN(giftPts)) {
      KEEPO.showToast("Informations requises.", "error");
      return;
    }
    rewardsList.push({ id: Date.now(), name: giftName, points: giftPts, img: "https://picsum.photos/200/120?random=1" });
    renderGifts();
    if (!isDemoMode) {
      await supabaseClient.from("rewards").insert([{
        merchant_id: currentMerchantId,
        name: giftName,
        points_required: giftPts
      }]);
    }
    document.getElementById("onboard-2").classList.remove("active");
    document.getElementById("onboard-3").classList.add("active");
    const brandColor = document.getElementById("onboard-color").value;
    setTimeout(function () {
      document.getElementById("ai-loading-zone").style.display = "none";
      document.getElementById("ai-result-zone").style.display = "block";
      window.activeQrCodeDesigner = new QRCodeStyling({
        width: 250,
        height: 250,
        type: "svg",
        data: currentMerchantId,
        dotsOptions: { color: brandColor, type: "rounded" },
        cornersSquareOptions: { color: "#0a0911", type: "extra-rounded" },
        backgroundOptions: { color: "#ffffff" }
      });
      document.getElementById("store-join-qrcode-container").innerHTML = "";
      window.activeQrCodeDesigner.append(document.getElementById("store-join-qrcode-container"));
    }, 1500);
  };

  window.downloadQrCode = function () {
    if (window.activeQrCodeDesigner) {
      window.activeQrCodeDesigner.download({ name: "KEEPO-QR-Code-Magasin", extension: "png" });
    }
  };

  window.finishOnboarding = function () {
    enableApplicationInterface();
    switchView("view-scan");
  };

  window.toggleSidebar = function () {
    document.getElementById("sidebarMenu").classList.toggle("open");
    document.getElementById("sidebarOverlay").classList.toggle("open");
  };

  window.switchView = function (viewId) {
    toggleSidebar();
    document.querySelectorAll(".app-view").forEach(function (v) { v.classList.remove("active"); });
    document.querySelectorAll(".menu-item-btn").forEach(function (b) { b.classList.remove("active"); });
    document.getElementById(viewId).classList.add("active");
    const btn = document.getElementById("btn-view-" + viewId.replace("view-", ""));
    if (btn) btn.classList.add("active");
  };

  function renderGifts() {
    const container = document.getElementById("gifts-container");
    if (!container) return;
    container.innerHTML = "";
    rewardsList.forEach(function (gift) {
      container.innerHTML +=
        '<div class="gift-card"><div class="gift-photo-frame"><img src="' + gift.img + '" alt=""></div>' +
        "<h4 style=\"font-size:16px;font-weight:700;\">" + KEEPO.escapeHtml(gift.name) + "</h4>" +
        '<div style="color:var(--secondary-accent);font-weight:700;font-size:14px;margin-top:5px;">' +
        gift.points + " points requis</div></div>";
    });
  }

  window.addGiftReward = async function () {
    const name = document.getElementById("gift-name-input").value.trim();
    const points = parseInt(document.getElementById("gift-points-input").value, 10);
    if (!name || isNaN(points)) return;
    if (!isDemoMode) {
      await supabaseClient.from("rewards").insert([{ merchant_id: currentMerchantId, name: name, points_required: points }]);
    }
    rewardsList.push({ id: Date.now(), name: name, points: points, img: "https://picsum.photos/200/120?random=" + Math.floor(Math.random() * 50) });
    renderGifts();
    document.getElementById("gift-name-input").value = "";
    document.getElementById("gift-points-input").value = "";
  };

  window.updateCardPreview = function () {
    const color = document.getElementById("cardColorPicker").value;
    const title = document.getElementById("cardTitleInput").value;
    document.getElementById("previewCardElement").style.background = "linear-gradient(135deg, " + color + ", #09080f)";
    document.getElementById("previewCardTitle").innerText = title || "Commerce";
    if (!isDemoMode) {
      supabaseClient.from("merchant_cards").update({ title: title, color: color }).eq("merchant_id", currentMerchantId);
    }
  };

  window.triggerSimulatedScan = function () {
    const rand = "00000000-0000-4000-8000-" + String(Math.floor(Math.random() * 1e12)).padStart(12, "0");
    openAmountInputStep("Client démo", rand, Math.random() > 0.5 ? 12 : 3);
  };

  window.triggerManualEntry = async function () {
    const raw = document.getElementById("manual-email").value.trim();
    if (!KEEPO.isUuid(raw)) {
      KEEPO.showToast("Collez l'UUID du client (affiché sur son QR).", "error");
      return;
    }
    await openClientFromScan(raw);
  };

  function openAmountInputStep(name, clientId, points) {
    currentClient = { id: clientId, name: name, points: points };
    document.getElementById("detected-client-name").innerText = name;
    document.getElementById("detected-client-points").innerText = "Solde : " + points + " points";
    document.getElementById("order-amount").value = "";
    const targetThreshold = rewardsList.length ? rewardsList[0].points : 8;
    const redeemZone = document.getElementById("reward-redeem-zone");
    if (points >= targetThreshold && rewardsList.length) {
      document.getElementById("reward-button-text").innerText =
        "🎁 Offrir : " + rewardsList[0].name + " (-" + targetThreshold + " Pts)";
      redeemZone.style.display = "block";
    } else {
      redeemZone.style.display = "none";
    }
    document.getElementById("modal-step-input").style.display = "block";
    document.getElementById("modal-step-success").style.display = "none";
    document.getElementById("amountModal").classList.add("show");
  }

  function shootConfetti() {
    const colors = ["#1e9488", "#2ee6d4", "#ea4335", "#FBBC05"];
    for (let i = 0; i < 40; i++) {
      const conf = document.createElement("div");
      conf.className = "confetti";
      conf.style.left = Math.random() * 100 + "vw";
      conf.style.backgroundColor = colors[Math.floor(Math.random() * colors.length)];
      conf.style.animationDuration = Math.random() + 1 + "s";
      document.body.appendChild(conf);
      setTimeout(function () { conf.remove(); }, 2500);
    }
  }

  function appendHistoryUi(name, subtitle, ptsLabel, borderColor) {
    const fullHistory = document.getElementById("full-history-log");
    const newItem = document.createElement("li");
    newItem.className = "history-item";
    newItem.style.borderLeft = "3px solid " + borderColor;
    newItem.innerHTML =
      "<div><strong>" + KEEPO.escapeHtml(name) + "</strong><br><span style=\"font-size:11px;\">" +
      KEEPO.escapeHtml(subtitle) + "</span></div><div style=\"font-weight:700;color:" + borderColor + "\">" + ptsLabel + "</div>";
    fullHistory.insertBefore(newItem, fullHistory.firstChild);
  }

  window.confirmRewardRedemption = async function () {
    if (!currentClient.id) return;
    const targetThreshold = rewardsList.length ? rewardsList[0].points : 8;
    try {
      if (!isDemoMode) {
        currentClient.points = await KEEPO.applyDebit(currentMerchantId, currentClient.id, targetThreshold);
      } else {
        currentClient.points -= targetThreshold;
      }
      giftsDistributed++;
      document.getElementById("dash-gifts-count").innerText = String(giftsDistributed);
      appendHistoryUi(currentClient.name, "Récompense accordée", "-" + targetThreshold + " Pts", "#ea4335");
      shootConfetti();
      document.getElementById("success-headline").innerText = "Cadeau validé !";
      document.getElementById("modal-step-input").style.display = "none";
      document.getElementById("modal-step-success").style.display = "block";
      setTimeout(function () { document.getElementById("amountModal").classList.remove("show"); }, 2500);
    } catch (e) {
      KEEPO.showToast(e.message, "error");
    }
  };

  window.confirmOrderAmount = async function () {
    if (!currentClient.id) return;
    const amount = parseFloat(document.getElementById("order-amount").value);
    if (isNaN(amount) || amount <= 0) return;
    const ptsEarned = Math.max(1, Math.floor(amount * pointsPerEuro));
    try {
      const prevBalance = currentClient.points;
      if (!isDemoMode) {
        currentClient.points = await KEEPO.applyCredit(currentMerchantId, currentClient.id, amount, ptsEarned);
      } else {
        currentClient.points += ptsEarned;
      }
      totalCa += amount;
      if (prevBalance === 0) uniqueClientsCount++;
      const avgCart = totalCa / (uniqueClientsCount || 1);
      document.getElementById("dash-ca").innerText = totalCa.toFixed(2) + "€";
      document.getElementById("dash-clients-count").innerText = String(uniqueClientsCount);
      document.getElementById("dash-avg-cart").innerText = avgCart.toFixed(2) + "€";
      appendHistoryUi(
        currentClient.name,
        "Achat de " + amount.toFixed(2) + "€",
        "+" + ptsEarned + " Pts",
        "var(--secondary-accent)"
      );
      document.getElementById("success-headline").innerText = "Points accordés !";
      document.getElementById("modal-step-input").style.display = "none";
      document.getElementById("modal-step-success").style.display = "block";
      setTimeout(function () { document.getElementById("amountModal").classList.remove("show"); }, 2000);
    } catch (e) {
      KEEPO.showToast(e.message, "error");
    }
  };

  window.exportHistoryCSV = function () {
    const items = document.querySelectorAll("#full-history-log .history-item");
    if (!items.length) {
      KEEPO.showToast("Historique vide.", "error");
      return;
    }
    let csv = "data:text/csv;charset=utf-8,Client,Action,Points\n";
    items.forEach(function (item) {
      csv += item.innerText.replace(/\n/g, " - ") + "\n";
    });
    const link = document.createElement("a");
    link.href = encodeURI(csv);
    link.download = "KEEPO_export_caisse.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
  };

  async function loadCloudBackendData() {
    const { data: mc } = await supabaseClient.from("merchant_cards").select("*").eq("merchant_id", currentMerchantId).single();
    if (mc) {
      document.getElementById("cardTitleInput").value = mc.title;
      document.getElementById("previewCardTitle").innerText = mc.title;
      if (mc.points_per_euro) pointsPerEuro = Number(mc.points_per_euro);
    }
    const { data: r } = await supabaseClient.from("rewards").select("*").eq("merchant_id", currentMerchantId);
    if (r) {
      rewardsList = r.map(function (g) {
        return { id: g.id, name: g.name, points: g.points_required, img: "https://picsum.photos/200/120?random=2" };
      });
      renderGifts();
    }
  }

  async function refreshHistoryFromDb() {
    if (isDemoMode) return;
    try {
      const rows = await KEEPO.loadMerchantHistory(currentMerchantId, 50);
      const log = document.getElementById("full-history-log");
      log.innerHTML = "";
      rows.forEach(function (h) {
        const isCredit = h.type === "credit";
        appendHistoryUi(
          "Client",
          isCredit ? "Achat " + (h.amount || 0) + "€" : "Récompense",
          (isCredit ? "+" : "") + h.points_changed + " Pts",
          isCredit ? "var(--secondary-accent)" : "#ea4335"
        );
      });
    } catch (e) {
      console.warn(e);
    }
  }

  window.updateShopInfo = async function () {
    const name = document.getElementById("set-name").value.trim();
    const addr = document.getElementById("set-address").value.trim();
    const ratio = parseFloat(document.getElementById("set-ratio").value);
    if (!isDemoMode) {
      const payload = { title: name || undefined, address: addr || undefined };
      if (!isNaN(ratio) && ratio > 0) {
        pointsPerEuro = 1 / ratio;
        payload.points_per_euro = pointsPerEuro;
      }
      await supabaseClient.from("merchant_cards").update(payload).eq("merchant_id", currentMerchantId);
      KEEPO.showToast("Paramètres enregistrés.", "success");
    }
  };

  window.dangerZoneReset = async function () {
    if (!confirm("Supprimer toutes les transactions et soldes clients de votre boutique ?")) return;
    if (!isDemoMode) {
      await supabaseClient.from("transactions").delete().eq("merchant_id", currentMerchantId);
      await supabaseClient.from("loyalty_balances").delete().eq("merchant_id", currentMerchantId);
      KEEPO.showToast("Données réinitialisées.", "success");
      location.reload();
    }
  };

  window.changeAppBrightness = function (mode) {
    document.body.classList.toggle("light-mode", mode === "light");
  };

  window.changeVisualMode = function (mode) {
    document.body.classList.toggle("neon-mode", mode === "neon");
  };

  window.handleLogout = async function () {
    await KEEPO.signOut();
    window.location.href = "connexion.html";
  };

  window.addEventListener("DOMContentLoaded", function () {
    document.body.classList.remove("neon-mode");
    init();
    const video = document.getElementById("webcam");
    if (video && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } })
        .then(function (s) { video.srcObject = s; })
        .catch(function () {});
    }
  });
})();
