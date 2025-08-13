// static/script.js
// MailSized frontend: upload -> price calc -> Stripe redirect -> SSE resume

window._mailsizedVersion = 'v5-ffmpeg-2pass';
console.log('MailSized script version:', window._mailsizedVersion);

document.addEventListener('DOMContentLoaded', () => {
  // ---- Elements
  const uploadArea   = document.getElementById('uploadArea');
  const fileInput    = document.getElementById('fileInput');
  const fileInfo     = document.getElementById('fileInfo');
  const fileNameEl   = document.getElementById('fileName');
  const fileSizeEl   = document.getElementById('fileSize');
  const fileDurEl    = document.getElementById('fileDuration');
  const removeBtn    = document.getElementById('removeFile');

  const providerCards = document.querySelectorAll('.provider-card');
  const priorityCb    = document.getElementById('priority');
  const transcriptCb  = document.getElementById('transcript');
  const agreeCb       = document.getElementById('agree');
  const emailInput    = document.getElementById('userEmail');
  const processBtn    = document.getElementById('processButton');

  const errBox        = document.getElementById('errorContainer');
  const errMsg        = document.getElementById('errorMessage');

  const basePriceEl      = document.getElementById('basePrice');
  const priorityPriceEl  = document.getElementById('priorityPrice');
  const transcriptPriceEl= document.getElementById('transcriptPrice');
  const taxAmountEl      = document.getElementById('taxAmount');
  const totalAmountEl    = document.getElementById('totalAmount');

  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const step4 = document.getElementById('step4');

  const downloadSection = document.getElementById('downloadSection');
  const downloadLink    = document.getElementById('downloadLink');

  // ---- Constants
  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };

  // Optional: update the “Max Size” column labels in your table (purely cosmetic)
  const tableMaxSizeCells = document.querySelectorAll('.pricing-table tbody tr td:nth-child(2)');
  if (tableMaxSizeCells.length === 3) {
    tableMaxSizeCells[0].textContent = '≤500 MB';
    tableMaxSizeCells[1].textContent = '≤1 GB';
    tableMaxSizeCells[2].textContent = '≤2 GB';
  }

  // ---- State
  let selectedProvider = 'gmail';
  let jobId = null;
  let tier  = null;     // 1..3
  let basePrice = 0;    // Server's Gmail base (not shown; we compute from provider)
  let eventSource = null;

  // ---- Helpers
  const fmtSize = (bytes) => {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1048576) return `${(bytes/1024).toFixed(1)} KB`;
    if (bytes < 1073741824) return `${(bytes/1048576).toFixed(1)} MB`;
    return `${(bytes/1073741824).toFixed(1)} GB`;
  };
  const fmtDur = (seconds) => {
    const m = Math.floor(seconds/60);
    const s = Math.floor(seconds%60);
    return `${m}:${s < 10 ? '0':''}${s} min`;
  };
  const showError = (m) => { errMsg.textContent = m || 'Something went wrong'; errBox.style.display = 'block'; };
  const hideError = () => { errBox.style.display = 'none'; errMsg.textContent = ''; };
  const setActive = (n) => {
    [step1,step2,step3,step4].forEach((s,i)=> s.classList.toggle('active', i < n));
  };

  function currentBaseForProvider() {
    if (!tier) return 0;
    const arr = PROVIDER_PRICING[selectedProvider] || PROVIDER_PRICING.gmail;
    return arr[tier - 1];
  }

  function updatePriceSummary() {
    const base     = currentBaseForProvider();
    const priority = priorityCb.checked ? 0.75 : 0;
    const transcript = transcriptCb.checked ? 1.50 : 0;
    const subtotal = base + priority + transcript;
    const tax      = subtotal * 0.10;
    const total    = subtotal + tax;

    basePriceEl.textContent       = `$${base.toFixed(2)}`;
    priorityPriceEl.textContent   = `$${priority.toFixed(2)}`;
    transcriptPriceEl.textContent = `$${transcript.toFixed(2)}`;
    taxAmountEl.textContent       = `$${tax.toFixed(2)}`;
    totalAmountEl.textContent     = `$${total.toFixed(2)}`;
  }

  function startSSE(id) {
    if (eventSource) { try { eventSource.close(); } catch(_){} }
    setActive(3);
    eventSource = new EventSource(`/events/${id}`);
    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data || '{}');
      if (data.status === 'processing' || data.status === 'compressing' || data.status === 'finalizing') {
        setActive(3);
      } else if (data.status === 'done') {
        setActive(4);
        if (data.download_url) {
          downloadLink.href = data.download_url;
          downloadSection.style.display = 'block';
        }
        processBtn.innerHTML = '<i class="fas fa-check"></i> Completed';
        processBtn.disabled = true;
        eventSource.close();
      } else if (data.status === 'error') {
        showError('An error occurred during processing');
        processBtn.innerHTML = '<i class="fas fa-times"></i> Error';
        processBtn.disabled = false;
        eventSource.close();
      }
    };
  }

  // ---- Provider selection
  providerCards.forEach(card => {
    card.addEventListener('click', () => {
      providerCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedProvider = card.dataset.provider;
      updatePriceSummary();        // <- THIS updates immediately
    });
  });
  priorityCb.addEventListener('change', updatePriceSummary);
  transcriptCb.addEventListener('change', updatePriceSummary);

  // ---- Upload
  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', (e)=>{e.preventDefault(); uploadArea.classList.add('dragover');});
  uploadArea.addEventListener('dragleave', ()=> uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e)=>{
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e)=>{ if (e.target.files.length) handleFile(e.target.files[0]); });

  document.getElementById('removeFile').addEventListener('click', () => {
    fileInput.value = '';
    fileInfo.style.display = 'none';
    jobId = null;
    tier = null;
    setActive(1);
    updatePriceSummary();
  });

  async function handleFile(file) {
    hideError();
    downloadSection.style.display = 'none';
    setActive(1);
    processBtn.disabled = true;
    processBtn.innerHTML = '<span class="loading"></span> Uploading...';

    // quick mime/size guard
    const allowed = ['video/mp4','video/quicktime','video/x-matroska','video/x-msvideo'];
    if (!allowed.includes(file.type)) { showError('Please upload MP4, MOV, AVI or MKV'); return; }
    if (file.size > 2*1024*1024*1024) { showError('File exceeds 2GB limit'); return; }

    // optimistic UI
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = fmtSize(file.size);
    fileDurEl.textContent  = '...';
    fileInfo.style.display = 'flex';

    // upload
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await fetch('/upload', { method: 'POST', body: fd });
      if (!r.ok) { throw new Error((await r.json()).detail || 'Upload failed'); }
      const data = await r.json();
      jobId = data.job_id;
      tier  = data.tier;
      fileSizeEl.textContent = fmtSize(data.size_bytes);
      fileDurEl.textContent  = fmtDur(data.duration_sec);
      setActive(2);
      processBtn.disabled = false;
      processBtn.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
      updatePriceSummary();               // tier is now known -> pricing updates correctly
    } catch (e) {
      console.error(e);
      showError(e.message || 'Upload failed');
      processBtn.disabled = false;
      processBtn.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  }

  // ---- Pay (Stripe redirect)
  processBtn.addEventListener('click', async () => {
    hideError();
    if (!fileInput.files.length) { showError('Please upload a video file'); return; }
    if (!agreeCb.checked) { showError('You must agree to the Terms & Conditions'); return; }
    if (!jobId) { showError('File validation failed'); return; }

    processBtn.disabled = true;
    processBtn.innerHTML = '<span class="loading"></span> Redirecting to Stripe...';

    const fd = new FormData();
    fd.append('job_id', jobId);
    fd.append('provider', selectedProvider);
    fd.append('priority', priorityCb.checked);
    fd.append('transcript', transcriptCb.checked);
    fd.append('email', emailInput.value || '');

    try {
      const r = await fetch('/checkout', { method: 'POST', body: fd });
      if (!r.ok) { throw new Error((await r.json()).detail || 'Checkout failed'); }
      const data = await r.json();
      if (data.checkout_url) window.location.href = data.checkout_url;
      else throw new Error('No checkout URL returned');
    } catch (e) {
      showError(e.message || 'Checkout failed');
      processBtn.disabled = false;
      processBtn.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  });

  // ---- Return from Stripe? Attach SSE
  (function resumeIfPaid(){
    const p  = new URLSearchParams(window.location.search);
    const ok = p.get('paid');
    const id = p.get('job_id');
    if (ok === '1' && id) { jobId = id; startSSE(id); }
  })();
});
