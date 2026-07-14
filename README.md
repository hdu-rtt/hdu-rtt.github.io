# EBCI RAG Knowledge Admin

This static page opens the same-origin management UI hosted by the EBCI Agent service.

Usage:

1. Open the page from GitHub Pages or directly from `index.html`.
2. Enter the deployed Agent base URL.
3. The browser opens `/admin/knowledge` on that service.
4. Enter the access credential there, then upload files, watch document status, and run retrieval tests.

The static page does not call the management APIs directly. This avoids browser cross-origin preflight restrictions for protected API requests.
