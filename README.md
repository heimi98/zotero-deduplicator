# PDF Deduplicator for Zotero 9 and 10

PDF Deduplicator detects byte-identical PDF attachments in Zotero 9.x and 10.0.x, including Zotero 10.0.7. It uses the full-file SHA-256 hash as the final duplicate criterion and always asks for confirmation before moving anything to the Zotero trash.

## Features

- Monitors newly added PDF attachments automatically.
- Scans older PDFs on demand from **Tools -> Scan Existing PDFs...**.
- Does not scan the entire library during Zotero startup.
- Compares PDFs only within the same Zotero library.
- Ignores filenames and bibliographic metadata when deciding whether files are duplicates.
- Keeps the parent bibliographic item by default and removes only the duplicate PDF attachment.
- Optionally removes the entire parent item, including its other attachments, notes, and annotations.
- Moves removed items to the Zotero trash instead of deleting them permanently.
- Keeps both items without making changes when the user cancels.

## Duplicate definition

Two PDFs are duplicates only when their complete file bytes have the same SHA-256 hash. Different filenames do not matter. PDFs that look the same but were re-saved, re-compressed, OCR-processed, annotated, or had metadata rewritten are not byte-identical and therefore are not treated as duplicates.

Zotero's stored MD5 value is used only as a fast candidate index. Every candidate pair is verified with SHA-256 before the confirmation dialog appears.

## Installation

1. Download `zotero-pdf-deduplicator.xpi` from the [latest release](https://github.com/heimi98/zotero-deduplicator/releases/latest).
2. Open Zotero 9 or 10.0.
3. Open **Tools -> Plugins**.
4. Use the gear menu and choose **Install Plugin From File...**.
5. Select the downloaded XPI file and restart Zotero if prompted.

If Zotero disabled version 1.2.0 after upgrading to Zotero 10, check for plugin updates from the gear menu or install the latest XPI over the existing plugin.

## Usage

New PDF attachments are checked automatically after Zotero finishes adding them. To scan PDFs that were already in the library before installation, choose **Tools -> Scan Existing PDFs...**.

The historical scan reads attachment rows in batches. Zotero's stored MD5 value narrows the candidate set, and only candidates are read again for final SHA-256 verification. Hashing uses asynchronous 1 MiB chunks so the Zotero interface remains responsive.

If an external attachment-renaming tool changes a stored filename without updating Zotero's database, the scanner recovers the file when its storage directory contains exactly one PDF. It skips the attachment rather than guessing when the file cannot be identified uniquely.

## Build

Requirements:

- Node.js
- Python 3

```bash
npm run check
npm run build
```

The packaged extension is written to `dist/zotero-pdf-deduplicator.xpi`.

The build uses fixed ZIP metadata so its SHA-256 is identical on local machines and GitHub Actions. To publish, run **Actions -> Publish XPI -> Run workflow** with the version tag. The manual workflow verifies that the tag contains the same plugin source, checks the package against `update.json`, and uploads the XPI to GitHub Releases.

## Safety and limitations

- Historical scanning is manual and can be repeated after unavailable files are downloaded or restored.
- Linked files with broken paths and files that are not available locally are skipped.
- A single file read is abandoned after 30 seconds so an abnormal file cannot block the entire scan.
- A library or item must be editable before the plugin can move it to the trash.
- The plugin targets Zotero 9.x and 10.0.x.

## License

[MIT](LICENSE)
