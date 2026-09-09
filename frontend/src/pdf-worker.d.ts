// Vite `?url` import for the pdf.js worker bundle (pdfjs-dist 3.11.174).
// Vite emits the worker asset and returns its URL, which pdf.js uses as
// GlobalWorkerOptions.workerSrc — avoiding raw/Blob hacks and Electron
// file:// worker-fetch failures.
declare module 'pdfjs-dist/build/pdf.worker.min.js?url' {
  const workerUrl: string;
  export default workerUrl;
}
