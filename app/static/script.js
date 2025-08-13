/* MailSized script — v7.1 null-safe patch */
console.log("MailSized script version: v7.1-nullsafe");

// ---------- tiny helpers ----------
const $ = (id) => document.getElementById(id) || null;
const setText = (elOrId, text) => {
  const el = typeof elOrId === "string" ? $(elOrId) : elOrId;
  if (el) el.textContent = text;
};
const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? "" : "none"; };

// currency
const money = (n) => `$${Number(n || 0).toFixed(2)}`;

// ---------- elements (may be null) ----------
const uploadArea = $("uploadArea");
const fileInput = $("fileInput");
const fileInfo = $("fileInfo");
const fileNameEl = $("fileName");
const fileSizeEl = $("fileSize");
const fileDurationEl = $("fileDuration");
const removeFile = $("removeFile");

const priorityCb = $("priority");
const transcriptCb = $("transcript");
const emailInput = $("userEmail");
const agreeCb = $("agree");
const processBtn = $("processButton");

const errorBox = $("errorContainer");
const errorMsg = $("errorMessage");
const downloadSection = $("downloadSection");
const downloadLink = $("downloadLink");

const progressWrap = $("progressWrap");
const progressBar = $("progressBar");
const progressLabel = $("progressLabel");

const providerCards = Array.from(document.querySelectorAll(".provider-card")) || [];

// ---------- pricing tables ----------
const PROVIDER_PRICING = {
  gmail:   [1.99, 2.99, 4.99],
  outlook: [2.19, 3.29, 4.99],
  other:   [2.49, 3.99, 5.49],
};
const UPS_PRIORITY = 0.75;
const UPS_TRANSCRIPT = 1.50;
const TAX_RATE = 0.10;

// ---------- state ----------
let SELECTED_PROVIDER = "gmail";
let UPLOAD_DATA = null;

// ---------- ui helpers ----------
const showError = (msg) => { setText(errorMsg, msg); show("errorContainer", true); };
const clearError = () => show("errorContainer", false);

const setProgress = (pct, label) => {
  if (progressWrap) progressWrap.style.display = "block";
  if (progressBar)  progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  if (progressLabel) setText(progressLabel, label || "");
};
const resetProgress = () => { if (progressWrap) progressWrap.style.display = "none"; setProgress(0, ""); };

const kib = (b) => (b / (1024 * 1024)).toFixed(1) + " MB";
const prettyDur = (sec) => {
  sec = Math.max(0, Math.round(sec || 0));
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")} min`;
};

// ---------- pricing ----------
const tierBase = (provider, tier) => {
  const arr = PROVIDER_PRICING[provider] || PROVIDER_PRICING.gmail;
  const idx = Math.max(1, Math.min(3, Number(tier || 1))) - 1;
  return arr[idx] || arr[0];
};

function calcTotals() {
  if (!UPLOAD_DATA) {
    setText("basePrice", "$0.00");
    setText("priorityPrice", "$0.00");
    setText("transcriptPrice", "$0.00");
    setText("taxAmount", "$0.00");
    setText("totalAmount", "$0.00");
    return;
  }
  const tier = Number(UPLOAD_DATA.tier || 1);
  const base = tierBase(SELECTED_PROVIDER, tier);
  const pri  = priorityCb && priorityCb.checked ? UPS_PRIORITY : 0;
  const tra  = transcriptCb && transcriptCb.checked ? UPS_TRANSCRIPT : 0;
  const subtotal = base + pri + tra;
  const tax  = subtotal * TAX_RATE;
  const total = subtotal + tax;

  setText("basePrice",       money(base));
  setText("priorityPrice",   money(pri));
  setText("transcriptPrice", money(tra));   // <- null-safe now
  setText("taxAmount",       money(tax));
  setText("totalAmount",     money(total));
}

// ---------- upload ----------
async function doUpload(file) {
  clearError();
  resetProgress();
  setProgress(2, "Uploading…");
  try {
    const fd = new FormData();
    fd.append("file", file);
    const r = await fetch("/upload", { method: "POST", body: fd });
    if (!r.ok) throw new Error(`Upload failed (${r.status})`);
    const data = await r.json();

    UPLOAD_DATA = data;
    if (fileInfo) fileInfo.style.display = "flex";
    setText(fileNameEl, file.name || "video");
    setText(fileSizeEl, kib(data.size_bytes));
    setText(fileDurationEl, prettyDur(data.duration_sec));

    calcTotals();
    setProgress(5, "Ready for payment");
  } catch (err) {
    console.error(err);
    showError("Upload failed");
    UPLOAD_DATA = null;
    resetProgress();
  }
}

function setupUpload() {
  if (uploadArea && fileInput) {
    uploadArea.addEventListener("click", () => fileInput.click());
    uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("dragover"); });
    uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
    uploadArea.addEventListener("drop", (e) => {
      e.preventDefault(); uploadArea.classList.remove("dragover");
      const f = e.dataTransfer?.files?.[0]; if (f) doUpload(f);
    });
    fileInput.addEventListener("change", () => {
      const f = fileInput.files?.[0]; if (f) doUpload(f);
    });
  }
  if (removeFile && fileInfo) {
    removeFile.addEventListener("click", () => { UPLOAD_DATA = null; if (fileInput) fileInput.value = ""; fileInfo.style.display = "none"; resetProgress(); calcTotals(); });
  }
}

// ---------- provider/extras ----------
function setupProviderCards() {
  providerCards.forEach((card) => {
    card.addEventListener("click", () => {
      SELECTED_PROVIDER = (card.dataset.provider || "gmail").toLowerCase();
      providerCards.forEach((c) => c.classList.toggle("selected", c === card));
      calcTotals();
    });
  });
}
function setupExtras() {
  if (priorityCb)  priorityCb.addEventListener("change", calcTotals);
  if (transcriptCb) transcriptCb.addEventListener("change", calcTotals);
}

// ---------- checkout ----------
async function startCheckout() {
  clearError();
  if (!UPLOAD_DATA || !UPLOAD_DATA.job_id) { showError("Please upload a video first."); return; }
  if (!agreeCb || !agreeCb.checked)         { showError("Please accept the Terms & Conditions."); return; }

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
    window.location.href = data.checkout_url; // full redirect
  } catch (err) {
    console.error(err);
    showError("Could not start payment.");
    resetProgress();
  }
}
function setupCheckout() {
  if (processBtn) processBtn.addEventListener("click", (e) => { e.preventDefault(); startCheckout(); });
}

// ---------- progress (SSE) ----------
function qp(name) { return new URL(window.location.href).searchParams.get(name); }

function beginSSE(jobId) {
  if (!jobId) return;
  setProgress(2, "Working…");
  const es = new EventSource(`/events/${jobId}`);
  es.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data || "{}");
      if (msg.status === "queued" || msg.status === "processing") setProgress(10, "Processing…");
      else if (msg.status === "compressing") setProgress(60, "Compressing…");
      else if (msg.status === "finalizing") setProgress(85, "Finalizing…");
      else if (msg.status === "done") {
        setProgress(100, "Done");
        if (downloadSection && downloadLink && msg.download_url) {
          downloadLink.href = msg.download_url;
          downloadSection.style.display = "block";
        }
        es.close();
      } else if (msg.status === "error") {
        showError("An error occurred during processing.");
        resetProgress();
        es.close();
      }
    } catch {}
  };
  es.onerror = () => setProgress(3, "Reconnecting…");
}

// ---------- init ----------
function init() {
  setupUpload();
  setupProviderCards();
  setupExtras();
  setupCheckout();
  calcTotals();

  const paid = qp("paid"), jobId = qp("job_id");
  if (paid === "1" && jobId) beginSSE(jobId);
}
(document.readyState === "loading") ? document.addEventListener("DOMContentLoaded", init) : init();
