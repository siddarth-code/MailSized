# Operations Runbook for MailSized

This runbook describes the day‑to‑day operational procedures for managing the **MailSized** service in production.  It includes guidelines for monitoring, troubleshooting, re‑running jobs, handling refunds and performing routine maintenance.

## Logging and Monitoring

- **Application logs** – The FastAPI app logs informational messages and warnings to stdout.  When deployed on Render these are available in the service’s logs tab.  Look for `INFO` messages to track job progression and `WARNING` or `ERROR` messages to identify potential issues.
- **Health checks** – Render periodically polls the `/healthz` endpoint.  A non‑`200` response will trigger an alert and may cause the service to be restarted.
- **Job metrics** – Each job records its status in memory (`queued`, `processing`, `compressing`, `finalizing`, `done`, `error`) along with timestamps.  These can be surfaced in future via a metrics endpoint if required.

## Job Lifecycle

1. **Upload** – A temporary file is created in the `temp_uploads` directory.  The server calculates the duration and size, then determines the appropriate pricing tier.
2. **Checkout** – The client sends a `/checkout` request with the chosen provider and upsells.  The server queues the job and immediately starts processing in the background.
3. **Processing & compression** – The job transitions through `processing`, `compressing` and `finalizing` statuses.  Any exceptions cause it to move to `error` and clients are notified.
4. **Completion** – On success the job status becomes `done`, a presigned download URL is generated, email notifications are sent (if provided) and cleanup is scheduled for `DOWNLOAD_TTL_MIN` minutes later.
5. **Cleanup** – After the TTL expires the input and output files are deleted and the job is removed from the in‑memory registry.  A log entry notes the removal.

### Re‑running a Job

Jobs cannot be reprocessed in place once cleaned up.  If a user needs to re‑compress a video they must upload and pay again.  Within the TTL window it is possible to re‑download the file as long as the download URL remains valid.

### Refunds

Refunds must be handled through the payment processor (e.g. Stripe) dashboard.  There is no automatic refund logic in the application.  If a job fails due to a service error (e.g. CloudConvert unable to compress to the target size) you may choose to issue a refund manually.  Investigate the logs to confirm the failure reason before processing the refund.

### Email Deliverability Issues

If users report not receiving emails:

1. If using Mailgun, verify that `MAILGUN_API_KEY` and `MAILGUN_DOMAIN` are correctly configured.  The sender address (`SENDER_EMAIL`) must be authorised in your Mailgun account and SPF/DKIM records must be set up.
2. If Mailgun variables are not set, ensure that SMTP credentials (`EMAIL_SMTP_HOST`, `EMAIL_SMTP_PORT`, `EMAIL_USERNAME`, `EMAIL_PASSWORD`) are configured correctly.
3. Check the application logs for any warnings like `Failed to send email via Mailgun` or `via SMTP`, which indicate the mail sending provider encountered an error.
4. Ensure that SPF/DKIM settings for the `SENDER_EMAIL` domain are properly configured to avoid spam filtering.
5. Consider adding retries or using a more robust email service (e.g. AWS SES, SendGrid) if delivery issues persist.

## Maintenance Tasks

- **Rotate secrets** – Regularly rotate API keys (Stripe, CloudConvert) and SMTP credentials.  Update them in the Render environment settings without requiring a redeploy.
- **Update dependencies** – Periodically run `make fmt` and `make lint` locally, bump package versions in `requirements.txt`, run the test suite and deploy.
- **Monitor storage** – The `temp_uploads` directory should remain small thanks to automatic cleanup.  If it grows unexpectedly investigate jobs that may be stuck in an error state.

## Troubleshooting

1. **Uploads failing** – Check whether the file exceeds the 2 GB or 20 minute limit.  Ensure that `ffprobe` is installed and accessible in the container.
2. **Compression errors** – Inspect the logs for exceptions in the `compress_video` function.  Verify that the CloudConvert API key is valid and that the provider target sizes (Gmail 25 MB, Outlook 20 MB, Other 15 MB) are reasonable for the source video.
3. **SSE stream disconnects** – If clients stop receiving job updates verify that the Render service allows long‑lived HTTP connections and that there are no proxies terminating connections prematurely.
4. **Download expired prematurely** – Ensure `DOWNLOAD_TTL_MIN` is set correctly.  Remember that integration tests may override this variable to speed up cleanup.

## Future Enhancements

- Persist job state to a database (e.g. Redis) to allow horizontal scaling and recovery across restarts.
- Add metrics and tracing for deeper observability.
- Integrate with external file storage (e.g. S3) for scalable file handling.
- Add scheduled cleanup of leftover files in case of unexpected crashes.