document.addEventListener('DOMContentLoaded', function() {
    // Elements
    const uploadArea = document.getElementById('uploadArea');
    const fileInput = document.getElementById('fileInput');
    const fileInfo = document.getElementById('fileInfo');
    const fileName = document.getElementById('fileName');
    const fileSize = document.getElementById('fileSize');
    const fileDuration = document.getElementById('fileDuration');
    const removeFile = document.getElementById('removeFile');
    const providerCards = document.querySelectorAll('.provider-card');
    const processButton = document.getElementById('processButton');
    const errorContainer = document.getElementById('errorContainer');
    const errorMessage = document.getElementById('errorMessage');
    const priorityCheckbox = document.getElementById('priority');
    const transcriptCheckbox = document.getElementById('transcript');
    const agreeCheckbox = document.getElementById('agree');
    
    // Pricing elements
    const basePrice = document.getElementById('basePrice');
    const priorityPrice = document.getElementById('priorityPrice');
    const taxAmount = document.getElementById('taxAmount');
    const totalAmount = document.getElementById('totalAmount');
    
    // Initialize provider selection
    let selectedProvider = 'gmail';
    
    providerCards.forEach(card => {
        card.addEventListener('click', () => {
            providerCards.forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
            selectedProvider = card.dataset.provider;
            calculateTotal();
        });
    });
    
    // Update price when extras change
    priorityCheckbox.addEventListener('change', calculateTotal);
    transcriptCheckbox.addEventListener('change', calculateTotal);
    
    // Calculate total price
    function calculateTotal() {
        // Get base price based on provider
        let base = 1.99;
        if (selectedProvider === 'outlook') base = 2.19;
        if (selectedProvider === 'other') base = 2.49;
        
        // Get extras
        const priority = priorityCheckbox.checked ? 0.75 : 0;
        const transcript = transcriptCheckbox.checked ? 1.50 : 0;
        
        // Calculate subtotal
        const subtotal = base + priority + transcript;
        const tax = subtotal * 0.1; // 10% tax
        const total = subtotal + tax;
        
        // Update prices
        basePrice.textContent = `$${base.toFixed(2)}`;
        priorityPrice.textContent = `$${priority.toFixed(2)}`;
        taxAmount.textContent = `$${tax.toFixed(2)}`;
        totalAmount.textContent = `$${total.toFixed(2)}`;
    }
    
    // Initial calculation
    calculateTotal();
    
    // File upload handling
    uploadArea.addEventListener('click', () => {
        fileInput.click();
    });
    
    uploadArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        uploadArea.classList.add('dragover');
    });
    
    uploadArea.addEventListener('dragleave', () => {
        uploadArea.classList.remove('dragover');
    });
    
    uploadArea.addEventListener('drop', (e) => {
        e.preventDefault();
        uploadArea.classList.remove('dragover');
        
        if (e.dataTransfer.files.length) {
            handleFile(e.dataTransfer.files[0]);
        }
    });
    
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFile(e.target.files[0]);
        }
    });
    
    function handleFile(file) {
        // Reset error
        hideError();
        
        // Check if file is a video
        if (!file.type.startsWith('video/')) {
            showError('Please upload a video file (MP4, MOV, AVI, MKV)');
            return;
        }
        
        // Check file size (2GB max)
        const maxSizeGB = 2;
        const maxSizeBytes = maxSizeGB * 1024 * 1024 * 1024;
        if (file.size > maxSizeBytes) {
            showError(`File size exceeds maximum limit of ${maxSizeGB}GB`);
            return;
        }
        
        // Display file info
        fileName.textContent = file.name;
        fileSize.textContent = formatFileSize(file.size);
        
        // Simulate duration extraction
        const durationInSeconds = Math.floor(Math.random() * 1200); // Up to 20 min
        fileDuration.textContent = formatDuration(durationInSeconds);
        
        fileInfo.style.display = 'flex';
    }
    
    function formatFileSize(bytes) {
        if (bytes < 1024) return bytes + ' bytes';
        else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
        else if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
        else return (bytes / 1073741824).toFixed(1) + ' GB';
    }
    
    function formatDuration(seconds) {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs < 10 ? '0' : ''}${secs} min`;
    }
    
    removeFile.addEventListener('click', () => {
        fileInput.value = '';
        fileInfo.style.display = 'none';
    });
    
    // Process button handling
    processButton.addEventListener('click', () => {
        // Reset error
        hideError();
        
        // Validation
        if (!fileInput.files.length) {
            showError('Please upload a video file');
            return;
        }
        
        if (!agreeCheckbox.checked) {
            showError('You must agree to the Terms & Conditions');
            return;
        }
        
        // Show loading state
        processButton.innerHTML = '<span class="loading"></span> Processing...';
        processButton.disabled = true;
        
        // Simulate processing
        setTimeout(() => {
            // Success
            alert('Video compressed successfully! You will receive an email with the download link shortly.');
            
            // Reset button
            processButton.innerHTML = '<i class="fas fa-compress-alt"></i> Pay & Compress';
            processButton.disabled = false;
        }, 2000);
    });
    // Better file size formatting
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' bytes';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    else if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    else return (bytes / 1073741824).toFixed(1) + ' GB';
}

// More accurate duration formatting
function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs < 10 ? '0' : ''}${secs} min`;
}
    
    // Error handling functions
    function showError(message) {
        errorMessage.textContent = message;
        errorContainer.classList.add('show');
        
        // Scroll to error
        errorContainer.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    
    function hideError() {
        errorContainer.classList.remove('show');
    }
});