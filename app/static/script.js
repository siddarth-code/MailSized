// MailSized client – provider pricing + Stripe redirect + SSE progress
console.log("MailSized script version: v6-progress");

document.addEventListener("DOMContentLoaded", () => {
  // ----- Elements -----
  const providerCards = document.querySelectorAll(".provider-card");
  const priorityCheckbox = document.getElementById("priority");
  const transcriptCheckbox = document.getElementById("transcript");
  const agreeCheckbox = document.getElementById("agree");
  const processButton = document.getElementById("processButton");

  const basePrice = document.getElementById("basePrice");
  const priorityPrice = document.getElementById("priorityPrice");
  const taxAmount = document.getElementById("taxAmount");
  const totalAmount = document.getElementById("totalAmount");

  const progressSection = document.getElementById("progressSection");
  const progressBar = document.getElementById("progressBar");
  const progressLabel = document.getElementById("progressLabel");
  const downloadSection = document.getElementById("downloadSection");
  const downloadBtn = document.getElementById("downloadBtn");

  // ----- Provider pricing -----
  const PROVIDER_PRICING = {
    gmail:   [1.99, 2.99, 4.49],
    outlook: [2.19, 3.29, 4.99],
    other:   [2.49, 3.99, 5.49],
  };

  let selectedProvider = "gmail";
  let currentJobId = null;

  // When the server returns /upload JSON we stash it here
  window.UPLOAD_DATA = window.UPLOAD_DATA || null;

  providerCards.forEach(card => {
    card.addEventListener("click", () => {
      providerCards.forEach(c => c.classList.remove("selected"));
      card.classList.add("selected");
      selectedProvider = card.dataset.provider;
      calculateTotal();
    });
  });

  priorityCheckbox?.addEventListener("change", calculateTotal);
  transcriptCheckbox?.addEventListener("change", calculateTotal);

  function calculateTotal() {
    if (!window.UPLOAD_DATA) {
      // Nothing uploaded yet; show tier-1 base for UI preview
      const basePreview = selectedProvider === "outlook" ? 2.19
                       : selectedProvider === "other"   ? 2.49
                                                         : 1.99;
      const priority = priorityCheckbox.checked ? 0.75 : 0;
      const transcript = transcriptCheckbox.checked ? 1.50 : 0;
      const subtotal = basePreview + priority + transcript;
      const tax = subtotal * 0.10;
      basePrice.textContent = `$${basePreview.toFixed(2)}`;
      priorityPrice.textContent = `$${priority.toFixed(2)}`;
      taxAmount.textContent = `$${tax.toFixed(2)}`;
      totalAmount.textContent = `$${(subtotal + tax).toFixed(2)}`;
      return;
    }

    // With a real upload, compute using the actual tier
    const tier = (window.UPLOAD_DATA.tier || 1) - 1; // 0..2
    const baseTier = PROVIDER_PRICING[selectedProvider][tier];
    const priority = priorityCheckbox.checked ? 0.75 : 0;
    const transcript = transcriptCheckbox.checked ? 1.50 : 0;
    const subtotal = baseTier + priority + transcript;
    const tax = subtotal * 0.10;

    basePrice.textContent = `$${baseTier.toFixed(2)}`;
    priorityPrice.textContent = `$${priority.toFixed(2)}`;
    taxAmount.textContent = `$${tax.toFixed(2)}`;
    totalAmount.textContent = `$${(subtotal + tax).toFixed(2)}`;
  }

  // ----- Upload flow -----
  // Minimal example: if you already have upload handlers, just ensure that after /upload
  // you set window.UPLOAD_DATA = responseJson and call calculateTotal()

  // ----- Stripe → on return show progress -----
  const url = new URL(window.location.href);
  const paid = url.searchParams.get("paid");
  const job_id = url.searchParams.get("job_id");
  if (paid === "1" && job_id) {
    currentJobId = job_id;
    showProgressUI();
    startSSE(job_id);
  }

  function showProgressUI() {
    progressSection.style.display = "block";
    downloadSection.style.display = "none";
    setProgress(0);
  }

  function setProgress(pct) {
    const clamped = Math.max(0, Math.min(100, pct|0));
    progressBar.style.width = clamped + "%";
    progressLabel.textContent = clamped + "%";
  }

  function startSSE(jid) {
    const es = new EventSource(`/events/${jid}`);
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (typeof data.progress === "number") {
          setProgress(data.progress);
        }
        if (data.status === "done" || data.status === "DONE" || data.status === "Done") {
          setProgress(100);
          es.close();
          if (data.download_url) {
            downloadSection.style.display = "block";
            progressSection.style.display = "none";
            downloadBtn.onclick = () => {
              window.location.href = data.download_url;
            };
          }
        } else if (data.status === "error") {
          es.close();
          progressLabel.textContent = "Error during processing. Please try again.";
        }
      } catch (e) {
        console.warn("Bad SSE payload", e, evt.data);
      }
    };
    es.onerror = () => {
      // Keep UI visible; SSE will reconnect automatically in most browsers
    };
  }

  // Call once at load so base price is never blank
  calculateTotal();
});
