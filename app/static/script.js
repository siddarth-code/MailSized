/* MailSized script — v7 (null-safe DOM writes) */
/* eslint-disable no-console */

console.log("MailSized script version: v7-nullsafe");

//
// ---------- tiny DOM helpers (null-safe) ----------
//
const byId = (id) => document.getElementById(id) || null;

// Set textContent only if node exists
const safeText = (id, text) => {
  const el = byId(id);
  if (el) el.textContent = text;
};

// Set innerHTML only if node exists
const safeHTML = (id, html) => {
  const el = byId(id);
  if (el) el.innerHTML = html;
};

// Show/Hide by id
const safeShow = (id, show) => {
  const el = byId(id);
  if (!el) return;
  el.style.display = show ? "" : "none";
};

// Toggle a class on a NodeList
const toggleClass = (nodeList, className, target) => {
  nodeList.forEach((n) => {
    if (!n) return;
    if (n === target) n.classList.add(className);
    else n.classList.remove(className);
  });
};

const currency = (n) => `$${Number(n || 0).toFixed(2)}`;

//
// ---------- elements (may be null; we use helpers) ----------
//
const uploadArea = byId("uploadArea");
const fileInput = byId("fileInput");
const fileInfo = byId("fileInfo");
const fileNameEl = byId("fileName");
const fileSizeEl = byId("fileSize");
const fileDurationEl = byId("fileDuration");
const removeFileBtn = byId("removeFile");

const providerCards = Array.from(document.querySelectorAll(".provider-card")) || [];
const priorityCb = byId("priority");
const transcriptCb = byId("transcript");
const emailInput = byId("userEmail");
const agreeCb = byId("agree");
const errorBox = byId("errorContainer");
const errorMsg = byId("errorMessage");
const processBtn = byId("processButton");

const downloadSection = byId("downloadSection");
const downloadLink = byId("downloadLink");

// pricing summary ids (may be missing on some templates)
const basePriceId = "basePrice";
const priorityPriceId = "priorityPrice";
const transcriptPriceId = "transcriptPrice";
const taxAmountId = "taxAmount";
const totalAmountId = "totalAmount";

// progress (bottom compression bar)
const progressWrap = byId("progressWrap");      // optional wrapper
const progressBar = byId("progressBar");        // inner bar element
const progressLabel = byId("progressLabel");    // text like "Working..."

//
// ---------- state ----------
//
let SELECTED_PROVIDER = "gmail"; // default
let UPLOAD_DATA = null;          // {job_id,duration_sec,size_bytes,tier,price,max_*}
let STRIPE_REDIRECTED = false;

//
// ---------- UI helpers ----------
//
const clearError = () => safeShow("errorContainer", false);
const showError = (msg) => {
  safeHTML("errorMessage", msg);
  safeShow("errorContainer", true);
};

const setProgress = (pct, label) => {
  if (progressBar) progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (progressLabel) progressLabel.textContent = label || "";
  if (progressWrap) progressWrap.style.display = "block";
};

const resetProgress = () => {
  if (progressBar) progressBar.style.width = "0%";
  if (progressLabel) progressLabel.textContent = "";
  if (progressWrap) progressWrap.style.display = "none";
};

const kib = (bytes) => (bytes / (1024 * 1024)).toFixed(1) + " MB";
const prettyDuration = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")} min`;
};

//
// ---------- pricing ----------
//  Gmail/Outlook/Other tier bases - must match backend tiers
//
const PROVIDER_PRICING = {
  gmail:   [1.99, 2.99, 4.99],
  outlook: [2.19, 3.29, 4.99],
  other:   [2.49, 3.99, 5.49],
};
const UPS_PRIORITY = 0.75;
const UPS_TRANSCRIPT = 1.50;
const TAX_RATE = 0.10;

function currentTierBase(provider, tier) {
  const arr = PROVIDER_PRICING[provider] || PROVIDER_PRICING.gmail;
  const idx = Math.max(1, Math.min(3, Number(tier || 1))) - 1;
  return arr[idx] || arr[0];
}

function updatePriceSummary() {
  if (!UPLOAD_DATA) return;
  const tier = Number(UPLOAD_DATA.tier || 1);
  const base = currentTierBase(SELECTED_PROVIDER, tier);
  const pri  = priorityCb && priorityCb.checked ? UPS_PRIORITY : 0;
  const tra  = transcriptCb && transcriptCb.checked ? UPS_TRANSCRIPT : 0;
  const subtotal = base + pri + tra;
  const tax = subtotal * TAX_RATE;
  const total = subtotal + tax;

  safeText(basePriceId,        currency(base));
  safeText(priorityPriceId,    currency(pri));
  safeText(transcriptPriceId,  currency(tra));
  safeText(taxAmountId,        currency(tax));
  safeText(totalAmountId,      currency(total));
}

//
// ---------- upload flow ----------
//
async function doUpload(file) {
  clearError();
  resetProgress();
  setProgress(2, "Uploading...");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/upload", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    const data = await r.json();
    UPLOAD_DATA = data;

    // file row
    if (fileNameEl) fileNameEl.textContent = file.name || "video";
    if (fileSizeEl) fileSizeEl.textContent = kib(data.size_bytes);
    if (fileDurationEl) fileDurationEl.textContent = prettyDuration(data.duration_sec);
    if (fileInfo) fileInfo.style.display = "flex";

    updatePriceSummary();
    setProgress(5, "Ready for payment");
  } catch (err) {
    console.error(err);
    showError("Upload failed");
    resetProgress();
    UPLOAD_DATA = null;
  }
}

function hookUploadUI() {
  if (uploadArea && fileInput) {
    uploadArea.addEventListener("click", () => fileInput.click());
    uploadArea.addEventListener("dragover", (e) => {
      e.preventDefault();
      uploadArea.classList.add("dragover");
    });
    uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
    uploadArea.addEventListener("drop", (e) => {
      e.preventDefault();
      uploadArea.classList.remove("dragover");
      const f = e.dataTransfer?.files?.[0];
      if (f) doUpload(f);
    });
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0];
      if (f) doUpload(f);
    });
  }

  if (removeFileBtn && fileInfo) {
    removeFileBtn.addEventListener("click", () => {
      UPLOAD_DATA = null;
      if (fileInput) fileInput.value = "";
      fileInfo.style.display = "none";
      resetProgress();
      updatePriceSummary();
    });
  }
}

//
// ---------- provider & extras ----------
//
function hookProviderCards() {
  providerCards.forEach((card) => {
    card.addEventListener("click", () => {
      SELECTED_PROVIDER = (card.dataset.provider || "gmail").toLowerCase();
      toggleClass(providerCards, "selected", card);
      updatePriceSummary();
    });
  });
}

function hookExtras() {
  if (priorityCb) priorityCb.addEventListener("change", updatePriceSummary);
  if (transcriptCb) transcriptCb.addEventListener("change", updatePriceSummary);
}

//
// ---------- Stripe checkout ----------
//
async function startCheckout() {
  clearError();
  if (!UPLOAD_DATA || !UPLOAD_DATA.job_id) {
    showError("Please upload a video first.");
    return;
  }
  if (!agreeCb || !agreeCb.checked) {
    showError("Please accept the Terms & Conditions.");
    return;
  }
  setProgress(8, "Redirecting to payment…");

  try {
    const fd = new FormData();
    fd.append("job_id", UPLOAD_DATA.job_id);
    fd.append("provider", SELECTED_PROVIDER);
    fd.append("priority", String(!!(priorityCb && priorityCb.checked)));
    fd.append("transcript", String(!!(transcriptCb && transcriptCb.checked)));
    if (emailInput && emailInput.value) fd.append("email", emailInput.value.trim());

    const r = await fetch("/checkout", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`Checkout failed (${r.status})`);
    const data = await r.json();
    STRIPE_REDIRECTED = true;
    // Full-page redirect is important so the webhook → success roundtrip resets the page state
    window.location.href = data.checkout_url;
  } catch (err) {
    console.error(err);
    showError("Could not start payment.");
    setProgress(0, "");
  }
}

function hookCheckout() {
  if (!processBtn) return;
  processBtn.addEventListener("click", (e) => {
    e.preventDefault();
    startCheckout();
  });
}

//
// ---------- SSE progress after returning from Stripe ----------
//
function getQueryParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function beginSSE(jobId) {
  if (!jobId) return;
  setProgress(2, "Working…");

  // Fail closed if the server is briefly restarting (502 on SSE)
  const es = new EventSource(`/events/${jobId}`);
  let lastTick = Date.now();

  es.onmessage = (evt) => {
    lastTick = Date.now();
    try {
      const msg = JSON.parse(evt.data || "{}");
      if (msg.status === "queued" || msg.status === "processing") {
        setProgress(10, "Processing…");
      } else if (msg.status === "compressing") {
        setProgress(60, "Compressing…");
      } else if (msg.status === "finalizing") {
        setProgress(85, "Finalizing…");
      } else if (msg.status === "done") {
        setProgress(100, "Done");
        if (downloadSection && downloadLink && msg.download_url) {
          downloadLink.href = msg.download_url;
          downloadSection.style.display = "block";
        }
        es.close();
      } else if (msg.status === "error") {
        showError("An error occurred during processing.");
        setProgress(0, "");
        es.close();
      }
    } catch (e) {
      console.warn("Bad SSE payload", e);
    }
  };

  es.onerror = () => {
    // If no tick for a while, show soft warning; EventSource will retry itself.
    const age = Date.now() - lastTick;
    if (age > 15000) setProgress(3, "Reconnecting…");
  };
}

//
// ---------- init ----------
//
function init() {
  hookUploadUI();
  hookProviderCards();
  hookExtras();
  hookCheckout();

  // Refresh pricing at boot (no crashes if row is missing)
  updatePriceSummary();

  // If we came back from Stripe, start SSE for that job_id
  const paid = getQueryParam("paid");
  const jobId = getQueryParam("job_id");
  if (paid === "1" && jobId) {
    beginSSE(jobId);
  }
}

// Kick off after DOM is ready
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
