/* app/static/script.js */
/* MailSized script • v6.3 (size-tier pricing + upload progress + on-page download) */

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ---------- formatters ---------- */
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

/* ---------- state ---------- */
const state = {
  file: null,
  uploadId: null,
  durationSec: 0,
  sizeBytes: 0,
  provider: "gmail",
  tier: 1, // 1: ≤500MB, 2: ≤1GB, 3: ≤2GB
  prices: {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  },
  upsell: { priority: 0.75, transcript: 1.50 },
};

/* ---------- pricing (by size) ---------- */
const MB = 1024 * 1024;
function tierFromSize(sizeBytes) {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) return 1;
  if (sizeBytes <= 500 * MB) return 1;   // ≤500MB
  if (sizeBytes <= 1024 * MB) return 2;  // ≤1GB
  return 3;                              // ≤2GB
}

function calcTotals() {
  const baseEl = $("basePrice");
  const priorityEl = $("priorityPrice");
  const transcriptEl = $("transcriptPrice");
  const taxEl = $("taxAmount");
  const totalEl = $("totalAmount");

  const provider = state.provider || "gmail";
  const prices = state.prices[provider] || state.prices.gmail;

  // if we don't have size yet (pre-upload), default to Tier 1 for display
  const tier = state.uploadId ? tierFromSize(state.sizeBytes) : 1;
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
}

/* ---------- upload UI ---------- */
function wireUpload() {
  const uploadArea = $("uploadArea");
  const fileInput  = $("fileInput");
  const fileInfo   = $("fileInfo");
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
    $("uploadProgress")?.style && ( $("uploadProgress").style.display = "none" );
    setStep(0);
    calcTotals();
  });
}

/* xhr upload with progress % */
function uploadWithProgress(file, emailVal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload");

    xhr.onload = () => {
      try {
        const json = JSON.parse(xhr.responseText || "{}");
        resolve({ ok: xhr.status >= 200 && xhr.status < 300, data: json, raw: xhr.responseText });
      } catch {
        reject(new Error("Unexpected response from server (not JSON)."));
      }
    };
    xhr.onerror = () => reject(new Error("Upload failed. Network error."));
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = Math.max(0, Math.min(100, Math.round((e.loaded / e.total) * 100)));
      const bar = $("uploadProgress");
      const fill = $("uploadProgressFill");
      const label = $("uploadProgressPct");
      if (bar) bar.style.display = "";
      if (fill) fill.style.width = `${pct}%`;
      if (label) label.textContent = `${pct}%`;
    };

    const fd = new FormData();
    fd.append("file", file);
    if (emailVal) fd.append("email", emailVal);
    xhr.send(fd);
  });
}

async function handleFile(file) {
  state.file = file;
  setTextSafe($("fileName"), file.name);
  setTextSafe($("fileSize"), fmtBytes(file.size));
  setTextSafe($("fileDuration"), "probing…");
  $("fileInfo") && ( $("fileInfo").style.display = "" );

  // Reset/Show upload progress
  const upBar = $("uploadProgress");
  if (upBar) {
    upBar.style.display = "";
    $("uploadProgressFill").style.width = "0%";
    $("uploadProgressPct").textContent = "0%";
  }

  // Upload
  const emailVal = $("userEmail")?.value?.trim();
  let res;
  try {
    res = await uploadWithProgress(file, emailVal);
  } catch (err) {
    return showError(err.message || "Upload failed. Check your network.");
  }

  if (!res.ok || !res.data?.ok) {
    const t = (res && (res.raw || "")) || "";
    return showError(`Upload failed${t ? `: ${t}` : ""}`);
  }

  const data = res.data;
  state.uploadId    = data.upload_id;
  state.durationSec = Number(data.duration_sec || 0);
  state.sizeBytes   = Number(data.size_bytes || 0);

  setTextSafe($("fileDuration"), fmtDuration(state.durationSec));
  // keep upload progress bar visible at 100% for a beat, then hide
  setTimeout(() => { $("uploadProgress") && ( $("uploadProgress").style.display = "none" ); }, 600);

  setStep(1);         // move to Payment
  calcTotals();       // now tier reflects size
}

/* ---------- provider & extras ---------- */
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

/* ---------- pay & compress ---------- */
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
      // (Optional) you can send price_cents if you compute on client; server can ignore
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
    window.location.href = url; // go to Stripe
  });
}

/* ---------- post‑payment progress ---------- */
function resumeIfPaid() {
  const root = $("pageRoot");
  const fromDataset = {
    paid:  root?.getAttribute("data-paid") === "1",
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

function startSSE(jobId) {
  const pctEl = $("progressPct");
  const fillEl = $("progressFill");
  const noteEl = $("progressNote");
  const dlSection = $("downloadSection");
  const dlLink = $("downloadLink");
  const dlMsg = $("downloadEmailNote");

  try {
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);
    es.onmessage = (evt) => {
      let data = {};
      try { data = JSON.parse(evt.data || "{}"); } catch {}

      const p = Number(data.progress || 0);
      setTextSafe(pctEl, `${Math.floor(p)}%`);
      if (fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      setTextSafe(noteEl, data.message || "Working…");

      if (data.status === "done") {
        es.close();

        // Prefer server-pushed URL immediately
        const href = data.download_url;
        if (href && dlLink) {
          dlLink.href = href;
          if (dlSection) dlSection.style.display = "";
          setStep(3);
          setTextSafe(noteEl, "Complete");
          if (dlMsg) dlMsg.style.display = ""; // “We’ve also emailed…” message
        } else {
          // fallback (shouldn’t hit if server pushes download_url)
          fetch(`/download/${encodeURIComponent(jobId)}`)
            .then((r) => r.json())
            .then((j) => {
              if (j?.url && dlLink) {
                dlLink.href = j.url;
                if (dlSection) dlSection.style.display = "";
                setStep(3);
                setTextSafe(noteEl, "Complete");
                if (dlMsg) dlMsg.style.display = "";
              }
            }).catch(() => {});
        }
      } else if (data.status === "error") {
        es.close();
        showError(data.message || "Compression failed.");
        setTextSafe(noteEl, "Error");
      }
    };
    es.onerror = () => { /* keep connection alive; server heartbeats */ };
  } catch {/* noop */}
}

/* ---------- error UI ---------- */
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

/* ---------- boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  wireUpload();
  wireProviders();
  wireCheckout();
  calcTotals();
  resumeIfPaid();
});
