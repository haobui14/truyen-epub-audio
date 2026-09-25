# Cloudflare R2 migration

Supabase remains the PostgreSQL/PostgREST provider. Only object storage moves
to R2.

## 1. Create the R2 resources

Create two buckets in the same Cloudflare account:

- `truyen-media`: public `audio/` and `covers/` objects.
- `truyen-private`: private `chapter-text/` and `epub-uploads/` objects.

Attach a custom domain such as `media.example.com` **only** to
`truyen-media`. Do not enable public access on `truyen-private`. The temporary
`r2.dev` URL is not suitable for production traffic.

Create an R2 API token with Object Read & Write permission for both buckets.
Record its access-key ID, secret key, and the account S3 endpoint shown by
Cloudflare.

The web app fetches cover bytes for offline use, so add a CORS rule to the
public bucket allowing `GET` and `HEAD` from the production frontend origin,
`http://localhost:3000`, and the origins used by the Capacitor build. No browser
write permission is needed; uploads go through the backend.

## 2. Configure the applications

Backend/Railway variables:

```dotenv
R2_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_PUBLIC_BUCKET_NAME=truyen-media
R2_PRIVATE_BUCKET_NAME=truyen-private
R2_PUBLIC_URL=https://media.example.com
```

Frontend/Vercel build variable:

```dotenv
NEXT_PUBLIC_MEDIA_URL=https://media.example.com
```

Deploy the frontend first. It accepts both old Supabase URLs and new R2 URLs,
which keeps covers working during cutover.

## 3. Copy and cut over

From `backend/`, with both Supabase and R2 credentials in `.env`:

```powershell
python -m scripts.migrate_supabase_storage_to_r2
python -m scripts.migrate_supabase_storage_to_r2 --apply --skip-url-update
```

The first command only inventories the source. The applied command copies and
verifies objects while leaving existing public URLs unchanged. Existing
Supabase objects are retained.

After deploying the R2-aware frontend and backend, prevent writes briefly and
run the final incremental sync and URL cutover:

```powershell
python -m scripts.migrate_supabase_storage_to_r2 --apply
```

Same-sized objects already in R2 are skipped. Existing `cover_url` and
`audio_url` rows change only if every selected object copy succeeds.

Prevent uploads and chapter edits during the applied migration. Otherwise, a
write can reach Supabase after that prefix has been copied. Deploy the new
backend immediately after the migration completes.

## 4. Verify before removing Supabase files

- Open several books and confirm their covers load from the media domain.
- Open old and recently edited chapters to verify private R2 reads.
- Reparse one book to verify private original-file downloads.
- Upload and delete a temporary book to exercise uploads, listing, and cleanup.
- Run `python -m scripts.backup_all --skip-db --buckets chapter-text covers`.

Keep the Supabase objects until the new deployment has been stable long enough
for rollback. Deleting the old copies is a separate, intentionally manual step.
