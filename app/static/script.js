/* MailSized script – v6.3 (safe totals + robust progress) */
(function () {
  // ---------- tiny helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const on = (el, ev, fn) => el && el.addEventListener(ev, fn, { passive: true });
  const money = (n) => Number.isFinite(n) ? n : 0;
  const toMoney = (n) => `$${money(n).toFixed(2)}`;
  const setText = (el, txt) => { if (el) el.textContent = txt; };
  const show = (el) => { if (el) el.style.display = ""; };
  const hide = (el) => { if (el) el.style.display = "none"; };

  // ---------- cache DOM we use more than once ----------
  const uploadArea = $("#uploadArea");
  const fileInput = $("#fileInput");
  const fileInfo = $("#fileInfo");
  const fileNameEl = $("#fileName");
  const fileSizeEl = $("#fileSize");
  const fileDurEl = $("#fileDuration");
  const removeFileBtn = $("#removeFile");

  const providerList = $("#providerList");
  const chkPriority = $("#priority");
  const chkTranscript = $("#transcript");
  const emailInput = $("#userEmail");
  const agreeCb = $("#agree");
  const payBtn = $("#processButton");

  const errorBox = $("#errorContainer");
  const errorMsg = $("#errorMessage");

  const postPaySection = $("#postPaySection");
  const progressFill = $("#progressFill");
  const progressPct = $("#progressPct");
  const progressNote = $("#progressNote");
  const downloadSection = $("#downloadSection");
  const downloadLink = $("#downloadLink");

  const basePriceEl = $("#basePrice");
  const priorityPriceEl = $("#priorityPrice");
  const transcriptPriceEl = $("#transcriptPrice");
  const taxAmountEl = $("#taxAmount");
  const totalAmountEl = $("#totalAmount");

  // ---------- runtime state ----------
  let chosenProvider = "gmail";      // gmail | outlook | other
  let uploadMeta = null;             // { upload_id, size_bytes, duration_sec, file }
  let sse = null;                    // EventSource
  let sseRetryTimer = null;

  // ---------- pricing (client mirror of your tiers) ----------
  // Duration thresholds (seconds): ≤5min, ≤10min, ≤20min
  const TIERS = [
    { maxSec: 300,  prices: { gmail: 1.99, outlook: 2.19, other: 2.49 } },
    { maxSec: 600,  prices: { gmail: 2.99, outlook: 3.29, other: 3.99 } },
    { maxSec: 1200, prices: { gmail: 4.99, outlook: 4.99, other: 5.49 } },
  ];
  const TAX_RATE = 0.10;
  const ADDONS = { priority: 0.75, transcript: 1.50 };

  function priceFor(durationSec, provider) {
    if (!Number.isFinite(durationSec)) return 0;
    for (const t of TIERS) {
      if (durationSec <= t.maxSec) return t.prices[provider] ?? 0;
    }
    // over 20 minutes — you currently block these; price as last tier if it slips through
    return TIERS[TIERS.length - 1].prices[provider] ?? 0;
  }

  function calcTotals() {
    const durationSec = uploadMeta?.duration_sec;
    const base = priceFor(durationSec, chosenProvider);

    const priority = chkPriority?.checked ? ADDONS.priority : 0;
    const transcript = chkTranscript?.checked ? ADDONS.transcript : 0;

    const subtotal = money(base) + money(priority) + money(transcript);
    const tax = subtotal * TAX_RATE;
    const total = subtotal + tax;

    // Guard every write (prevents “cannot set properties of null”)
    setText(basePriceEl,       toMoney(base));
    setText(priorityPriceEl,   toMoney(priority));
    setText(transcriptPriceEl, toMoney(transcript));
    setText(taxAmountEl,       toMoney(tax));
    setText(totalAmountEl,     toMoney(total));
  }

  function showError(msg) {
    if (errorMsg) {
      errorMsg.textContent = msg || "An error occurred.";
      show(errorBox);
    }
  }
  function clearError() {
    if (errorBox) hide(errorBox);
    if (errorMsg) errorMsg.textContent = "";
  }

  // ---------- upload UX ----------
  function humanSize(bytes) {
    if (!Number.isFinite(bytes)) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }
  function humanDur(sec) {
    if (!Number.isFinite(sec)) return "";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")} min`;
  }

  async function postUpload(file) {
    // Sends file to /upload → expects JSON
    const fd = new FormData();
    fd.append("file", file);

    const res = await fetch("/upload", { method: "POST", body: fd });
    if (!res.ok) {
      // If the backend accidentally returns text (e.g., a stack trace), throw a clean error
      const text = await res.text();
      throw new Error(`Upload failed (${res.status}). ${text.slice(0, 120)}`);
    }
    // MUST be valid JSON (prevents “Unexpected token I… not valid JSON”)
    const data = await res.json(); // <-- if server returns plain text, this throws
    // TODO: match your backend payload keys if different
    if (!data || !data.ok || !data.upload_id) {
      throw new Error("Upload did not return an upload_id.");
    }
    return {
      upload_id: data.upload_id,
      size_bytes: data.size_bytes,
      duration_sec: data.duration_sec,
    };
  }

  async function handleFile(file) {
    clearError();
    hide(fileInfo);
    uploadMeta = null;
    updatePayState();

    if (!file) return;

    // show file row immediately (name + size), fill duration after server response
    setText(fileNameEl, file.name || "video");
    setText(fileSizeEl, humanSize(file.size));
    setText(fileDurEl, "");
    show(fileInfo);

    try {
      const meta = await postUpload(file);
      uploadMeta = { ...meta, file };

      setText(fileDurEl, humanDur(uploadMeta.duration_sec));
      calcTotals();
      updatePayState(true);
    } catch (err) {
      showError(err?.message || "Upload failed.");
      hide(fileInfo);
      uploadMeta = null;
      updatePayState();
    }
  }

  // Drag & drop + click‑to‑browse
  on(uploadArea, "click", () => fileInput && fileInput.click());
  on(fileInput, "change", (e) => handleFile(e.target.files?.[0]));
  // DnD
  on(uploadArea, "dragover", (e) => { e.preventDefault(); uploadArea.classList.add("drag"); });
  on(uploadArea, "dragleave", () => uploadArea.classList.remove("drag"));
  on(uploadArea, "drop", (e) => {
    e.preventDefault();
    uploadArea.classList.remove("drag");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFile(file);
  });
  on(removeFileBtn, "click", () => {
    fileInput && (fileInput.value = "");
    uploadMeta = null;
    hide(fileInfo);
    calcTotals(); // shows $0.00 across
    updatePayState();
  });

  // ---------- provider selection ----------
  on(providerList, "click", (e) => {
    const btn = e.target.closest("[data-provider]");
    if (!btn) return;
    chosenProvider = btn.getAttribute("data-provider") || "gmail";
    // visual
    providerList.querySelectorAll("[data-provider]").forEach(el => el.classList.remove("selected"));
    btn.classList.add("selected");
    calcTotals();
  });

  // ---------- pay button gating (item 3) ----------
  function updatePayState(uploadOK) {
    const ready =
      !!uploadMeta && (agreeCb?.checked === true);
    if (payBtn) {
      payBtn.disabled = !ready;
      payBtn.classList.toggle("disabled", !ready);
    }
    // Optional: nudge totals when upload finishes
    if (uploadOK) calcTotals();
  }
  on(agreeCb, "change", () => updatePayState());
  on(chkPriority, "change", calcTotals);
  on(chkTranscript, "change", calcTotals);

  // ---------- Stripe flow + progress ----------
  function startProgressUI() {
    if (!postPaySection) return;
    show(postPaySection);
    hide(downloadSection);
    if (progressFill) progressFill.style.width = "0%";
    setText(progressPct, "0%");
    setText(progressNote, "Working…");
  }
  function setProgress(p, note) {
    const pct = Math.max(0, Math.min(100, Number(p) || 0));
    if (progressFill) progressFill.style.width = `${pct}%`;
    setText(progressPct, `${pct}%`);
    if (note) setText(progressNote, note);
  }
  function finishProgress(downloadUrl) {
    setProgress(100, "Done");
    if (downloadLink && downloadUrl) downloadLink.href = downloadUrl;
    show(downloadSection);
  }
  function stopSSE() {
    if (sse) { sse.close(); sse = null; }
    if (sseRetryTimer) { clearTimeout(sseRetryTimer); sseRetryTimer = null; }
  }

  function listenProgress(jobId) {
    stopSSE();
    startProgressUI();

    const url = `/events/${encodeURIComponent(jobId)}`;
    sse = new EventSource(url);

    sse.onmessage = (evt) => {
      // each message is a JSON object from the server
      try {
        const data = JSON.parse(evt.data || "{}");
        if (data.type === "progress") {
          setProgress(data.percent, data.note || "Working…");
        } else if (data.type === "done") {
          setProgress(100, "Finalizing…");
          // TODO: match your backend payload key
          finishProgress(data.download_url);
          stopSSE();
        } else if (data.type === "error") {
          showError(data.message || "Compression failed.");
          stopSSE();
        }
      } catch {
        // ignore bad frames
      }
    };

    sse.onerror = () => {
      // Auto‑retry in case of 502 / network blips
      stopSSE();
      sseRetryTimer = setTimeout(() => listenProgress(jobId), 1200);
    };
  }

  async function beginCheckout() {
    clearError();
    if (!uploadMeta) {
      showError("Please upload a video first.");
      return;
    }
    if (!agreeCb?.checked) {
      showError("Please agree to the Terms & Conditions.");
      return;
    }

    payBtn && (payBtn.disabled = true);

    try {
      const fd = new FormData();
      fd.append("provider", chosenProvider);
      fd.append("priority", chkPriority?.checked ? "1" : "0");
      fd.append("transcript", chkTranscript?.checked ? "1" : "0");
      fd.append("email", (emailInput?.value || "").trim());
      // tie the upload to the purchase
      fd.append("upload_id", uploadMeta.upload_id);

      const res = await fetch("/checkout", { method: "POST", body: fd });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `Checkout failed (${res.status})`);
      }
      const data = await res.json();

      // TODO: match your backend payload
      if (data.checkout_url) {
        // Stripe redirect flow
        window.location.href = data.checkout_url;
        return;
      }
      if (data.paid && data.job_id) {
        // Paid in-app → jump to progress
        listenProgress(data.job_id);
      } else {
        throw new Error("Unexpected checkout response.");
      }
    } catch (err) {
      showError(err?.message || "Payment failed.");
      payBtn && (payBtn.disabled = false);
    }
  }
  on(payBtn, "click", beginCheckout);

  // ---------- handle return from Stripe ----------
  (function handleStripeReturn() {
    const qp = new URLSearchParams(window.location.search);
    if (qp.get("paid") === "1" && qp.get("job_id")) {
      // Move UI to step 3
      document.querySelectorAll(".progress-step").forEach((el, idx) => {
        el.classList.toggle("active", idx <= 2);
      });
      listenProgress(qp.get("job_id"));
    }
  })();

  // ---------- initial totals + state ----------
  calcTotals();
  updatePayState();

  console.log("Mailsized script version: v6.3");
})();
