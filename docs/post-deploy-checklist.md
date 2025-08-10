# Post‑Deploy Checklist for MailSized

After deploying a new version of **MailSized** to Render you should perform the following checks to ensure that the application is healthy and functioning correctly.

## 1. Confirm Service Availability

- Verify that the service is running by opening the live URL provided by Render.  You should see the upload page with the stepper UI.
- Check the Render dashboard for any build or runtime errors.  The latest deployment should have succeeded without warnings.

## 2. Health Check

- Confirm that the `/healthz` endpoint returns a JSON payload `{"status": "ok"}` with HTTP 200.  This endpoint is used by Render for health monitoring.

## 3. Upload and Pricing

- Upload a small test video (e.g. a 1 minute clip).  Ensure that the pricing table updates with the correct tier and base price after the file is uploaded.
- Test the three tiers with videos at the edges of each limit (e.g. 4 min/50 MB for Tier 1, 9 min/150 MB for Tier 2, 18 min/350 MB for Tier 3).  Reject files >20 min or >2 GB gracefully.

## 4. Checkout and Payment

- Initiate a checkout using Stripe test mode.  Verify that the Checkout page loads and that you can complete the payment using a test card number (e.g. `4242 4242 4242 4242`).  The UI should proceed to the Compression step once payment is confirmed.

## 5. Server‑Sent Events

- During compression watch the stepper and ensure that it advances through the Processing, Compressing and Finalizing states.  The SSE connection should remain open and update without manual refreshes.

## 6. Download Link and Email

- Once compression is done the Download button should appear.  Clicking it should download the compressed file successfully.
- If you entered an email address, verify that the email arrives with the `Auto-Submitted`, `X-Auto-Response-Suppress` and `Reply-To` headers set as specified.  Check the spam folder if it does not appear in the inbox.

## 7. Link Expiry

- Wait until the configured TTL (default 30 minutes) has passed and attempt to use the download link again.  The request should respond with HTTP 410 Gone, indicating that the link has expired.

## 8. Logs and Cleanup

- Inspect the service logs for any unexpected warnings or errors during the above steps.
- Verify that temporary files are removed after the TTL expires and that the `temp_uploads` directory remains tidy.

## 9. AdSense (Optional)

- If `ENABLE_ADSENSE` and `CONSENT_GIVEN` are set to `true` and `ADSENSE_CLIENT_ID` is configured, verify that ads appear in the designated placeholder areas without causing layout shifts.
- When ads are disabled or consent is not given, confirm that the placeholders remain empty and the layout is unaffected.