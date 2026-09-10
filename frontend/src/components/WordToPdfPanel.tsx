// frontend/src/components/WordToPdfPanel.tsx
// Client-side .docx -> PDF converter.
//
// Parses Word documents with `mammoth` (raw text extraction) and lays the
// content out into clean A4 pages with `pdf-lib`. Runs entirely in the
// renderer (works in the browser) and gates each
// conversion behind the free-trial usage policy.

import React, { useRef, useState } from 'react';
import { FileText, LoaderCircle, Play, Trash2, Upload } from 'lucide-react';
import mammoth from 'mammoth';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { sanitizeWinAnsiText } from '../lib/pdfRenderer';
import { useToast } from './toast-context';

interface WordToPdfPanelProps {
  /** Trial gate: true when the user may start a conversion. */
  canStartAction: () => boolean;
  /** Records a free-trial use once a conversion starts. */
  incrementUsage: () => void;
}

const A4_WIDTH = 595.28;
const A4_HEIGHT = 841.89;
const MARGIN = 56;
const LINE_HEIGHT = 16;
const BODY_SIZE = 11;

/** Split paragraphs into word-wrapped lines that fit the usable page width. */
function wrapLines(
  font: { widthOfTextAtSize(text: string, size: number): number },
  text: string,
  size: number,
  maxWidth: number
): string[] {
  const lines: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) lines.push(current.trim());
    current = '';
  };
  for (const word of sanitizeWinAnsiText(text).split(/\s+/)) {
    if (!word) continue;
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > maxWidth) {
      push();
      current = word;
    } else {
      current = candidate;
    }
  }
  push();
  return lines;
}

function downloadPdf(bytes: Uint8Array, fileName: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function convertDocxToPdf(file: File): Promise<void> {
  const arrayBuffer = new Uint8Array(await file.arrayBuffer()).slice().buffer;
  const result = await mammoth.extractRawText({ arrayBuffer });
  const paragraphs = (result.value ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const usableWidth = A4_WIDTH - MARGIN * 2;

  const addPage = () => pdfDoc.addPage([A4_WIDTH, A4_HEIGHT]);
  let page = addPage();
  let y = A4_HEIGHT - MARGIN;

  const ensureSpace = (lines: number) => {
    if (y - lines * LINE_HEIGHT < MARGIN) {
      page = addPage();
      y = A4_HEIGHT - MARGIN;
    }
  };

  if (paragraphs.length === 0) {
    page.drawText('This document contains no readable text.', {
      x: MARGIN,
      y,
      size: BODY_SIZE,
      font,
    });
  } else {
    for (const paragraph of paragraphs) {
      const lines = wrapLines(font, paragraph, BODY_SIZE, usableWidth);
      ensureSpace(lines.length + 1);
      for (const line of lines) {
        page.drawText(sanitizeWinAnsiText(line), { x: MARGIN, y, size: BODY_SIZE, font });
        y -= LINE_HEIGHT;
      }
      y -= LINE_HEIGHT * 0.6; // paragraph spacing
    }
  }

  const bytes = await pdfDoc.save();
  const baseName = file.name.replace(/\.docx$/i, '');
  downloadPdf(bytes, `${baseName}.pdf`);
}

export const WordToPdfPanel: React.FC<WordToPdfPanelProps> = ({
  canStartAction,
  incrementUsage,
}) => {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);

  const addFiles = (list: FileList | File[]) => {
    const incoming = Array.from(list).filter((file) =>
      file.name.toLowerCase().endsWith('.docx')
    );
    setFiles((current) => {
      const known = new Set(current.map((file) => file.name));
      return [...current, ...incoming.filter((file) => !known.has(file.name))];
    });
  };

  const convertAll = async () => {
    if (files.length === 0 || processing) return;
    if (!canStartAction()) return;
    incrementUsage();
    setProcessing(true);
    let converted = 0;
    for (const file of files) {
      try {
        await convertDocxToPdf(file);
        converted += 1;
      } catch (err) {
        toast.error(
          `Could not convert "${file.name}": ${
            err instanceof Error ? err.message : 'unknown error'
          }`
        );
      }
    }
    setProcessing(false);
    if (converted > 0) {
      toast.success(
        converted === 1
          ? 'Word document converted to PDF.'
          : `${converted} Word documents converted to PDF.`
      );
    }
  };

  return (
    <div className="space-y-4">
      <input
        ref={inputRef}
        type="file"
        accept=".docx"
        multiple
        className="hidden"
        onChange={(event) => {
          if (event.target.files) addFiles(event.target.files);
          event.target.value = '';
        }}
      />

      <div
        onDragEnter={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          if (event.dataTransfer.files) addFiles(event.dataTransfer.files);
        }}
        className={`rounded-2xl border-2 border-dashed p-6 text-center transition ${
          isDragging ? 'border-indigo-400 bg-indigo-500/10' : 'border-slate-700 bg-slate-900/60'
        }`}
      >
        <Upload className="mx-auto h-8 w-8 text-indigo-400/80" />
        <p className="mt-2 text-sm font-medium text-slate-200">
          Drag & drop .docx files here
        </p>
        <p className="mt-1 text-xs text-slate-500">or</p>
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          className="mt-2 inline-flex items-center gap-2 rounded-lg border border-indigo-500/50 px-4 py-2 text-xs font-semibold text-indigo-300 transition hover:bg-indigo-500/10"
        >
          <FileText className="h-4 w-4" /> Choose .docx files…
        </button>
      </div>

      {files.length > 0 && (
        <ul className="max-h-40 space-y-1.5 overflow-y-auto">
          {files.map((file, index) => (
            <li
              key={file.name}
              className="flex items-center gap-2 rounded-lg bg-slate-800/70 px-3 py-2 text-xs text-slate-300"
            >
              <FileText className="h-4 w-4 shrink-0 text-indigo-400" />
              <span className="flex-1 truncate">{file.name}</span>
              <button
                type="button"
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
                className="rounded p-1 text-slate-500 transition hover:bg-slate-700 hover:text-white"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void convertAll()}
        disabled={files.length === 0 || processing}
        className="flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {processing ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <Play className="h-4 w-4" />
        )}
        {processing ? 'Converting…' : 'Convert to PDF'}
      </button>

      <p className="text-xs text-slate-500">
        Text is extracted with mammoth and re-laid out onto clean A4 pages. Embedded images are
        not carried into the generated PDF.
      </p>
    </div>
  );
};

