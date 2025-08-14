/* app/static/script.js */

/* -------------------- helpers -------------------- */
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

function setTextSafe(el, text) {
  if (el) el.textContent = text;
}

function setStep(activeIndex) {
  const steps = [$("step1"), $("step2"), $("step3"), $("step4")].filter(Boolean);
  steps.forEach((node, i) => {
    if (!node) return;
    node.classList.toggle("active", i <= activeIndex);
  });
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
    gmail: [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other: [2.49, 3.99, 5.49],
  },
  upsell: { priority: 0.75, transcript: 1.5 },
};

/* -------------------- pricing -------------------- */
function tierFromDuration(sec) {
  if (!Number.isFinite(sec)) return 1;
  const min = sec / 60;
  if (min <= 5) return 1;
  if (min <= 10) return 2;
  return 3; // up to 20 via backend limits
}

function calcTotals() {
  const baseEl = $("basePrice");
  const priorityEl = $("priorityPrice");
  const transcriptEl = $("transcriptPrice");
  const taxEl = $("taxAmount");
  const totalEl = $("totalAmount");

  const provider = state.provider || "gmail";
  const prices = state.prices[provider] || state.prices.gmail;

  // if we don't have a duration yet (pre-upload), assume tier 1 just for display
  const tier = state.uploadId ? tierFromDuration(state.durationSec) : 1;
  state.tier = tier;

  const base = prices[tier - 1] || 0;
  const pri = $("priority")?.checked ? state.upsell.priority : 0;
  const tra = $("transcript")?.checked ? state.upsell.transcript : 0;
  const subtotal = (base || 0) + (pri || 0) + (tra || 0);
  const tax = subtotal * 0.10;
  const total = subtotal + tax;

  // write safely (elements may be missing in some templates)
  setTextSafe(baseEl, `$${(base || 0).toFixed(2)}`);
  setTextSafe(priorityEl, `$${(pri || 0).toFixed(2)}`);
  setTextSafe(transcriptEl, `$${(tra || 0).toFixed(2)}`);
  setTextSafe(taxEl, `$${(tax || 0).toFixed(2)}`);
  setTextSafe(totalEl, `$${(total || 0).toFixed(2)}`);
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

  uploadArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    uploadArea.classList.add("dragover");
  });
  uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    if (e.dataTransfer?.files?.[0]) {
      handleFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files?.[0]) handleFile(fileInput.files[0]);
  });

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

  // show file preview/details
  setTextSafe($("fileName"), file.name);
  setTextSafe($("fileSize"), fmtBytes(file.size));
  setTextSafe($("fileDuration"), "probing…");
  if ($("fileInfo")) $("fileInfo").style.display = "";

  // upload → /upload
  const fd = new FormData();
  fd.append("file", file);
  const emailVal = $("userEmail")?.value?.trim();
  if (emailVal) fd.append("email", emailVal);

  let res;
  try {
    res = await fetch("/upload", { method: "POST", body: fd });
  } catch (e) {
    return showError("Upload failed. Check your network and try again.");
  }
  if (!res.ok) {
    const t = await res.text();
    return showError(`Upload failed: ${t || res.status}`);
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return showError("Unexpected response from server (not JSON).");
  }

  if (!data?.ok) {
    return showError(data?.detail || "Upload rejected.");
  }

  state.uploadId = data.upload_id;
  state.durationSec = Number(data.duration_sec || 0);
  state.sizeBytes = Number(data.size_bytes || 0);

  setTextSafe($("fileDuration"), fmtDuration(state.durationSec));
  setStep(1); // Upload complete, move to payment step
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
    };

    let res;
    try {
      res = await fetch("/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      return showError("Could not start checkout. Please try again.");
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return showError("Unexpected server response (not JSON).");
    }

    // If your server returns Stripe URL, go there
    if (data?.checkout_url) {
      window.location.href = data.checkout_url;
      return;
    }

    // Otherwise, show a nudge; real job will be started by Stripe webhook.
    // (On return from Stripe, we resume via ?paid=1&job_id=...)
    setStep(1);
    alert("Proceed to payment. After payment completes, you'll be redirected back here.");
  });
}

/* -------------------- post‑payment progress -------------------- */
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

  // show progress section
  const post = $("postPaySection");
  if (post) post.style.display = "";

  setStep(2); // Compression step
  startSSE(jobId);
}

function startSSE(jobId) {
  const pctEl = $("progressPct");
  const fillEl = $("progressFill");
  const noteEl = $("progressNote");
  const dlSection = $("downloadSection");
  const dlLink = $("downloadLink");

  try {
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);
    es.onmessage = async (evt) => {
      let data = {};
      try {
        data = JSON.parse(evt.data || "{}");
      } catch {
        // ignore
      }

      const p = Number(data.progress || 0);
      setTextSafe(pctEl, `${Math.floor(p)}%`);
      if (fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      setTextSafe(noteEl, data.message || "Working…");

      if (data.status === "done") {
        es.close();
        // fetch a real download URL
        try {
          const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
          const j = await r.json();
          if (j?.url && dlLink) {
            dlLink.href = j.url;
            if (dlSection) dlSection.style.display = "";
            setStep(3); // Download step
            setTextSafe(noteEl, "Complete");
          }
        } catch {
          // ignore
        }
      } else if (data.status === "error") {
        es.close();
        showError(data.message || "Compression failed.");
        setTextSafe(noteEl, "Error");
      }
    };
    es.onerror = () => {
      // keep the bar visible; SSE heartbeats keep connection alive server-side
    };
  } catch (e) {
    // ignore
  }
}

/* -------------------- error UI -------------------- */
function showError(msg) {
  const box = $("errorContainer");
  const msgEl = $("errorMessage");
  if (msgEl) msgEl.textContent = String(msg || "Something went wrong.");
  if (box) box.style.display = "";
}
function hideError() {
  const box = $("errorContainer");
  if (box) box.style.display = "none";
}

/* -------------------- boot -------------------- */
document.addEventListener("DOMContentLoaded", () => {
  wireUpload();
  wireProviders();
  wireCheckout();
  calcTotals();        // initializes the price box safely
  resumeIfPaid();      // resumes progress if we came back from Stripe
});
