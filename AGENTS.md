# Project rules

## Chrome crash prevention

Every change that touches the Chrome extension must be checked for browser-crash risk before it is considered complete.

1. Never use `webkitdirectory`, `directory` file inputs, `showDirectoryPicker()`, `FileSystemDirectoryHandle`, or direct recursive folder enumeration inside the side panel.
2. Folder selection and recursive TXT scanning must run in the local helper process. The extension may only receive filtered, serialized chapter data.
3. Keep ingestion limits in place: at most 2,000 TXT files, at most 10 MB per file, and at most 30 MB total.
4. Do not load every file into browser memory at once. Filter by the requested starting chapter before returning chapter data to Chrome.
5. Before completing any extension change, run `npm run check` and `npm run check:extension-safety`.
6. If file import or directory scanning changed, also perform a Chrome smoke test and confirm that Chrome remains alive, the scan count is correct, and the next-step button becomes available.
7. A change that reintroduces a forbidden browser directory API must not be committed or pushed.
