# Luna Chat — file & image sharing

Visitors (web widget) and agents (dashboard) can share images and documents in
chat. Files are stored in **Vercel Blob** (stable public URLs) and shared over
the existing Ably channel as a `message` carrying an `attachment`
`{ url, name, contentType, size }`. Images render as inline thumbnails (click to
open full size); other files render as a download chip.

## One-time setup (required)

Link a **Vercel Blob store** to the `luna-chat-endpoint` project:
Vercel dashboard → the project → **Storage → Create / Connect → Blob**.
That automatically sets the **`BLOB_READ_WRITE_TOKEN`** env var the upload
endpoint uses. Until that's done, the upload endpoint returns `503` and the
attach button surfaces a friendly "uploads not configured" message — nothing
else breaks.

## How it works

```
pick file ─▶ (images downscaled client-side) ─▶ POST /api/upload (raw binary)
          ─▶ Vercel Blob ─▶ { url } ─▶ Ably `message` { attachment } ─▶ other side renders
```

- **`api/upload.js`** — validates type + size, stores the file in Blob, returns a
  stable public URL. Raw binary body (no base64 inflation); client verified
  against Airtable by `clientName`, like `api/conversation.js`.
- **Widget** (`public/widget-core.js`) — 📎 attach button; images are downscaled
  (canvas, max 1600px) before upload so phone photos fit; renders image/file
  attachments; persists them across navigation; sends read receipts as usual.
- **Dashboard** (`public/dashboard.html`) — the existing attach button now
  actually uploads (it was a non-functional stub) and renders attachments both
  ways.

## Limits & security

- **Max 4 MB** per file (stays under the serverless request cap). Images larger
  than that are downscaled client-side first; the widget allows picking images up
  to 15 MB and shrinks them, other files are capped at 4 MB at selection.
- **Allowed types**: JPEG, PNG, GIF, WebP, PDF, DOC/DOCX, XLS/XLSX, CSV, TXT.
  Anything else is rejected server-side (`415`).
- Filenames are sanitised (path-traversal safe, extension forced from the
  content type); each upload gets a **random suffix** so URLs are unguessable and
  nothing is overwritten; the endpoint is **rate-limited** per IP.
- The Blob store is **public-read by design** — chat attachments are shared with
  the other party, and the URLs are unguessable. Don't use it for anything that
  must stay private.

## Notes / limits

- **WhatsApp**: an agent attaching a file to a WhatsApp conversation shares the
  file **link as a text message** (native WhatsApp media send isn't wired yet).
- **AI-only chats**: a file a visitor sends appears in the agent inbox, but Luna
  doesn't "see"/respond to file contents — file sharing is aimed at the
  human/agent part of a conversation.
- Larger uploads (direct-to-Blob client uploads, which bypass the 4 MB cap) are a
  future enhancement; they need a bundled widget to use the Blob client SDK.
