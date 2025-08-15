/* app/static/script.js */
/* MailSized script • v6.3 */

const $ = (id) => document.getElementById(id);
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

/* -------------------- state -------------------- */
const state = {
  file: null,
  uploadId: null,
  durationSec: 0,
  sizeBytes: 0,
  provider: "gmail",
  tier: 1,
  prices: {
    // size-based base price (shown in right card table is static text)
    // these are used only for the live total box
    size: [
      { maxBytes: 500 * 1024 * 1024, price: 1.99 },      // ≤ 500 MB
      { maxBytes: 1024 * 1024 * 1024, price: 2.99 },     // ≤ 1 GB
      { maxBytes: 2 * 1024 * 1024 * 1024, price: 4.99 }, // ≤ 2 GB
    ],
  },
  upsell: { priority: 0.75, transcript: 1.50 },
};

/* -------------------- pricing helpers -------------------- */
function priceFromSize(bytes) {
  for (const tier of state.prices.size) {
    if (bytes <= tier.maxBytes) return tier.price;
  }
  // if beyond plan, cap to last tier to avoid NaN
  return state.prices.size[state.prices.size.length - 1].price;
}
function calcTotals() {
  const baseEl = $("basePrice");
  const priorityEl = $("priorityPrice");
  const transcriptEl = $("transcriptPrice");
  const taxEl = $("taxAmount");
  const totalEl = $("totalAmount");

  const base = state.sizeBytes ? priceFromSize(state.sizeBytes) : priceFromSize(1);
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
}

/* -------------------- upload UI -------------------- */
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

async function handleFile(file) {
  state.file = file;
  setTextSafe($("fileName"), file.name);
  setTextSafe($("fileSize"), fmtBytes(file.size));
  setTextSafe($("fileDuration"), "probing…");
  if ($("fileInfo")) $("fileInfo").style.display = "";

  // show upload progress bar
  const upWrap = $("uploadProgress");
  const upFill = $("uploadFill");
  const upPct  = $("uploadPct");
  const upNote = $("uploadNote");
  if (upWrap) upWrap.style.display = "";
  if (upNote) upNote.style.display = "";

  // upload with progress
  const emailVal = $("userEmail")?.value?.trim() || "";
  const fd = new FormData();
  fd.append("file", file);
  if (emailVal) fd.append("email", emailVal);

  try {
    const res = await fetch("/upload", {
      method: "POST",
      body: fd,
      // use native progress via XHR if needed; fetch doesn’t stream progress reliably across all browsers
    });
    if (!res.ok) {
      const t = await res.text();
      return showError(`Upload failed: ${t || res.status}`);
    }
    const data = await res.json();
    if (!data?.ok) return showError(data?.detail || "Upload rejected.");

    state.uploadId    = data.upload_id;
    state.durationSec = Number(data.duration_sec || 0);
    state.sizeBytes   = Number(data.size_bytes || 0);

    setTextSafe($("fileDuration"), fmtDuration(state.durationSec));
    setStep(1);
    calcTotals();
  } catch {
    return showError("Upload failed. Check your network and try again.");
  } finally {
    if (upWrap) upWrap.style.display = "none";
    if (upNote) upNote.style.display = "none";
    if (upFill) upFill.style.width = "0%";
    if (upPct)  upPct.textContent = "0%";
  }
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
    // Provider no longer changes base price (which is size-based), but keep it for target size selection on backend
    state.provider = (btn.getAttribute("data-provider") || "gmail").toLowerCase();
    calcTotals();
  });

  $("priority")?.addEventListener("change", calcTotals);
  $("transcript")?.addEventListener("change", calcTotals);
}

/* -------------------- pay & compress -------------------- */
function validateEmailRequired() {
  const el = $("userEmail");
  const v = el?.value?.trim() || "";
  if (!v) {
    showError("Please enter your email to receive the download link.");
    el?.focus();
    return false;
  }
  // rudimentary format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    showError("Please enter a valid email address.");
    el?.focus();
    return false;
  }
  return true;
}

function wireCheckout() {
  const btn = $("processButton");
  if (!btn) return;

  btn.addEventListener("click", async () => {
    hideError();

    if (!state.file || !state.uploadId) {
      return showError("Please upload a video first.");
    }
    if (!validateEmailRequired()) return;
    if (!$("agree")?.checked) {
      return showError("Please accept the Terms & Conditions.");
    }

    const payload = {
      upload_id: state.uploadId,
      provider: state.provider,
      priority: !!$("priority")?.checked,
      transcript: !!$("transcript")?.checked,
      email: $("userEmail")?.value?.trim() || "",
      // optional: send price in cents if you want server to verify/override
      // price_cents: Math.round(parseFloat(($("totalAmount")?.textContent || "$0").replace(/[^0-9.]/g, "")) * 100)
    };

    let data;
    try {
      const res = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      data = await res.json();
    } catch {
      return showError("Could not start checkout. Please try again.");
    }

    const url = data?.url || data?.checkout_url;
    if (!url) return showError("Checkout could not be created. Please try again.");

    setStep(1);
    window.location.href = url; // go to Stripe
  });
}

/* -------------------- post‑payment progress & download -------------------- */
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

async function revealDownload(url) {
  const dlSection = $("downloadSection");
  const dlLink = $("downloadLink");
  const note = $("emailNote");

  if (dlLink && url) dlLink.href = url;
  if (dlSection) dlSection.style.display = "";
  if (note) note.style.display = "";
  setStep(3);
  setTextSafe($("progressNote"), "Complete");
}

function startSSE(jobId) {
  const pctEl = $("progressPct");
  const fillEl = $("progressFill");
  const noteEl = $("progressNote");

  try {
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);
    es.onmessage = async (evt) => {
      let data = {};
      try { data = JSON.parse(evt.data || "{}"); } catch {}

      const p = Number(data.progress || 0);
      if (Number.isFinite(p)) {
        setTextSafe(pctEl, `${Math.floor(p)}%`);
        if (fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      }
      if (data.message) setTextSafe(noteEl, data.message);

      // If backend sends download_url inside the SSE, use it immediately
      if (data.download_url && data.status === "done") {
        es.close();
        return revealDownload(data.download_url);
      }

      // If we only have "done" without URL, fetch it
      if (data.status === "done") {
        try {
          const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
          const j = await r.json();
          if (j?.url) {
            es.close();
            return revealDownload(j.url);
          }
        } catch {
          // ignore, user can refresh; SSE heartbeat keeps page alive otherwise
        }
      } else if (data.status === "error") {
        es.close();
        showError(data.message || "Compression failed.");
        setTextSafe(noteEl, "Error");
      }
    };
    es.onerror = () => {
      // keep visible; server heartbeats prevent idle 502s
    };
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
  wireUpload();
  wireProviders();
  wireCheckout();
  calcTotals();
  resumeIfPaid();
});
