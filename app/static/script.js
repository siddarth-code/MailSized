/* MailSized front-end (robust DOM-safe version)
   v6.3 — guards against missing pricing nodes and early calls
*/

console.log("Mailsized script version: v6.3-dom-guards");

/* ---------- Helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const byId = (id) => document.getElementById(id);

// Safe text setter – silently skip if node missing
function setText(id, text) {
  const el = byId(id);
  if (el) el.textContent = text;
}

// Currency helpers
const fmt = (x) => `$${Number(x).toFixed(2)}`;

// Provider pricing table (by tier 1..3)
const PROVIDER_PRICING = {
  gmail:   [1.99, 2.99, 4.99],
  outlook: [2.19, 3.29, 4.99],
  other:   [2.49, 3.99, 5.49],
};

const UPSells = { priority: 0.75, transcript: 1.50 };

// State the server gives back after /upload
// { job_id, tier, ... }
let UPLOAD_DATA = null;

// Which provider is currently selected
function getSelectedProvider() {
  const sel = $(".provider-card.selected");
  return sel ? sel.dataset.provider : "gmail";
}

// Tier → 1..3. If no upload yet, default to 1 so the UI doesn’t crash.
function getTier() {
  return UPLOAD_DATA?.tier ? Number(UPLOAD_DATA.tier) : 1;
}

/* ---------- Pricing calc (DOM-safe) ---------- */
function calcTotals() {
  // If the pricing summary isn’t present on this page view, just skip
  const mustExist = ["basePrice", "priorityPrice", "transcriptPrice", "taxAmount", "totalAmount"];
  const missing = mustExist.some((id) => !byId(id));
  if (missing) return;

  const provider = getSelectedProvider();
  const tier = getTier();

  const base = PROVIDER_PRICING[provider][tier - 1] || 0;
  const priority = byId("priority")?.checked ? UPSells.priority : 0;
  const transcript = byId("transcript")?.checked ? UPSells.transcript : 0;

  // Subtotal before tax (you’re currently just showing tax; not charging it on Stripe)
  const subtotal = base + priority + transcript;
  const tax = +(subtotal * 0.10).toFixed(2); // display only
  const total = subtotal + tax;

  setText("basePrice",        fmt(base));
  setText("priorityPrice",    fmt(priority));
  setText("transcriptPrice",  fmt(transcript));
  setText("taxAmount",        fmt(tax));
  setText("totalAmount",      fmt(total));
}

/* ---------- UI wiring ---------- */
function selectProvider(card) {
  $$(".provider-card").forEach((c) => c.classList.remove("selected"));
  card.classList.add("selected");
  calcTotals();
}

function wireProviders() {
  $$(".provider-card").forEach((card) => {
    card.addEventListener("click", () => selectProvider(card));
  });
}

function wireUpsells() {
  byId("priority")?.addEventListener("change", calcTotals);
  byId("transcript")?.addEventListener("change", calcTotals);
}

/* ---------- Upload ---------- */
async function postUpload(file) {
  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("/upload", { method: "POST", body: fd });
  if (!res.ok) {
    throw new Error(`Upload failed (${res.status})`);
  }
  return res.json();
}

function showFileInfo(file, meta) {
  const info = byId("fileInfo");
  const nameEl = byId("fileName");
  const sizeEl = byId("fileSize");
  const durEl  = byId("fileDuration");

  if (info) info.style.display = "flex";
  if (nameEl) nameEl.textContent = file.name || "video";
  if (sizeEl) sizeEl.textContent = `${(meta.size_bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (durEl)  durEl.textContent  = ` • ${(meta.duration_sec / 60).toFixed(2)} min`;
}

function showError(msg) {
  const box = byId("errorContainer");
  const text = byId("errorMessage");
  if (box && text) {
    text.textContent = msg;
    box.style.display = "block";
  } else {
    alert(msg);
  }
}

function hideError() {
  const box = byId("errorContainer");
  if (box) box.style.display = "none";
}

async function handleUpload(file) {
  hideError();
  try {
    const data = await postUpload(file);
    UPLOAD_DATA = data;
    showFileInfo(file, data);
    // highlight the correct tier step if you have that UI
    calcTotals();
  } catch (e) {
    console.error(e);
    showError("Upload failed");
  }
}

function wireUpload() {
  const drop = byId("uploadArea");
  const input = byId("fileInput");
  const removeBtn = byId("removeFile");

  if (!drop || !input) return;

  drop.addEventListener("click", () => input.click());
  drop.addEventListener("dragover", (ev) => { ev.preventDefault(); drop.classList.add("drag"); });
  drop.addEventListener("dragleave", () => drop.classList.remove("drag"));
  drop.addEventListener("drop", (ev) => {
    ev.preventDefault();
    drop.classList.remove("drag");
    if (ev.dataTransfer?.files?.length) {
      handleUpload(ev.dataTransfer.files[0]);
    }
  });

  input.addEventListener("change", () => {
    if (input.files?.length) handleUpload(input.files[0]);
  });

  removeBtn?.addEventListener("click", () => {
    UPLOAD_DATA = null;
    const fi = byId("fileInfo");
    if (fi) fi.style.display = "none";
    input.value = "";
    calcTotals(); // still safe
  });
}

/* ---------- Checkout ---------- */
async function startCheckout() {
  hideError();
  if (!UPLOAD_DATA?.job_id) {
    showError("Please upload a video first.");
    return;
  }
  if (!byId("agree")?.checked) {
    showError("Please accept the Terms & Conditions.");
    return;
  }

  const provider = getSelectedProvider();
  const body = new URLSearchParams({
    job_id: UPLOAD_DATA.job_id,
    provider,
    priority: byId("priority")?.checked ? "true" : "false",
    transcript: byId("transcript")?.checked ? "true" : "false",
    email: byId("userEmail")?.value?.trim() || "",
  });

  const res = await fetch("/checkout", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    showError("Could not start payment.");
    return;
  }

  const data = await res.json();
  if (data.checkout_url) {
    window.location.href = data.checkout_url;
  } else {
    showError("Unexpected response from payment.");
  }
}

function wirePay() {
  byId("processButton")?.addEventListener("click", () => {
    startCheckout().catch((e) => {
      console.error(e);
      showError("Could not start payment.");
    });
  });
}

/* ---------- Post-payment progress (SSE) ---------- */
function sseProgressIfNeeded() {
  const url = new URL(window.location.href);
  const paid = url.searchParams.get("paid");
  const jobId = url.searchParams.get("job_id");
  if (!paid || !jobId) return;

  const bar = byId("progressBar");      // optional – if you added one
  const row = byId("progressRow");      // wrapper row, optional
  const dl  = byId("downloadSection");  // existing download section
  const link= byId("downloadLink");

  row && (row.style.display = "block");

  const ev = new EventSource(`/events/${jobId}`);
  ev.onmessage = (m) => {
    try {
      const data = JSON.parse(m.data);
      // Status only stream; we fake percentage: queued(2%), processing(20%), compressing(60%), finalizing(90%), done(100%)
      const map = { queued:2, processing:20, compressing:60, finalizing:90, done:100, error:0 };
      const pct = map[data.status] ?? 0;
      if (bar) bar.style.width = `${pct}%`;

      if (data.status === "done" && data.download_url) {
        ev.close();
        if (dl) dl.style.display = "block";
        if (link) link.href = data.download_url;
      }
      if (data.status === "error") {
        ev.close();
        showError("An error occurred during processing.");
      }
    } catch (_) {}
  };
}

/* ---------- Boot ---------- */
document.addEventListener("DOMContentLoaded", () => {
  // Only wire once the DOM is ready
  wireProviders();
  wireUpsells();
  wireUpload();
  wirePay();

  // First, try to calc – if nodes are missing this safely no-ops.
  calcTotals();

  // If we returned from Stripe with ?paid=1, begin SSE progress
  sseProgressIfNeeded();
});
