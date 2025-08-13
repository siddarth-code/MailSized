/* MailSized front-end – v6-robust */

(() => {
  const $ = (id) => document.getElementById(id);
  const qs = (sel, root = document) => root.querySelector(sel);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const safeSet = (id, text) => {
    const el = $(id);
    if (el) el.textContent = text;
  };
  const show = (id) => { const el = $(id); if (el) el.style.display = ''; };
  const hide = (id) => { const el = $(id); if (el) el.style.display = 'none'; };

  // Version log so we know which JS is running
  console.log('Mailsized script version: v6-progress');

  // --- State ---
  let JOB = null;            // { job_id, tier, price, duration_sec, size_bytes, max_size_mb, ... }
  let PROVIDER = 'gmail';    // gmail | outlook | other

  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.99],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49]
  };

  // --- UI helpers ---
  function setError(msg) {
    const box = $('errorContainer');
    const msgEl = $('errorMessage');
    if (msgEl) msgEl.textContent = msg || '';
    if (box) box.style.display = msg ? '' : 'none';
  }

  function setStep(active) {
    ['step1','step2','step3','step4'].forEach((id, idx) => {
      const el = $(id); if (!el) return;
      if (idx === active - 1) el.classList.add('active');
      else el.classList.remove('active');
    });
  }

  function humanBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024*1024) return `${(n/1024).toFixed(1)} KB`;
    if (n < 1024*1024*1024) return `${(n/1024/1024).toFixed(1)} MB`;
    return `${(n/1024/1024/1024).toFixed(2)} GB`;
  }

  function humanTime(sec) {
    const m = Math.floor(sec/60), s = Math.round(sec%60);
    return `${m}m ${s}s`;
  }

  // Price box
  function calcTotals() {
    // guard if upload hasn't happened yet
    if (!JOB) { 
      safeSet('basePrice', '$0.00');
      safeSet('priorityPrice', '$0.00');
      safeSet('transcriptPrice', '$0.00');
      safeSet('taxAmount', '$0.00');
      safeSet('totalAmount', '$0.00');
      return;
    }
    const tier = Number(JOB.tier) || 1;
    const base = PROVIDER_PRICING[PROVIDER][tier - 1] || 0;
    const priority = $('priority')?.checked ? 0.75 : 0.0;
    const transcript = $('transcript')?.checked ? 1.50 : 0.0;
    const subtotal = base + priority + transcript;
    const tax = +(subtotal * 0.10).toFixed(2);
    const total = +(subtotal + tax).toFixed(2);

    safeSet('basePrice', `$${base.toFixed(2)}`);
    safeSet('priorityPrice', `$${priority.toFixed(2)}`);
    safeSet('transcriptPrice', `$${transcript.toFixed(2)}`);
    safeSet('taxAmount', `$${tax.toFixed(2)}`);
    safeSet('totalAmount', `$${total.toFixed(2)}`);
  }

  // Progress
  function setProgress(pct, text) {
    const bar = $('progressBar');
    const label = $('progressText');
    if (bar) bar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
    if (label) label.textContent = text || `${pct}%`;
  }

  // --- Event wiring ---
  document.addEventListener('DOMContentLoaded', () => {
    // upload
    const uploadArea = $('uploadArea');
    const fileInput = $('fileInput');
    const removeFile = $('removeFile');

    if (uploadArea && fileInput) {
      uploadArea.addEventListener('click', () => fileInput.click());
      uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('drag'); });
      uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag'));
      uploadArea.addEventListener('drop', (e) => {
        e.preventDefault(); uploadArea.classList.remove('drag');
        if (e.dataTransfer.files.length) {
          fileInput.files = e.dataTransfer.files;
          doUpload(fileInput.files[0]).catch(() => {});
        }
      });
      fileInput.addEventListener('change', () => {
        if (fileInput.files?.length) doUpload(fileInput.files[0]).catch(() => {});
      });
    }

    if (removeFile) {
      removeFile.addEventListener('click', () => {
        $('fileInfo')?.style && ( $('fileInfo').style.display = 'none' );
        $('fileName') && ( $('fileName').textContent = '' );
        $('fileSize') && ( $('fileSize').textContent = '' );
        $('fileDuration') && ( $('fileDuration').textContent = '' );
        fileInput && (fileInput.value = '');
        JOB = null;
        calcTotals();
      });
    }

    // providers
    qsa('.provider-card').forEach(card => {
      card.addEventListener('click', () => {
        qsa('.provider-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        PROVIDER = card.getAttribute('data-provider') || 'gmail';
        calcTotals();
      });
    });

    // extras
    $('priority')?.addEventListener('change', calcTotals);
    $('transcript')?.addEventListener('change', calcTotals);

    // pay
    $('processButton')?.addEventListener('click', onPay);

    // if returning from Stripe
    const params = new URLSearchParams(location.search);
    if (params.get('paid') === '1' && params.get('job_id')) {
      setStep(3);
      show('progressContainer');
      listenEvents(params.get('job_id'));
    }

    // initial prices
    calcTotals();
  });

  // --- Network actions ---
  async function doUpload(file) {
    setError('');
    if (!file) return;

    setStep(1);
    setProgress(2, 'Uploading…');

    const fd = new FormData();
    fd.append('file', file);

    const res = await fetch('/upload', { method: 'POST', body: fd });
    if (!res.ok) {
      setError('Upload failed. Please try a smaller file or another format.');
      throw new Error('upload failed');
    }

    const data = await res.json();
    JOB = data; // includes job_id, tier, duration_sec, size_bytes, price, etc.

    // show file info
    $('fileInfo') && ( $('fileInfo').style.display = '' );
    $('fileName') && ( $('fileName').textContent = file.name );
    $('fileSize') && ( $('fileSize').textContent = `${humanBytes(data.size_bytes)}` );
    $('fileDuration') && ( $('fileDuration').textContent = ` • ${humanTime(data.duration_sec)}` );

    calcTotals();
    setError('');
  }

  async function onPay() {
    setError('');

    if (!JOB?.job_id) { setError('Please upload a video first.'); return; }
    if (!$('agree')?.checked) { setError('Please accept the Terms & Conditions.'); return; }

    setStep(2);

    const fd = new FormData();
    fd.append('job_id', JOB.job_id);
    fd.append('provider', PROVIDER);
    fd.append('priority', $('priority')?.checked ? 'true' : 'false');
    fd.append('transcript', $('transcript')?.checked ? 'true' : 'false');
    fd.append('email', $('userEmail')?.value || '');

    const res = await fetch('/checkout', { method: 'POST', body: fd });
    if (!res.ok) { setError('Could not start payment.'); return; }

    const data = await res.json();
    if (data.checkout_url) {
      // Stripe hosted page
      window.location.href = data.checkout_url;
    } else {
      setError('Could not start payment.');
    }
  }

  function listenEvents(jobId) {
    try {
      const es = new EventSource(`/events/${jobId}`);
      let pct = 2;
      const tick = setInterval(() => {
        // just animate while waiting for server statuses
        pct = Math.min(98, pct + 1);
        setProgress(pct, `${pct}% — Working…`);
      }, 1200);

      es.onmessage = (ev) => {
        const data = JSON.parse(ev.data || '{}');
        if (data.status === 'processing') {
          setProgress(15, 'Preparing…');
        } else if (data.status === 'compressing') {
          setProgress(50, 'Compressing…');
        } else if (data.status === 'finalizing') {
          setProgress(90, 'Finalizing…');
        } else if (data.status === 'done') {
          clearInterval(tick);
          setProgress(100, 'Done!');
          setStep(4);
          if (data.download_url) {
            show('downloadSection');
            const a = $('downloadLink');
            if (a) a.href = data.download_url;
          }
          es.close();
        } else if (data.status === 'error') {
          clearInterval(tick);
          setError('An error occurred during processing.');
          es.close();
        }
      };

      es.onerror = () => {
        // If the connection drops (e.g., 502 while server recycling), keep the UI alive
        console.warn('SSE error; will keep animating until page refresh.');
      };

      show('progressContainer');
    } catch (e) {
      console.warn('SSE init failed', e);
    }
  }
})();
