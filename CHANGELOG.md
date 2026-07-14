# Changelog

## 1.2.0 - 2026-07-14

- Added on-demand scanning for existing PDF attachments.
- Added automatic duplicate checks for newly added PDFs.
- Used Zotero's stored MD5 as a candidate index and SHA-256 as the final duplicate criterion.
- Kept hashing responsive with asynchronous 1 MiB reads and per-read timeouts.
- Fixed an empty-queue loop that could block the Zotero main thread.
- Fixed historical scans failing on relative `storage:` attachment paths.
- Recovered uniquely identifiable PDFs renamed by external attachment tools.
- Added concise scan summaries and a duplicate-removal confirmation dialog.
- Converted the interface, logs, metadata, and documentation to English.
