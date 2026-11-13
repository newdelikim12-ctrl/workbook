PDF.js / pdfjs-dist 6.5.438

Source: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.5.438.tgz
Tarball integrity (SHA-512, base64):
vg8Pw1x+AFKy4AMDvhuWl5cOYV8d698UoEANoFFhc79hqXDnZQqnOXoxw3HG907WHOg1JYOvLhP756boddFxpA==

The legacy browser module and worker are copied unchanged from the official npm
package. CMaps and standard font bytes are packed as base64 JSON chunks, indexed
by font-assets.json; their contents are unchanged. The included no-WASM JBIG2
and JPEG2000 decoders are used by PDF.js for image-based PDFs.

captures-media.js disables PDF scripting/XFA and renderer workers, uses the local
worker and decoder files, and supplies CMaps/standard fonts through a local
BinaryDataFactory. No document bytes are sent to a server or CDN. Canvas rendering
is lazy, pixel-budgeted, and released outside the viewport. Password-protected or
unreadable files show a readable error and an original-file download link.

See the LICENSE* files for PDF.js, Adobe CMaps, Foxit/Liberation fonts, JBIG2 and
OpenJPEG license notices. No source maps, sandbox scripting, or binary WASM files
are required by this integration.
