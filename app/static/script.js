/* app/static/script.js */
/* MailSized script • v6.5 (targeted fixes) */

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtBytes(n) {
  if (!Number.isFinite(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
function fmtDuration(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return "0:00 min";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")} min`;
}
function setTextSafe(el, text) { if (el) el.textContent = text; }
function setStep(activeIndex) {
  const steps = [$("step1"), $("step2"), $("step3"), $("step4")].filter(Boolean);
  steps.forEach((node, i) => node.classList.toggle("active", i <= activeIndex));
}

/* -------------------- pricing mode -------------------- */
/* Combined = whichever tier is higher: duration-based OR size-based.
   If you want size-only, set PRICING_MODE = "SIZE_ONLY". */
const PRICING_MODE = "COMBINED";

/* -------------------- state -------------------- */
const state = {
  file: null,
  uploadId: null,
  durationSec: 0,
  sizeBytes: 0,
  provider: "gmail",
  tier: 1,
  prices: {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  },
  upsell: { priority: 0.75, transcript: 1.50 },
};

const MB = 1024 * 1024;

/* -------------------- tiering helpers -------------------- */
function tierFromDuration(sec) {
  const min = Number(sec) / 60;
  if (min <= 5) return 1;
  if (min <= 10) return 2;
  return 3;
}
function tierFromSize(bytes) {
  if (bytes <= 500 * MB) return 1;
  if (bytes <= 1024 * MB) return 2;
  return 3; // up to 2 GB (backend enforces)
}
function chooseTier(sec, bytes) {
  if (PRICING_MODE === "SIZE_ONLY")    return tierFromSize(bytes);
  if (PRICING_MODE === "DURATION_ONLY") return tierFromDuration(sec);
  // Combined = max(size, duration)
  return Math.max(tierFromDuration(sec), tierFromSize(bytes));
}

/* -------------------- pricing -------------------- */
function calcTotals() {
  const baseEl = $("basePrice");
  const priorityEl = $("priorityPrice");
  const transcriptEl = $("transcriptPrice");
  const taxEl = $("taxAmount");
  const totalEl = $("totalAmount");

  const provider = state.provider || "gmail";
  const prices = state.prices[provider] || state.prices.gmail;

  const tier = state.uploadId ? chooseTier(state.durationSec, state.sizeBytes) : 1;
  state.tier = tier;

  const base = Number(prices[tier - 1] ?? 0);
  const pri  = $("priority")?.checked ? state.upsell.priority : 0;
  const tra  = $("transcript")?.checked ? state.upsell.transcript : 0;

  const subtotal = Number(base) + Number(pri) + Number(tra);
  const tax = subtotal * 0.10;
  const total = subtotal + tax;

  setTextSafe(baseEl,       `$${base.toFixed(2)}`);
  setTextSafe(priorityEl,   `$${Number(pri).toFixed(2)}`);
  setTextSafe(transcriptEl, `$${Number(tra).toFixed(2)}`);
  setTextSafe(taxEl,        `$${tax.toFixed(2)}`);
  setTextSafe(totalEl,      `$${total.toFixed(2)}`);

  // Optional: show a tiny hint of WHY a tier was chosen
  const hint = qs("[data-price-hint]");
  if (hint && state.uploadId) {
    const mins = Math.round((state.durationSec || 0) / 60);
    const mb   = Math.round((state.sizeBytes || 0) / MB);
    hint.textContent = `Tier ${tier} based on ~${mins} min & ${mb} MB`;
  }
}

/* -------------------- upload progress UI -------------------- */
function ensureUploadProgressUI() {
  let wrap = $("uploadProgress");
  if (!wrap) {
    const area = $("uploadArea");
    if (!area) return;
    wrap = document.createElement("div");
    wrap.id = "uploadProgress";
    wrap.className = "progress-wrapper";
    wrap.style.display = "none";
    wrap.innerHTML = `
      <div class="progress-header"><span>Uploading…</span><span id="uploadProgressPct">0%</span></div>
      <div class="progress-track"><div class="progress-fill" id="uploadProgressFill" style="width:0%"></div></div>
    `;
    area.appendChild(wrap);
  }
}
function showUploadProgress(pct) {
  ensureUploadProgressUI();
  const wrap = $("uploadProgress");
  const pctEl = $("uploadProgressPct");
  const fillEl = $("uploadProgressFill");
  if (wrap) wrap.style.display = "";
  if (pctEl) pctEl.textContent = `${Math.floor(pct)}%`;
  if (fillEl) fillEl.style.width = `${Math.floor(pct)}%`;
}
function hideUploadProgress() {
  const wrap = $("uploadProgress");
  if (wrap) wrap.style.display = "none";
}

/* -------------------- upload + UI -------------------- */
function wireUpload() {
  const uploadArea = $("uploadArea");
  const fileInput = $("fileInput");
  const fileInfo = $("fileInfo");
  if (!uploadArea || !fileInput) return;

  const openPicker = () => fileInput.click();
  ["click", "keypress"].forEach((evt) => {
    uploadArea.addEventListener(evt, (e) => {
      if (e.type === "keypress" && e.key !== "Enter" && e.key !== " ") return;
      openPicker();
    });
  });

  uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); uploadArea.classList.add("dragover"); });
  uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    if (e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", () => { if (fileInput.files?.[0]) handleFile(fileInput.files[0]); });

  $("removeFile")?.addEventListener("click", () => {
    state.file = null;
    state.uploadId = null;
    fileInput.value = "";
    if (fileInfo) fileInfo.style.display = "none";
    setStep(0);
    calcTotals();
  });
}

// use XHR for upload progress
function uploadWithProgress(fd) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");
    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        showUploadProgress((evt.loaded / evt.total) * 100);
      }
    };
    xhr.onload = () => {
      hideUploadProgress();
      if (xhr.status >= 200 && xhr.status < 300) {
        try { resolve(JSON.parse(xhr.responseText)); }
        catch { reject("Unexpected response from server (not JSON)."); }
      } else {
        reject(xhr.responseText || `Upload failed (${xhr.status})`);
      }
    };
    xhr.onerror = () => { hideUploadProgress(); reject("Network error during upload."); };
    xhr.send(fd);
  });
}

async function handleFile(file) {
  state.file = file;
  setTextSafe($("fileName"), file.name);
  setTextSafe($("fileSize"), fmtBytes(file.size));      // show size immediately
  setTextSafe($("fileDuration"), "probing…");
  if ($("fileInfo")) $("fileInfo").style.display = "";

  const fd = new FormData();
  fd.append("file", file);
  const emailVal = $("userEmail")?.value?.trim();
  if (emailVal) fd.append("email", emailVal);

  let data;
  try {
    data = await uploadWithProgress(fd);
  } catch (err) {
    return showError(typeof err === "string" ? err : "Upload failed. Please try again.");
  }
  if (!data?.ok) return showError(data?.detail || "Upload rejected.");

  state.uploadId    = data.upload_id;
  state.durationSec = Number(data.duration_sec || 0);
  state.sizeBytes   = Number(data.size_bytes || 0);

  setTextSafe($("fileDuration"), fmtDuration(state.durationSec));   // now we know the real duration
  setTextSafe($("fileSize"), fmtBytes(state.sizeBytes));            // stay consistent with server

  setStep(1); // move to Payment
  calcTotals();
}

/* -------------------- provider & extras -------------------- */
function wireProviders() {
  const list = $("providerList") || qs(".providers");
  if (!list) return;

  list.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-provider]");
    if (!btn) return;
    qsa("[data-provider]", list).forEach((n) => n.classList.remove("selected"));
    btn.classList.add("selected");
    state.provider = (btn.getAttribute("data-provider") || "gmail").toLowerCase();
    calcTotals();
  });

  $("priority")?.addEventListener("change", calcTotals);
  $("transcript")?.addEventListener("change", calcTotals);
}

/* -------------------- pay & compress -------------------- */
function wireCheckout() {
  const btn = $("processButton");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    hideError();

    if (!state.file || !state.uploadId) {
      return showError("Please upload a video first.");
    }
    if (!$("agree")?.checked) {
      return showError("Please accept the Terms & Conditions.");
    }

    const payload = {
      upload_id: state.uploadId,
      provider: state.provider,
      priority: !!$("priority")?.checked,
      transcript: !!$("transcript")?.checked,
      email: $("userEmail")?.value?.trim() || "",
      // optional: you can send price_cents from client if you want server to pick it up
    };

    let res;
    try {
      res = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      return showError("Could not start checkout. Please try again.");
    }

    let data;
    try { data = await res.json(); } catch { return showError("Unexpected server response (not JSON)."); }
    const url = data?.url || data?.checkout_url;
    if (!url) return showError("Checkout could not be created. Please try again.");

    setStep(1);
    window.location.href = url; // to Stripe
  });
}

/* -------------------- post‑payment progress + download -------------------- */
function resumeIfPaid() {
  const root = $("pageRoot");
  const fromDataset = {
    paid: root?.getAttribute("data-paid") === "1",
    jobId: root?.getAttribute("data-job-id") || "",
  };

  const url = new URL(window.location.href);
  const paid = url.searchParams.get("paid") === "1" || fromDataset.paid;
  const jobId = url.searchParams.get("job_id") || fromDataset.jobId;
  if (!paid || !jobId) return;

  const post = $("postPaySection");
  if (post) post.style.display = "";
  setStep(2);
  startSSE(jobId);
}

let pollTimer = null;
function startPollingDownload(jobId) {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
      if (r.ok) {
        const j = await r.json();
        if (j?.url) {
          clearInterval(pollTimer); pollTimer = null;
          showDownloadUI(j.url);
        }
      }
    } catch { /* ignore */ }
  }, 3000);
}

function showDownloadUI(url) {
  const dlSection = $("downloadSection");
  const dlLink = $("downloadLink");
  const noteEl = $("progressNote");
  const noteP = qs("#downloadSection p");
  if (dlLink && url) {
    dlLink.href = url;
    dlLink.removeAttribute("disabled");
  }
  if (dlSection) dlSection.style.display = "";
  setStep(3);
  setTextSafe(noteEl, "Complete");
  if (noteP) noteP.textContent = "We’ve also emailed your download link. The link expires in ~24 hours.";
}

function startSSE(jobId) {
  const pctEl = $("progressPct");
  const fillEl = $("progressFill");
  const noteEl = $("progressNote");

  try {
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);

    es.onopen = () => {
      startPollingDownload(jobId); // safety net in parallel
    };

    es.onmessage = async (evt) => {
      let data = {};
      try { data = JSON.parse(evt.data || "{}"); } catch {}

      const p = Number(data.progress || 0);
      setTextSafe(pctEl, `${Math.floor(p)}%`);
      if (fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      setTextSafe(noteEl, data.message || "Working…");

      if (data.status === "done") {
        es.close();
        clearInterval(pollTimer); pollTimer = null;

        // Prefer SSE-provided URL; fallback to GET /download
        let url = data.download_url;
        if (!url) {
          try {
            const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
            const j = await r.json();
            url = j?.url || "";
          } catch {}
        }
        if (url) showDownloadUI(url);
        else showError("Finished, but the download link was not found. Please refresh.");
      } else if (data.status === "error") {
        es.close();
        clearInterval(pollTimer); pollTimer = null;
        showError(data.message || "Compression failed.");
        setTextSafe(noteEl, "Error");
      }
    };

    es.onerror = () => { /* keep UI; poller runs */ };
  } catch { /* noop */ }
}

/* -------------------- error UI -------------------- */
function showError(msg) {
  const box = $("errorContainer");
  const msgEl = $("errorMessage");
  if (msgEl) msgEl.textContent = String(msg || "Something went wrong.");
  if (box) box.style.display = "";
}
function hideError() { const box = $("errorContainer"); if (box) box.style.display = "none"; }

/* -------------------- boot -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  ensureUploadProgressUI();
  wireUpload();
  wireProviders();
  wireCheckout();
  calcTotals();
  resumeIfPaid();
});
