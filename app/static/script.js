// app/static/script.js
// Frontend for MailSized – upload -> price -> Stripe -> progress -> download.

window._mailsizedVersion = 'v5-provider-pricing';
console.log('MailSized script version:', window._mailsizedVersion);

document.addEventListener('DOMContentLoaded', function () {
  // ---- Elements
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

  // Sidebar price labels
  const basePriceEl = document.getElementById('basePrice');
  const priorityPriceEl = document.getElementById('priorityPrice');
  const transcriptPriceEl = document.getElementById('transcriptPrice');
  const taxAmountEl = document.getElementById('taxAmount');
  const totalAmountEl = document.getElementById('totalAmount');

  // ---- State
  let selectedProvider = 'gmail';
  let currentTier = null;         // 1..3 from /upload
  let jobId = null;
  let eventSource = null;

  // Provider-specific base prices by tier
  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };

  // ---- Helpers
  function showError(msg) {
    errorMessage.textContent = msg || 'Something went wrong';
    errorContainer.style.display = 'block';
    errorContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function hideError() {
    errorContainer.style.display = 'none';
    errorMessage.textContent = '';
  }
  function enablePayButton(enable) { processButton.disabled = !enable; }
  function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(1) + ' GB';
  }
  function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs} min`;
  }
  function getQueryParam(name) {
    const params = new URLSearchParams(window.location.search);
    return params.get(name);
  }

  // Compute and paint sidebar totals
  function updatePriceSummary() {
    if (!currentTier) {
      // Nothing uploaded yet — keep zeros
      basePriceEl.textContent = `$0.00`;
      priorityPriceEl.textContent = `$${priorityCheckbox.checked ? 0.75 : 0.00}`;
      transcriptPriceEl.textContent = `$${transcriptCheckbox.checked ? 1.50 : 0.00}`;
      taxAmountEl.textContent = `$0.00`;
      totalAmountEl.textContent = `$0.00`;
      return;
    }
    const base = PROVIDER_PRICING[selectedProvider][currentTier - 1];
    const priority = priorityCheckbox.checked ? 0.75 : 0;
    const transcript = transcriptCheckbox.checked ? 1.50 : 0;
    const subtotal = base + priority + transcript;
    const tax = subtotal * 0.10; // UI estimate only
    const total = subtotal + tax;

    basePriceEl.textContent = `$${base.toFixed(2)}`;
    priorityPriceEl.textContent = `$${priority.toFixed(2)}`;
    transcriptPriceEl.textContent = `$${transcript.toFixed(2)}`;
    taxAmountEl.textContent = `$${tax.toFixed(2)}`;
    totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }

  function setActiveStep(step) {
    ['step1','step2','step3','step4'].forEach((id, idx) => {
      const el = document.getElementById(id);
      if (!el) return;
      if (idx < step) el.classList.add('active');
      else el.classList.remove('active');
    });
  }

  function startSSE(jobId) {
    if (eventSource) try { eventSource.close(); } catch {}
    setActiveStep(3);
    eventSource = new EventSource(`/events/${jobId}`);
    eventSource.onmessage = (ev) => {
      const payload = JSON.parse(ev.data || '{}');
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
        showError('An error occurred while processing your video.');
        processButton.innerHTML = '<i class="fas fa-times"></i> Error';
        processButton.disabled = false;
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
      updatePriceSummary();
    });
  });
  priorityCheckbox.addEventListener('change', updatePriceSummary);
  transcriptCheckbox.addEventListener('change', updatePriceSummary);

  // ---- Upload handlers
  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', (e) => { if (e.target.files.length) handleFile(e.target.files[0]); });

  removeFileBtn.addEventListener('click', () => {
    fileInput.value = '';
    fileInfo.style.display = 'none';
    jobId = null;
    currentTier = null;
    updatePriceSummary();
    setActiveStep(1);
  });

  async function handleFile(file) {
    hideError();
    downloadSection.style.display = 'none';

    // basic client validation
    const allowed = ['video/mp4','video/quicktime','video/x-matroska','video/x-msvideo'];
    if (!allowed.includes(file.type)) return showError('Please upload a video file (MP4, MOV, AVI, MKV)');
    if (file.size > 2 * 1024 * 1024 * 1024) return showError('File size exceeds maximum limit of 2GB');

    // show immediately
    fileNameEl.textContent = file.name;
    fileSizeEl.textContent = formatFileSize(file.size);
    fileDurationEl.textContent = '...';
    fileInfo.style.display = 'flex';

    setActiveStep(1);
    enablePayButton(false);
    processButton.innerHTML = '<span class="loading"></span> Uploading...';

    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/upload', { method: 'POST', body: fd });
      if (!resp.ok) {
        let m = 'Upload failed';
        try { const j = await resp.json(); m = j.detail || m; } catch {}
        throw new Error(m);
      }
      const data = await resp.json();
      console.log('UPLOAD_DATA', data);

      jobId = data.job_id;
      currentTier = Number(data.tier);

      // paint server‑measured size/duration
      fileSizeEl.textContent = formatFileSize(data.size_bytes);
      fileDurationEl.textContent = formatDuration(data.duration_sec);

      setActiveStep(2);
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
      enablePayButton(true);

      // recalc prices with tier now known
      updatePriceSummary();
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
      enablePayButton(true);
    }
  }

  // ---- Stripe Redirect
  processButton.addEventListener('click', async () => {
    hideError();
    if (!fileInput.files.length) return showError('Please upload a video file');
    if (!agreeCheckbox.checked) return showError('You must agree to the Terms & Conditions');
    if (!jobId || !currentTier) return showError('File validation failed');

    enablePayButton(false);
    processButton.innerHTML = '<span class="loading"></span> Redirecting to Stripe...';

    const fd = new FormData();
    fd.append('job_id', jobId);
    fd.append('provider', selectedProvider);
    fd.append('priority', String(priorityCheckbox.checked));
    fd.append('transcript', String(transcriptCheckbox.checked));
    fd.append('email', emailInput.value || '');

    try {
      const resp = await fetch('/checkout', { method: 'POST', body: fd });
      if (!resp.ok) {
        let m = 'Checkout failed';
        try { const j = await resp.json(); m = j.detail || m; } catch {}
        throw new Error(m);
      }
      const data = await resp.json();
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else {
        showError('No checkout URL returned');
        processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
        enablePayButton(true);
      }
    } catch (err) {
      console.error(err);
      showError(err.message || String(err));
      processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
      enablePayButton(true);
    }
  });

  // ---- Auto resume after Stripe
  (function resumeIfPaid() {
    const paid = getQueryParam('paid');
    const jid = getQueryParam('job_id');
    if (paid === '1' && jid) {
      jobId = jid;
      setActiveStep(3);
      startSSE(jid);
    }
  })();

  // Initial paint
  updatePriceSummary();
});
