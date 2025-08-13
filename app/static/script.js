/* MailSized front-end (v2025-08-13-fix-upload)
   - Robust upload handler (shows real server errors)
   - Defensive DOM writes (won’t crash if an element is missing)
   - Pricing calc won’t throw if a node is absent
*/

console.log("Mailsized script version: v6-fix-upload");

//
// ---------- Small DOM helpers ----------
//
const byId = (id) => document.getElementById(id);
const setText = (id, text) => { const el = byId(id); if (el) el.textContent = text; };
const show    = (id) => { const el = byId(id); if (el) el.style.display = ""; };
const hide    = (id) => { const el = byId(id); if (el) el.style.display = "none"; };
const addCls  = (el, c) => el && el.classList && el.classList.add(c);
const rmCls   = (el, c) => el && el.classList && el.classList.remove(c);

const $ = {
  fileInput:     byId("fileInput"),
  uploadArea:    byId("uploadArea"),
  fileInfo:      byId("fileInfo"),
  fileName:      byId("fileName"),
  fileSize:      byId("fileSize"),
  fileDuration:  byId("fileDuration"),
  removeFile:    byId("removeFile"),
  providers:     document.querySelectorAll(".provider-card"),
  errorBox:      byId("errorContainer"),
  errorMsg:      byId("errorMessage"),
  agree:         byId("agree"),
  priority:      byId("priority"),
  transcript:    byId("transcript"),
  email:         byId("userEmail"),
  payBtn:        byId("processButton"),
  progressWrap:  byId("progressWrap"),     // may not exist yet
  progressBar:   byId("progressBar"),      // may not exist yet
  progressPct:   byId("progressPct"),      // may not exist yet
  downloadSect:  byId("downloadSection"),
  downloadLink:  byId("downloadLink"),
};

let STATE = {
  jobId: null,
  tier: null,
  provider: "gmail",
  basePrice: 0,
  durationSec: 0,
  sizeBytes: 0
};

//
// ---------- Utility: money & bytes ----------
//
const fmtUSD = (n) => `$${n.toFixed(2)}`;
const bytesToMB = (b) => (b / (1024 * 1024));
const humanBytes = (b) => {
  if (b < 1024) return `${b} B`;
  if (b < 1024*1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
};

//
// ---------- Error UI ----------
//
function showError(msg) {
  if ($.errorMsg) $.errorMsg.textContent = msg || "Something went wrong.";
  show("errorContainer");
}
function clearError() {
  hide("errorContainer");
  if ($.errorMsg) $.errorMsg.textContent = "";
}

//
// ---------- Pricing (defensive) ----------
//
function calcTotals() {
  // Base price comes from backend tier; provider cards only change which base we display server-side later
  const base = Number($.payBtn?.dataset.base || STATE.basePrice || 0);
  const pri  = $.priority?.checked ? 0.75 : 0;
  const trn  = $.transcript?.checked ? 1.50 : 0;
  const subtotal = base + pri + trn;
  const tax = +(subtotal * 0.10).toFixed(2);
  const total = +(subtotal + tax).toFixed(2);

  setText("basePrice", fmtUSD(base));
  setText("priorityPrice", fmtUSD(pri));
  setText("transcriptPrice", fmtUSD(trn));
  setText("taxAmount", fmtUSD(tax));
  setText("totalAmount", fmtUSD(total));
}

//
// ---------- Provider selection ----------
//
function selectProvider(code) {
  STATE.provider = code;
  $.providers.forEach(card => {
    if (card.dataset.provider === code) addCls(card, "selected");
    else rmCls(card, "selected");
  });
  // Recalc UI (safe even if some nodes are missing)
  calcTotals();
}

$.providers.forEach(card => {
  card.addEventListener("click", () => selectProvider(card.dataset.provider));
});

//
// ---------- Upload interactions ----------
//
if ($.uploadArea && $.fileInput) {
  $.uploadArea.addEventListener("click", () => $.fileInput.click());
  $.uploadArea.addEventListener("dragover", (e) => { e.preventDefault(); addCls($.uploadArea, "dragover"); });
  $.uploadArea.addEventListener("dragleave", (e) => { e.preventDefault(); rmCls($.uploadArea, "dragover"); });
  $.uploadArea.addEventListener("drop", (e) => {
    e.preventDefault(); rmCls($.uploadArea, "dragover");
    if (e.dataTransfer?.files?.[0]) {
      $.fileInput.files = e.dataTransfer.files;
      handleFileChosen();
    }
  });
  $.fileInput.addEventListener("change", handleFileChosen);
}

if ($.removeFile) {
  $.removeFile.addEventListener("click", () => {
    if ($.fileInput) $.fileInput.value = "";
    STATE.jobId = null;
    hide("fileInfo");
    show("uploadArea");
  });
}

async function handleFileChosen() {
  clearError();
  const f = $.fileInput?.files?.[0];
  if (!f) return;

  // Visuals
  setText("fileName", f.name);
  setText("fileSize", humanBytes(f.size));
  hide("uploadArea");
  show("fileInfo");

  // Upload to backend
  try {
    $.payBtn && ($.payBtn.disabled = true);
    $.payBtn && ($.payBtn.textContent = "Uploading…");

    const fd = new FormData();
    fd.append("file", f); // <— name MUST be "file" (matches FastAPI)

    const res = await fetch("/upload", { method: "POST", body: fd });
    // If server returned non-2xx, try to show the real error text
    if (!res.ok) {
      const maybeText = await res.text().catch(() => "");
      throw new Error(maybeText || `Upload failed (${res.status})`);
    }

    const data = await res.json();
    // Persist state from server
    STATE.jobId       = data.job_id;
    STATE.durationSec = data.duration_sec || 0;
    STATE.sizeBytes   = data.size_bytes || f.size;
    STATE.tier        = data.tier || null;
    STATE.basePrice   = data.price || 0;

    // Make base price available to calcTotals defensively
    if ($.payBtn) $.payBtn.dataset.base = String(STATE.basePrice);

    // Show duration (if probed)
    if (data.duration_sec) setText("fileDuration", ` • ${(data.duration_sec/60).toFixed(1)} min`);

    calcTotals();

    $.payBtn && ($.payBtn.disabled = false);
    $.payBtn && ($.payBtn.textContent = "Pay & Compress");

  } catch (err) {
    console.error(err);
    $.payBtn && ($.payBtn.disabled = false);
    $.payBtn && ($.payBtn.textContent = "Pay & Compress");

    // Don’t claim “Upload failed” generically — show the root cause
    showError(err?.message || "Upload failed.");
    // Return to chooser so the user can retry
    show("uploadArea");
    hide("fileInfo");
  }
}

//
// ---------- Extras change: keep totals in sync ----------
//
[$.priority, $.transcript].forEach(chk => chk && chk.addEventListener("change", calcTotals));

//
// ---------- Payment & compression (unchanged here) ----------
//   Your existing /checkout + SSE flow continues to work.
//   The key fix in this file is:
//   - upload handler now shows real server errors
//   - DOM writes are guarded so they can’t crash the page
//
