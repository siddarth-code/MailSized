/* app/static/script.js */
/* MailSized script • v7.0 — size-tier + provider pricing */

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa= (sel, root = document) => Array.from(root.querySelectorAll(sel));

function fmtBytes(n){
  if(!Number.isFinite(n)) return "0 B";
  if(n < 1024) return `${n} B`;
  if(n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
  if(n < 1024*1024*1024) return `${(n/1048576).toFixed(1)} MB`;
  return `${(n/1073741824).toFixed(2)} GB`;
}
function fmtDuration(sec){
  if(!Number.isFinite(sec)||sec<=0) return "0:00 min";
  const m=Math.floor(sec/60), s=Math.floor(sec%60);
  return `${m}:${String(s).padStart(2,"0")} min`;
}
function setTextSafe(el, t){ if(el) el.textContent = t; }

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
  pricesByProvider: {
    // size tiers: ≤500MB, ≤1GB, ≤2GB
    gmail:   [1.99, 2.99, 4.49],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  },
  upsell: { priority: 0.75, transcript: 1.50 },
  taxRate: 0.10,
};

/* -------------------- pricing helpers -------------------- */
function sizeTierFromBytes(bytes){
  const mb = bytes/1048576; // 1024*1024
  if(mb <= 500) return 0;    // tier 1
  if(mb <= 1000) return 1;   // tier 2
  return 2;                  // tier 3 (up to 2GB by product limits)
}

function calcBasePrice(){
  const prov = state.provider || "gmail";
  const table = state.pricesByProvider[prov] || state.pricesByProvider.gmail;
  const tier = sizeTierFromBytes(state.sizeBytes);
  return Number(table[tier] || table[0] || 1.99);
}

function recalcAndRenderPrices(){
  const base = calcBasePrice();
  const pri  = $("priority")?.checked ? state.upsell.priority : 0;
  const tra  = $("transcript")?.checked ? state.upsell.transcript : 0;
  const subtotal = base + pri + tra;
  const tax = subtotal * state.taxRate;
  const total = subtotal + tax;

  setTextSafe($("basePrice"),       `$${base.toFixed(2)}`);
  setTextSafe($("priorityPrice"),   `$${Number(pri).toFixed(2)}`);
  setTextSafe($("transcriptPrice"), `$${Number(tra).toFixed(2)}`);
  setTextSafe($("taxAmount"),       `$${tax.toFixed(2)}`);
  setTextSafe($("totalAmount"),     `$${total.toFixed(2)}`);

  // stash for checkout
  state.currentPriceCents = Math.round(total * 100);
}

/* -------------------- upload UI -------------------- */
function wireUpload(){
  const uploadArea = $("uploadArea");
  const fileInput  = $("fileInput");
  const fileInfo   = $("fileInfo");
  if(!uploadArea || !fileInput) return;

  const openPicker = () => fileInput.click();
  ["click","keypress"].forEach(evt=>{
    uploadArea.addEventListener(evt,(e)=>{
      if(e.type==="keypress" && e.key!=="Enter" && e.key!==" ") return;
      openPicker();
    });
  });

  uploadArea.addEventListener("dragover", (e)=>{ e.preventDefault(); uploadArea.classList.add("dragover"); });
  uploadArea.addEventListener("dragleave", ()=> uploadArea.classList.remove("dragover"));
  uploadArea.addEventListener("drop", async (e)=>{
    e.preventDefault();
    uploadArea.classList.remove("dragover");
    if(e.dataTransfer?.files?.[0]) await handleFile(e.dataTransfer.files[0]);
  });

  fileInput.addEventListener("change", async ()=>{
    if(fileInput.files?.[0]) await handleFile(fileInput.files[0]);
  });

  $("removeFile")?.addEventListener("click", ()=>{
    state.file=null; state.uploadId=null; state.sizeBytes=0; state.durationSec=0;
    if(fileInput) fileInput.value="";
    if(fileInfo) fileInfo.style.display="none";
    setStep(0);
    recalcAndRenderPrices();
  });
}

async function handleFile(file){
  state.file = file;
  setTextSafe($("fileName"), file.name);
  setTextSafe($("fileSize"), fmtBytes(file.size));
  setTextSafe($("fileDuration"), "probing…");
  state.sizeBytes = Number(file.size||0);
  if($("fileInfo")) $("fileInfo").style.display="";

  // show upload progress bar
  const upWrap = $("uploadProgress");
  const upFill = $("uploadProgressFill");
  const upPct  = $("uploadProgressPct");
  const upNote = $("uploadNote");
  if(upWrap) upWrap.style.display="";
  if(upNote) upNote.style.display="";

  recalcAndRenderPrices(); // price now reflects size tier

  // Upload with progress (XHR)
  const fd = new FormData();
  fd.append("file", file);
  const emailVal = $("userEmail")?.value?.trim();
  if(emailVal) fd.append("email", emailVal);

  const xhr = new XMLHttpRequest();
  const resP = new Promise((resolve,reject)=>{
    xhr.onreadystatechange = ()=> {
      if(xhr.readyState === 4){
        (xhr.status >= 200 && xhr.status < 300) ? resolve(xhr.responseText) : reject(xhr.responseText || `HTTP ${xhr.status}`);
      }
    };
  });
  xhr.upload.onprogress = (e)=>{
    if(!e.lengthComputable) return;
    const pct = Math.min(100, Math.round((e.loaded/e.total)*100));
    if(upFill) upFill.style.width = `${pct}%`;
    if(upPct)  upPct.textContent  = `${pct}%`;
    if(upNote) upNote.textContent = pct<100 ? "Uploading…" : "Processing upload…";
  };
  xhr.open("POST", "/upload");
  xhr.send(fd);

  let data;
  try{
    const txt = await resP;
    data = JSON.parse(txt||"{}");
  }catch(err){
    return showError(typeof err==="string" ? err : "Upload failed.");
  }

  if(!data?.ok) return showError(data?.detail || "Upload rejected.");

  state.uploadId    = data.upload_id;
  state.durationSec = Number(data.duration_sec||0);

  setTextSafe($("fileDuration"), fmtDuration(state.durationSec));
  setStep(1);
  recalcAndRenderPrices();
}

/* -------------------- provider & extras -------------------- */
function wireProviders(){
  const list = $("providerList") || qs(".providers");
  if(!list) return;

  list.addEventListener("click",(e)=>{
    const btn = e.target.closest("[data-provider]");
    if(!btn) return;
    qsa("[data-provider]", list).forEach(n=> n.classList.remove("selected"));
    btn.classList.add("selected");
    state.provider = (btn.getAttribute("data-provider")||"gmail").toLowerCase();
    recalcAndRenderPrices();
  });

  $("priority")?.addEventListener("change", recalcAndRenderPrices);
  $("transcript")?.addEventListener("change", recalcAndRenderPrices);
}

/* -------------------- pay & compress -------------------- */
function wireCheckout(){
  const btn = $("processButton");
  if(!btn) return;

  btn.addEventListener("click", async ()=>{
    hideError();

    if(!state.file || !state.uploadId){
      return showError("Please upload a video first.");
    }
    const email = $("userEmail")?.value?.trim();
    if(!email){
      return showError("Please enter your email — it’s required to receive the download link.");
    }
    if(!$("agree")?.checked){
      return showError("Please accept the Terms & Conditions.");
    }

    // send our current total (server still recomputes)
    const payload = {
      upload_id: state.uploadId,
      provider: state.provider,
      priority: !!$("priority")?.checked,
      transcript: !!$("transcript")?.checked,
      email,
      price_cents: state.currentPriceCents ?? null,
    };

    let res, data;
    try{
      res  = await fetch("/checkout", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify(payload) });
      data = await res.json();
    }catch{
      return showError("Could not start checkout. Please try again.");
    }
    if(!data?.url) return showError("Checkout could not be created. Please try again.");

    setStep(1);
    window.location.href = data.url; // Stripe
  });
}

/* -------------------- post‑payment progress & download -------------------- */
function resumeIfPaid(){
  const root = $("pageRoot");
  const paidFromDataset = root?.getAttribute("data-paid") === "1";
  const jobFromDataset  = root?.getAttribute("data-job-id") || "";

  const url  = new URL(window.location.href);
  const paid = url.searchParams.get("paid")==="1" || paidFromDataset;
  const jobId= url.searchParams.get("job_id") || jobFromDataset;
  if(!paid || !jobId) return;

  const post = $("postPaySection"); if(post) post.style.display="";
  setStep(2);
  startSSE(jobId);
}

function startSSE(jobId){
  const pctEl = $("progressPct");
  const fillEl= $("progressFill");
  const noteEl= $("progressNote");
  const dlSec = $("downloadSection");
  const dlA   = $("downloadLink");
  const emailNote = $("EmailNote") || $("emailNote");

  try{
    const es = new EventSource(`/events/${encodeURIComponent(jobId)}`);
    es.onmessage = async (evt)=>{
      let data = {};
      try{ data = JSON.parse(evt.data||"{}"); }catch{}

      const p = Number(data.progress||0);
      if(pctEl) setTextSafe(pctEl, `${Math.floor(p)}%`);
      if(fillEl) fillEl.style.width = `${Math.floor(p)}%`;
      if(noteEl) setTextSafe(noteEl, data.message || "Working…");

      // If backend already includes the URL in SSE (download_url), show it immediately
      if(data.download_url && dlA){
        dlA.href = data.download_url;
        if(dlSec) dlSec.style.display="";
        if(emailNote) emailNote.style.display="";
      }

      if(data.status === "done"){
        es.close();
        // If we didn't receive a URL in SSE, fetch it
        if(dlA && !dlA.href){
          try{
            const r = await fetch(`/download/${encodeURIComponent(jobId)}`);
            const j = await r.json();
            if(j?.url){
              dlA.href = j.url;
              if(dlSec) dlSec.style.display="";
              if(emailNote) emailNote.style.display="";
            }
          }catch{}
        }
        if(noteEl) setTextSafe(noteEl, "Complete");
        setStep(3);
      }else if(data.status === "error"){
        es.close();
        showError(data.message || "Compression failed.");
        if(noteEl) setTextSafe(noteEl, "Error");
      }
    };
    es.onerror = ()=>{/* server sends heartbeats; leave as-is */};
  }catch{/* noop */}
}

/* -------------------- error UI -------------------- */
function showError(msg){
  const box=$("errorContainer"), msgEl=$("errorMessage");
  if(msgEl) msgEl.textContent = String(msg||"Something went wrong.");
  if(box) box.style.display = "";
}
function hideError(){ const box=$("errorContainer"); if(box) box.style.display="none"; }

/* -------------------- boot -------------------- */
document.addEventListener("DOMContentLoaded", ()=>{
  wireUpload();
  wireProviders();
  wireCheckout();
  recalcAndRenderPrices();
  resumeIfPaid();
});
