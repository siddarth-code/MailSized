/*
 * MailSized front-end (minimal, robust)
 * - Upload -> /upload
 * - Price calc when switching provider / extras
 * - Stripe checkout -> redirect back with ?paid=1&job_id=...
 * - After return, connect to /events/:job for live progress and show download
 */

(function () {
  const $ = (sel) => document.querySelector(sel);
  const on = (el, evt, fn) => el && el.addEventListener(evt, fn);

  // Elements
  const uploadArea    = $("#uploadArea");
  const fileInput     = $("#fileInput");
  const fileInfo      = $("#fileInfo");
  const fileNameEl    = $("#fileName");
  const fileSizeEl    = $("#fileSize");
  const fileDuration  = $("#fileDuration");
  const removeFileBtn = $("#removeFile");

  const providerList  = $("#providerList") || document;
  const cbPriority    = $("#priority");
  const cbTranscript  = $("#transcript");
  const emailInput    = $("#userEmail");
  const agreeCB       = $("#agree");
  const processBtn    = $("#processButton");

  const errorBox      = $("#errorContainer");
  const errorMsg      = $("#errorMessage");

  // Post-pay progress UI
  const postPay       = $("#postPaySection");
  const progressFill  = $("#progressFill");
  const progressPct   = $("#progressPct");
  const progressNote  = $("#progressNote");
  const dlSection     = $("#downloadSection");
  const dlLink        = $("#downloadLink");

  // Price fields (guard for nulls)
  const baseEl        = $("#basePrice");
  const priEl         = $("#priorityPrice");
  const trEl          = $("#transcriptPrice");
  const taxEl         = $("#taxAmount");
  const totalEl       = $("#totalAmount");

  // State
  let current = null; // { job_id, size_bytes, duration_sec, tier, price }
  let provider = "gmail";

  const money = (n) => `$${n.toFixed(2)}`;
  const safeText = (node, text) => { if (node) node.textContent = text; };

  function showError(msg) {
    if (errorBox && errorMsg) {
      errorMsg.textContent = msg || "An error occurred.";
      errorBox.style.display = "block";
    }
  }
  function hideError() {
    if (errorBox) errorBox.style.display = "none";
  }

  function activeStep(i) {
    for (let s = 1; s <= 4; s++) {
      const el = document.getElementById(`step${s}`);
      if (el) el.classList.toggle("active", s === i);
    }
  }

  // ---- Pricing ----

  // Mirrors backend PROVIDER_PRICING
  const PRICES = {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };

  function tierIndex() {
    if (!current) return 0;
    const t = parseInt(current.tier, 10) || 1;
    return Math.max(1, Math.min(3, t)) - 1;
  }

  function calcTotals() {
    const tier = tierIndex();
    const base = PRICES[provider][tier] || 0;
    const p = cbPriority && cbPriority.checked ? 0.75 : 0.0;
    const t = cbTranscript && cbTranscript.checked ? 1.50 : 0.0;
    const subtotal = base + p + t;
    const tax = +(subtotal * 0.10).toFixed(2);
    const total = subtotal + tax;

    safeText(baseEl, money(base));
    safeText(priEl, money(p));
    safeText(trEl, money(t));
    safeText(taxEl, money(tax));
    safeText(totalEl, money(total));
    return { base, p, t, tax, total };
  }

  // ---- Upload ----

  function humanSize(bytes) {
    if (!bytes && bytes !== 0) return "";
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(1)} MB`;
  }
  function humanTime(sec) {
    const m = Math.floor(sec / 60), s = Math.round(sec % 60);
    return `${m}:${String(s).padStart(2, "0")} min`;
  }

  function setFileDetails(name, size, dur) {
    if (fileInfo) fileInfo.style.display = "flex";
    safeText(fileNameEl, name || "");
    safeText(fileSizeEl, humanSize(size));
    safeText(fileDuration, humanTime(dur));
  }

  function clearFile() {
    if (fileInfo) fileInfo.style.display = "none";
    if (fileInput) fileInput.value = "";
    current = null;
    calcTotals();
  }

  function uploadSelected(file) {
    hideError();
    if (!file) return;

    // Show optimistic UI
    setFileDetails(file.name, file.size, 0);

    const fd = new FormData();
    fd.append("file", file);

    fetch("/upload", { method: "POST", body: fd })
      .then(async (r) => {
        if (!r.ok) throw new Error(`Upload failed (${r.status})`);
        return r.json();
      })
      .then((j) => {
        current = j; // {job_id, duration_sec, size_bytes, tier, price, ...}
        setFileDetails(file.name, j.size_bytes, j.duration_sec);
        calcTotals();
      })
      .catch((e) => {
        clearFile();
        showError("Upload failed");
        console.error(e);
      });
  }

  on(uploadArea, "click", () => fileInput && fileInput.click());
  on(fileInput, "change", (e) => uploadSelected(e.target.files?.[0]));

  on(removeFileBtn, "click", (e) => {
    e.stopPropagation();
    clearFile();
  });

  // Drag & drop
  ["dragenter", "dragover", "dragleave", "drop"].forEach((ev) =>
    on(uploadArea, ev, (e) => { e.preventDefault(); e.stopPropagation(); })
  );
  on(uploadArea, "drop", (e) => uploadSelected(e.dataTransfer?.files?.[0]));

  // ---- Provider / extras ----

  on(providerList, "click", (e) => {
    const btn = e.target.closest("[data-provider]");
    if (!btn) return;
    document.querySelectorAll(".provider-card").forEach((c) => c.classList.remove("selected"));
    btn.classList.add("selected");
    provider = btn.getAttribute("data-provider") || "gmail";
    calcTotals();
  });
  on(cbPriority, "change", calcTotals);
  on(cbTranscript, "change", calcTotals);

  // ---- Pay & Compress ----

  on(processBtn, "click", async () => {
    hideError();
    if (!current) return showError("Please upload a video first.");
    if (!agreeCB || !agreeCB.checked) return showError("Please accept the Terms & Conditions.");

    const fd = new FormData();
    fd.append("job_id", current.job_id);
    fd.append("provider", provider);
    fd.append("priority", cbPriority && cbPriority.checked ? "true" : "false");
    fd.append("transcript", cbTranscript && cbTranscript.checked ? "true" : "false");
    fd.append("email", (emailInput && emailInput.value) || "");

    try {
      const r = await fetch("/checkout", { method: "POST", body: fd });
      if (!r.ok) throw new Error(`Checkout failed (${r.status})`);
      const j = await r.json();
      // Stripe hosted page
      window.location.href = j.checkout_url;
    } catch (e) {
      console.error(e);
      showError("Could not start payment.");
    }
  });

  // ---- After return from Stripe: connect SSE for progress ----

  function qs(name) {
    const u = new URL(window.location.href);
    return u.searchParams.get(name);
  }

  function startProgress(jobId) {
    if (!postPay) return;
    postPay.style.display = "block";
    activeStep(3);

    const es = new EventSource(`/events/${jobId}`);
    es.onmessage = (ev) => {
      try {
        const j = JSON.parse(ev.data || "{}");
        if (typeof j.progress === "number") {
          const pct = Math.max(0, Math.min(100, j.progress));
          if (progressFill) progressFill.style.width = `${pct}%`;
          safeText(progressPct, `${pct.toFixed(0)}%`);
        }
        if (j.note) safeText(progressNote, j.note);
        if (j.status === "done" && j.download_url) {
          es.close();
          if (dlSection) dlSection.style.display = "block";
          if (dlLink) dlLink.href = j.download_url;
          activeStep(4);
        } else if (j.status === "error") {
          es.close();
          showError("Processing failed. Please try again.");
        }
      } catch (e) {
        console.debug("SSE parse", e);
      }
    };
    es.onerror = () => {
      // Keep the UI alive; EventSource will auto‑reconnect
      safeText(progressNote, "Reconnecting…");
    };
  }

  // If returning from Stripe:
  const paid = qs("paid");
  const jobId = qs("job_id");
  if (paid === "1" && jobId) {
    // Reset any totals display (some users come back with a fresh page)
    calcTotals();
    startProgress(jobId);
  } else {
    activeStep(1);
    calcTotals();
  }

  // Version marker in console (handy when caching bites)
  console.log("Mailsized script version: v6.2");
})();
