// MailSized client script: upload -> pricing -> Stripe -> SSE -> download
window._mailsizedVersion = 'v-ui-price-cap-ffmpeg';
document.addEventListener('DOMContentLoaded', function() {
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileNameEl = document.getElementById('fileName');
  const fileSizeEl = document.getElementById('fileSize');
  const fileDurationEl = document.getElementById('fileDuration');
  const removeFileBtn = document.getElementById('removeFile');

  const providerCards = document.querySelectorAll('.provider-card');
  const priorityCheckbox = document.getElementById('priority');
  const transcriptCheckbox = document.getElementById('transcript');
  const agreeCheckbox = document.getElementById('agree');
  const emailInput = document.getElementById('userEmail');
  const processButton = document.getElementById('processButton');

  const errorContainer = document.getElementById('errorContainer');
  const errorMessage = document.getElementById('errorMessage');

  const downloadSection = document.getElementById('downloadSection');
  const downloadLink = document.getElementById('downloadLink');

  const basePriceEl = document.getElementById('basePrice');
  const priorityPriceEl = document.getElementById('priorityPrice');
  const transcriptPriceEl = document.getElementById('transcriptPrice');
  const taxAmountEl = document.getElementById('taxAmount');
  const totalAmountEl = document.getElementById('totalAmount');

  // (Optional) cells to show max size for provider
  const pricingTable = document.querySelector('.pricing-table');

  // Stepper
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const step4 = document.getElementById('step4');

  // Server state
  let jobId = null;
  let serverTier = 1;           // set after /upload
  let serverBasePrice = 1.99;   // gmail base (we swap per provider)
  let eventSource = null;

  // Provider price tables (per tier 1..3)
  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };
  const PROVIDER_CAPS_MB = { gmail: 25, outlook: 20, other: 15 };

  let selectedProvider = 'gmail';

  function resetSteps() {
    [step1,step2,step3,step4].forEach(s => s.classList.remove('active'));
  }
  function setActiveStep(n) {
    resetSteps();
    if (n >= 1) step1.classList.add('active');
    if (n >= 2) step2.classList.add('active');
    if (n >= 3) step3.classList.add('active');
    if (n >= 4) step4.classList.add('active');
  }
  function showError(msg) {
    errorMessage.textContent = msg || 'Something went wrong';
    errorContainer.style.display = 'block';
  }
  function hideError() {
    errorContainer.style.display = 'none';
    errorMessage.textContent = '';
  }
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes/1048576).toFixed(1) + ' MB';
    return (bytes/1073741824).toFixed(1) + ' GB';
  }
  function fmtDur(seconds) {
    const m = Math.floor(seconds/60);
    const s = Math.floor(seconds%60);
    return `${m}:${s<10?'0':''}${s} min`;
  }

  function uiRecalc() {
    // base from provider + tier
    const prices = PROVIDER_PRICING[selectedProvider];
    const base = prices ? prices[Math.max(1, serverTier)-1] : serverBasePrice;

    const priority = priorityCheckbox.checked ? 0.75 : 0;
    const transcript = transcriptCheckbox.checked ? 1.50 : 0;
    const subtotal = base + priority + transcript;

    // If you don’t want tax in UI, set to 0
    const tax = subtotal * 0.10;
    const total = subtotal + tax;

    if (basePriceEl)      basePriceEl.textContent = `$${base.toFixed(2)}`;
    if (priorityPriceEl)  priorityPriceEl.textContent = `$${priority.toFixed(2)}`;
    if (transcriptPriceEl)transcriptPriceEl.textContent = `$${transcript.toFixed(2)}`;
    if (taxAmountEl)      taxAmountEl.textContent = `$${tax.toFixed(2)}`;
    if (totalAmountEl)    totalAmountEl.textContent = `$${total.toFixed(2)}`;

    // Highlight provider cap row in table (optional visual aid)
    if (pricingTable) {
      // nothing structural to change; table is static. If you want,
      // you can show the selected cap in a small hint:
      const hintId = 'provider-cap-hint';
      let hint = document.getElementById(hintId);
      if (!hint) {
        hint = document.createElement('div');
        hint.id = hintId;
        hint.style.marginTop = '6px';
        hint.style.fontSize = '0.9rem';
        pricingTable.parentElement.appendChild(hint);
      }
      hint.textContent = `Selected provider: ${selectedProvider} • target ≤ ${PROVIDER_CAPS_MB[selectedProvider]} MB`;
    }
  }

  // Provider switching
  providerCards.forEach(card => {
    card.addEventListener('click', () => {
      providerCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedProvider = card.dataset.provider;
      uiRecalc();
    });
  });
  priorityCheckbox.addEventListener('change', uiRecalc);
  transcriptCheckbox.addEventListener('change', uiRecalc);

  // Upload interactions
  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', e => {
    e.preventDefault(); uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', e => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });
  removeFileBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInfo.style.display = 'none';
    jobId = null;
    serverTier = 1;
    serverBasePrice = 1.99;
    uiRecalc();
    setActiveStep(1);
  });

  async function handleFile(file) {
    hideError();
    downloadSection.style.display = 'none';
    setActiveStep(1);
    processButton.disabled = true;
    processButton.innerHTML = '<span class="loading"></span> Uploading...';

    const okTypes = ['video/mp4','video/quicktime','video/x-matroska','video/x-msvideo'];
    if (!okTypes.includes(file.type)) { showError('Please upload MP4/MOV/MKV/AVI'); processButton.disabled=false; return; }

    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/upload', { method:'POST', body: fd });
      if (!resp.ok) {
        let msg = 'Upload failed';
        try { const j = await resp.json(); msg = j.detail || msg; } catch {}
        throw new Error(msg);
      }
      const data = await resp.json();
      jobId = data.job_id;
      serverTier = data.tier || 1;
      serverBasePrice = data.price || 1.99;

      fileNameEl.textContent = file.name;
      fileSizeEl.textContent = fmtSize(data.size_bytes);
      fileDurationEl.textContent = fmtDur(data.duration_sec);
      fileInfo.style.display = 'flex';

      setActiveStep(2);
      uiRecalc();
      processButton.disabled = false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    } catch (e) {
      console.error(e);
      showError(e.message);
      processButton.disabled = false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  }

  // Stripe checkout
  processButton.addEventListener('click', async () => {
    hideError();
    if (!fileInput.files.length) { showError('Please upload a video'); return; }
    if (!agreeCheckbox.checked) { showError('Please accept the Terms & Conditions'); return; }
    if (!jobId) { showError('File validation failed'); return; }

    processButton.disabled = true;
    processButton.innerHTML = '<span class="loading"></span> Redirecting...';

    const fd = new FormData();
    fd.append('job_id', jobId);
    fd.append('provider', selectedProvider);
    fd.append('priority', priorityCheckbox.checked);
    fd.append('transcript', transcriptCheckbox.checked);
    fd.append('email', emailInput.value || '');

    try {
      const resp = await fetch('/checkout', { method:'POST', body: fd });
      if (!resp.ok) {
        let msg = 'Checkout failed';
        try { const j = await resp.json(); msg = j.detail || msg; } catch {}
        throw new Error(msg);
      }
      const data = await resp.json();
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else {
        showError('No checkout URL returned');
      }
    } catch (e) {
      console.error(e);
      showError(e.message);
      processButton.disabled = false;
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  });

  // Resume after Stripe (?paid=1&job_id=...)
  (function resumeIfPaid() {
    const qs = new URLSearchParams(window.location.search);
    const paid = qs.get('paid');
    const jid  = qs.get('job_id');
    if (paid === '1' && jid) {
      jobId = jid;
      setActiveStep(3);
      if (eventSource) try { eventSource.close(); } catch(_) {}
      eventSource = new EventSource(`/events/${jid}`);
      eventSource.onmessage = (ev) => {
        const payload = JSON.parse(ev.data);
        const s = payload.status;
        if (s === 'processing' || s === 'compressing' || s === 'finalizing') {
          setActiveStep(3);
        } else if (s === 'done') {
          setActiveStep(4);
          if (payload.download_url) {
            downloadLink.href = payload.download_url;
            downloadSection.style.display = 'block';
          }
          processButton.innerHTML = '<i class="fas fa-check"></i> Completed';
          processButton.disabled = true;
          eventSource.close();
        } else if (s === 'error') {
          showError('An error occurred during processing');
          processButton.innerHTML = '<i class="fas fa-times"></i> Error';
          processButton.disabled = false;
          eventSource.close();
        }
      };
    }
  })();

  // Initial totals for default Gmail selection
  uiRecalc();
});
