/* app/static/script.js */
/* MailSized script • v7.0  — size-based pricing + upload progress + final download link */

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa= (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtBytes(n){
  if (!Number.isFinite(n)) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if (n < 1024*1024*1024) return `${(n/(1024*1024)).toFixed(1)} MB`;
  return `${(n/(1024*1024*1024)).toFixed(1)} GB`;
}
function fmtDuration(sec){
  if (!Number.isFinite(sec) || sec <= 0) return "0:00 min";
  const m = Math.floor(sec/60), s = Math.floor(sec%60);
  return `${m}:${String(s).padStart(2,"0")} min`;
}
function setTextSafe(el, text){ if(el) el.textContent = text; }
function show(el){ if(el) el.style.display = ""; }
function hide(el){ if(el) el.style.display = "none"; }

function setStep(activeIndex){
  const steps = [$("step1"),$("step2"),$("step3"),$("step4")].filter(Boolean);
  steps.forEach((node,i)=> node.classList.toggle("active", i<=activeIndex));
}

/* -------------------- state -------------------- */
const state = {
  file: null,
  uploadId: null,
  durationSec: 0,
  sizeBytes: 0,
  provider: "gmail",
  // server will send authoritative price; we mirror on the UI
  priceCents: 0,
  // size-tier table used for the sidebar display
  sizePricing: [
    { label: "0–250 MB",   price: 1.99, maxMB: 250 },
    { label: "251–750 MB", price: 3.99, maxMB: 750 },
    { label: "751 MB–1.25 GB", price: 5.99, maxMB: 1280 },
    { label: "1.26–2.00 GB",   price: 7.99, maxMB: 2048 },
  ],
  upsell: { priority: 0.75, transcript: 1.50 },
};

/* -------------------- pricing helpers -------------------- */
function priceDollarsFromSize(sizeBytes){
  const mb = sizeBytes/(1024*1024);
  if (mb <= 250) return 1.99;
  if (mb <= 750) return 3.99;
  if (mb <= 1280) return 5.99;
  return 7.99; // up to 2 GB
}

function calcTotals(){
  const baseEl = $("basePrice");
  const priorityEl = $("priorityPrice");
  const transcriptEl = $("transcriptPrice");
  const taxEl = $("taxAmount");
  const totalEl = $("totalAmount");

  // base is size‑tiered; if we don't know size yet, default to smallest
  const base = state.sizeBytes ? priceDollarsFromSize(state.sizeBytes) : 1.99;

  const pri = $("priority")?.checked ? state.upsell.priority : 0;
  const tra = $("transcript")?.checked ? state.upsell.transcript : 0;

  const subtotal = Number(base) + Number(pri) + Number(tra);
  const tax = subtotal * 0.10;
  const total = subtotal + tax;

  setTextSafe(baseEl,       `$${Number(base).toFixed(2)}`);
  setTextSafe(priorityEl,   `$${Number(pri).toFixed(2)}`);
  setTextSafe(transcriptEl, `$${Number(tra).toFixed(2)}`);
  setTextSafe(taxEl,        `$${tax.toFixed(2)}`);
  setTextSafe(totalEl,      `$${total.toFixed(2)}`);
}

/* -------------------- upload UI + progress -------------------- */
function wireUpload(){
  const uploadArea = $("uploadArea");
  const fileInput  = $("fileInput");
  const fileInfo   = $("fileInfo");
  const upWrap     = $("uploadProgress");   // wrapper (hidden by default)
  const upPct      = $("uploadPct");
  const upFill     = $("uploadFill");
  const upNote     = $("uploadNote");

  if(!uploadArea || !fileInput) return;

  const openPicker = () => fileInput.click();
  ["click","keypress"].forEach(evt=>{
    uploadArea.addEventListener(evt,(e)=>{
      if (e.type==="keypress" && e.key!=="Enter" && e.key!==" ") return;
      openPicker();
    });
  });

  uploadArea.addEventListener("dragover",(e)=>{e.preventDefault();uploadArea.classList.add("dragover");});
  uploadArea.addEventListener("dragleave",()=>uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop",(e)=>{
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    if(e.dataTransfer?.files?.[0]) handleFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", ()=>{ if(fileInput.files?.[0]) handleFile(fileInput.files[0]); });

  $("removeFile")?.addEventListener("click", ()=>{
    state.file=null; state.uploadId=null; state.durationSec=0; state.sizeBytes=0; state.priceCents=0;
    fileInput.value="";
    if (fileInfo) fileInfo.style.display="none";
    hide(upWrap);
    setStep(0);
    calcTotals();
  });

  async function handleFile(file){
    state.file = file;
    setTextSafe($("fileName"), file.name);
    setTextSafe($("fileSize"), fmtBytes(file.size));
    setTextSafe($("fileDuration"), "probing…");
    if (fileInfo) fileInfo.style.display="";

    // show upload progress bar
    show(upWrap);
    setTextSafe(upPct, "0%");
    if (upFill) upFill.style.width = "0%";
    setTextSafe(upNote, "Uploading…");

    try{
      const data = await uploadWithProgress(file, $("userEmail")?.value?.trim() || "", (pct)=>{
        setTextSafe(upPct, `${Math.floor(pct)}%`);
        if (upFill) upFill.style.width = `${Math.floor(pct)}%`;
      });
      if (!data?.ok) return showError(data?.detail || "Upload rejected.");

      state.uploadId    = data.upload_id;
      state.durationSec = Number(data.duration_sec || 0);
      state.sizeBytes   = Number(data.size_bytes || 0);
      state.priceCents  = Number(data.price_cents || 0);

      setTextSafe($("fileDuration"), fmtDuration(state.durationSec));
      setTextSafe(upNote, "Upload complete");
      setStep(1);
      calcTotals();
    }catch(err){
      showError("Upload failed. Check your network and try again.");
    }
  }
}

/** Use XHR to get reliable upload progress; returns JSON from /upload */
function uploadWithProgress(file, email, onProgress){
  return new Promise((resolve, reject)=>{
    const fd = new FormData();
    fd.append("file", file);
    if (email) fd.append("email", email);

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/upload", true);

    xhr.upload.onprogress = (e)=>{
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      if (typeof onProgress === "function") onProgress(pct);
    };
    xhr.onerror = ()=> reject(new Error("xhr error"));
    xhr.onload = ()=>{
      try{
        if (xhr.status >= 200 && xhr.status < 300){
          resolve(JSON.parse(xhr.responseText || "{}"));
        } else {
          reject(new Error(`status ${xhr.status}`));
        }
      }catch{
        reject(new Error("bad json"));
      }
    };
    xhr.send(fd);
  });
}

/* -------------------- provider & extras -------------------- */
function wireProviders(){
  const list = $("providerList") || qs(".providers");
  if(!list) return;

  list.addEventListener("click",(e)=>{
    const btn = e.target.closest("[data-provider]");
    if (!btn) return;
    qsa("[data-provider]", list).forEach((n)=> n.classList.remove("selected"));
    btn.classList.add("selected");
    state.provider = (btn.getAttribute("data-provider") || "gmail").toLowerCase();
    calcTotals();
  });

  $("priority")?.addEventListener("change", calcTotals);
  $("transcript")?.addEventListener("change", calcTotals);
}

/* -------------------- pay & compress -------------------- */
function wireCheckout(){
  const btn = $("processButton");
  if (!btn) return;

  btn.addEventListener("click", async ()=>{
    hideError();

    if(!state.file || !state.uploadId) return showError("Please upload a video first.");
    if(!$("agree")?.checked)          return showError("Please accept the Terms & Conditions.");

    // price is server-authoritative, but we still send email/options
    const payload = {
      upload_id: state.uploadId,
      provider: state.provider,
      priority: !!$("priority")?.checked,
      transcript: !!$("transcript")?.checked,
      email: $("userEmail")?.value?.trim() || "",
    };

    let res;
    try{
      res = await fetch("/checkout",{
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify(payload),
      });
    }catch{
      return showError("Could not start checkout. Please try again.");
    }

    let data;
    try{ data = await res.json(); }catch{ return showError("Unexpected server response (not JSON)."); }

    const url = data?.url || data?.checkout_url;
    if (!url) return showError("Checkout could not be created. Please try again.");

    setStep(1);
    window.location.href = url; // go to Stripe
  });
}

/* -------------------- post‑payment progress + final link -------------------- */
function resumeIfPaid(){
  const root = $("pageRoot");
  const fromDataset = {
    paid:  root?.getAttribute("data-paid") === "1",
    jobId: root?.getAttribute("data-job-id") || "",
  };
  const url = new URL(window.location.href);
  const paid = url.searchParams.get("paid") === "1" || fromDataset.paid;
  const jobId= url.searchParams.get("job_id") || fromDataset.jobId;
  if (!paid || !jobId) return;

  // show compression progress section
  const post = $("postPaySection"); if (post) post.style.display = "";
  setStep(2);
  startSSE(jobId);
}

function startSSE(jobId){
  const pctEl  = $("progressPct");
  const fillEl = $("progressFill");
  const noteEl = $("progressNote");
  const dlSection = $("downloadSection");
  const dlLink = $("downloadLink");
  const dlMsg  = $("emailNote"); // “We’ve also emailed…” line

  try{
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);
    es.onmessage = async (evt)=>{
      let data={}; try{ data = JSON.parse(evt.data || "{}"); }catch{}
      const p = Number(data.progress || 0);
      setTextSafe(pctEl, `${Math.floor(p)}%`);
      if (fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      setTextSafe(noteEl, data.message || "Working…");

      if (data.status === "done"){
        es.close();

        // If server already sent a download_url in the SSE payload, use it immediately
        if (data.download_url && dlLink){
          dlLink.href = data.download_url;
          show(dlSection);
          setTextSafe(noteEl, "Complete");
          if (dlMsg) dlMsg.style.display = ""; // show “emailed” line
          setStep(3);
          return;
        }

        // Otherwise, fetch the URL via /download/{job_id}
        try{
          const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
          const j = await r.json();
          if (j?.url && dlLink){
            dlLink.href = j.url;
            show(dlSection);
            setTextSafe(noteEl, "Complete");
            if (dlMsg) dlMsg.style.display = "";
            setStep(3);
          }
        }catch{}
      }else if (data.status === "error"){
        es.close();
        showError(data.message || "Compression failed.");
        setTextSafe(noteEl, "Error");
      }
    };
    es.onerror = ()=>{/* keep alive via server heartbeats */};
  }catch{/* noop */}
}

/* -------------------- errors -------------------- */
function showError(msg){
  const box = $("errorContainer");
  const msgEl = $("errorMessage");
  if (msgEl) msgEl.textContent = String(msg || "Something went wrong.");
  if (box) box.style.display = "";
}
function hideError(){ const box = $("errorContainer"); if (box) box.style.display = "none"; }

/* -------------------- boot -------------------- */
document.addEventListener("DOMContentLoaded", ()=>{
  wireUpload();
  wireProviders();
  wireCheckout();
  calcTotals();
  resumeIfPaid();
});
