// MailSized frontend (provider-based pricing + real /upload + Stripe redirect)

document.addEventListener('DOMContentLoaded', function () {
  // --- Elements ---
  const uploadArea = document.getElementById('uploadArea');
  const fileInput = document.getElementById('fileInput');
  const fileInfo = document.getElementById('fileInfo');
  const fileNameEl = document.getElementById('fileName');
  const fileSizeEl = document.getElementById('fileSize');
  const fileDurationEl = document.getElementById('fileDuration');
  const removeFile = document.getElementById('removeFile');

  const providerCards = document.querySelectorAll('.provider-card');
  const processButton = document.getElementById('processButton');

  const errorContainer = document.getElementById('errorContainer');
  const errorMessage = document.getElementById('errorMessage');

  const priorityCheckbox = document.getElementById('priority');
  const transcriptCheckbox = document.getElementById('transcript');
  const agreeCheckbox = document.getElementById('agree');
  const emailInput = document.getElementById('userEmail');

  // Optional (only used if present in your HTML)
  const basePriceEl = document.getElementById('basePrice');
  const priorityPriceEl = document.getElementById('priorityPrice');
  const transcriptPriceEl = document.getElementById('transcriptPrice');
  const taxAmountEl = document.getElementById('taxAmount');
  const totalAmountEl = document.getElementById('totalAmount');

  // Optional stepper / download elements (safe if missing)
  const step1 = document.getElementById('step1');
  const step2 = document.getElementById('step2');
  const step3 = document.getElementById('step3');
  const step4 = document.getElementById('step4');
  const downloadSection = document.getElementById('downloadSection');
  const downloadLink = document.getElementById('downloadLink');

  // --- Provider-based prices by tier (1 → index 0) ---
  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.49],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };

  // --- State ---
  let selectedProvider = 'gmail';
  let currentTier = null;       // 1, 2, or 3 (set after /upload)
  let basePrice = 0.00;         // recalculated from provider + tier
  let jobId = null;             // from /upload
  let eventSource = null;       // SSE handle

  // --- Helpers ---
  function showError(msg) {
    if (!errorContainer || !errorMessage) return alert(msg || 'Error');
    errorMessage.textContent = msg || 'Something went wrong';
    errorContainer.classList.add('show');
    errorContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function hideError() {
    if (errorContainer) errorContainer.classList.remove('show');
    if (errorMessage) errorMessage.textContent = '';
  }
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
  function setActiveStep(n) {
    // safe if stepper not present
    [step1, step2, step3, step4].forEach((el, i) => {
      if (!el) return;
      if (n >= i + 1) el.classList.add('active'); else el.classList.remove('active');
    });
  }

  // Recalculate base from provider+tier, then totals
  function recalcBaseFromProvider() {
    if (!currentTier) return;
    const list = PROVIDER_PRICING[selectedProvider] || [];
    const p = list[currentTier - 1];
    if (typeof p === 'number') basePrice = p;
  }
  function updateTotals() {
    const priority = priorityCheckbox?.checked ? 0.75 : 0;
    const transcript = transcriptCheckbox?.checked ? 1.50 : 0;
    const subtotal = basePrice + priority + transcript;
    const tax = subtotal * 0.10;
    const total = subtotal + tax;

    if (basePriceEl) basePriceEl.textContent = `$${basePrice.toFixed(2)}`;
    if (priorityPriceEl) priorityPriceEl.textContent = `$${priority.toFixed(2)}`;
    if (transcriptPriceEl) transcriptPriceEl.textContent = `$${transcript.toFixed(2)}`;
    if (taxAmountEl) taxAmountEl.textContent = `$${tax.toFixed(2)}`;
    if (totalAmountEl) totalAmountEl.textContent = `$${total.toFixed(2)}`;
  }

  function enablePay(enable) {
    if (processButton) processButton.disabled = !enable;
  }

  // --- Provider selection ---
  providerCards.forEach(card => {
    card.addEventListener('click', () => {
      providerCards.forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      selectedProvider = card.dataset.provider; // gmail | outlook | other
      recalcBaseFromProvider();
      updateTotals();
    });
  });

  // Extras change
  priorityCheckbox?.addEventListener('change', updateTotals);
  transcriptCheckbox?.addEventListener('change', updateTotals);

  // --- Upload interactions ---
  uploadArea?.addEventListener('click', () => fileInput?.click());
  uploadArea?.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea?.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea?.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput?.addEventListener('change', (e) => {
    if (e.target.files.length) handleFile(e.target.files[0]);
  });
  removeFile?.addEventListener('click', () => {
    if (fileInput) fileInput.value = '';
    if (fileInfo) fileInfo.style.display = 'none';
    jobId = null;
    currentTier = null;
    basePrice = 0.0;
    updateTotals();
    setActiveStep(1);
  });

  async function handleFile(file) {
    hideError();
    if (!file.type.startsWith('video/')) return showError('Please upload a video file (MP4, MOV, AVI, MKV)');
    const maxBytes = 2 * 1024 * 1024 * 1024;
    if (file.size > maxBytes) return showError('File size exceeds maximum limit of 2GB');

    // Show basic info while probing
    fileNameEl && (fileNameEl.textContent = file.name);
    fileSizeEl && (fileSizeEl.textContent = formatFileSize(file.size));
    fileDurationEl && (fileDurationEl.textContent = '…');
    fileInfo && (fileInfo.style.display = 'flex');
    setActiveStep(1);
    enablePay(false);
    if (processButton) processButton.innerHTML = '<span class="loading"></span> Uploading…';

    try {
      const fd = new FormData();
      fd.append('file', file);
      const resp = await fetch('/upload', { method: 'POST', body: fd });
      if (!resp.ok) {
        let err = 'Upload failed';
        try { const j = await resp.json(); err = j.detail || err; } catch {}
        throw new Error(err);
      }
      const data = await resp.json();
      // Expect: { job_id, duration_sec, size_bytes, tier, price? }
      jobId = data.job_id;
      currentTier = data.tier;

      // Update UI with probed values
      fileSizeEl && (fileSizeEl.textContent = formatFileSize(data.size_bytes ?? file.size));
      fileDurationEl && (fileDurationEl.textContent = formatDuration(data.duration_sec ?? 0));

      // Base comes from provider + tier
      recalcBaseFromProvider();
      updateTotals();

      setActiveStep(2);
      enablePay(true);
      if (processButton) processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    } catch (e) {
      showError(e.message);
      enablePay(true);
      if (processButton) processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  }

  // --- Checkout (Stripe redirect) ---
  processButton?.addEventListener('click', async () => {
    hideError();
    if (!fileInput?.files.length) return showError('Please upload a video file');
    if (!agreeCheckbox?.checked) return showError('You must agree to the Terms & Conditions');
    if (!jobId) return showError('File validation failed');

    enablePay(false);
    if (processButton) processButton.innerHTML = '<span class="loading"></span> Redirecting to Stripe…';

    const fd = new FormData();
    fd.append('job_id', jobId);
    fd.append('provider', selectedProvider);
    fd.append('priority', !!priorityCheckbox?.checked);
    fd.append('transcript', !!transcriptCheckbox?.checked);
    fd.append('email', (emailInput?.value || '').trim());

    try {
      const resp = await fetch('/checkout', { method: 'POST', body: fd });
      if (!resp.ok) {
        let err = 'Checkout failed';
        try { const j = await resp.json(); err = j.detail || err; } catch {}
        throw new Error(err);
      }
      const data = await resp.json();
      if (data.checkout_url) {
        window.location.href = data.checkout_url;
      } else {
        showError('No checkout URL returned');
        enablePay(true);
        if (processButton) processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
      }
    } catch (e) {
      showError(e.message);
      enablePay(true);
      if (processButton) processButton.innerHTML = '<i class="fas fa-credit-card"></i> Pay & Compress';
    }
  });

  // --- After Stripe: auto-attach to SSE stream ---
  (function resumeIfPaid() {
    const params = new URLSearchParams(window.location.search);
    const paid = params.get('paid');
    const jid = params.get('job_id');
    if (paid === '1' && jid) {
      jobId = jid;
      setActiveStep(3);
      // Stream server-sent events
      try {
        if (eventSource) eventSource.close();
        eventSource = new EventSource(`/events/${jid}`);
        eventSource.onmessage = function (ev) {
          const payload = JSON.parse(ev.data || '{}');
          const s = payload.status;
          if (s === 'processing' || s === 'compressing' || s === 'finalizing') {
            setActiveStep(3);
          } else if (s === 'done') {
            setActiveStep(4);
            if (payload.download_url && downloadLink && downloadSection) {
              downloadLink.href = payload.download_url;
              downloadSection.style.display = 'block';
            }
            if (processButton) {
              processButton.innerHTML = '<i class="fas fa-check"></i> Completed';
              processButton.disabled = true;
            }
            eventSource.close();
          } else if (s === 'error') {
            showError('An error occurred during processing');
            if (processButton) {
              processButton.innerHTML = '<i class="fas fa-times"></i> Error';
              processButton.disabled = false;
            }
            eventSource.close();
          }
        };
      } catch {
        // ignore
      }
    }
  })();
});
