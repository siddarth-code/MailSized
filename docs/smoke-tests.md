# Smoke Tests for MailSized

These smoke tests are a lightweight set of manual checks intended to quickly verify that the core functionality of **MailSized** is working in a deployed environment.  They should be executed after every deployment or environment change.

1. **Home Page** – Navigate to the root URL.  Confirm that the page loads and displays the upload card, provider selector, extras and pricing details.
2. **File Upload Validation** – Try uploading:
   - A supported video file within limits → should be accepted and pricing shown.
   - A file larger than 2 GB → should display an error.
   - A non‑video file (e.g. `.txt`) → should display an error.
3. **Pricing Calculation** – Upload videos near each tier boundary and verify the calculated price matches the tier table.
4. **Payment Flow** – Complete a checkout in Stripe test mode.  Ensure the stepper progresses from Payment to Compression.
5. **Compression Progress** – Observe the SSE updates; the progress bar should reflect the status and end at Download.
6. **Download** – Click the download link; the file should download and play correctly.
7. **Email Notification** – Provide your email; check that you receive a message with the correct headers.
8. **Link Expiry** – Attempt to download after the TTL; expect an expired link message.
9. **AdSense Placeholders** – With ads disabled the placeholders should be present but empty.  With ads enabled and consent given they should populate without shifting the layout.