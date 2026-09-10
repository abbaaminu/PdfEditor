import React, { useRef, useState } from 'react';
import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Download,
  FilePlus,
  Highlighter,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  LoaderCircle,
  Minus,
  Palette,
  Redo2,
  Strikethrough,
  Subscript,
  Superscript,
  Table as TableIcon,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import { MAX_FREE_USES, useAuthStore } from '../store/auth-context';

type HeadingValue = 'p' | 'h1' | 'h2' | 'h3';
type HeadingKey = (typeof HeadingLevel)[keyof typeof HeadingLevel];

/** Inline run formatting accumulated while walking the DOM. */
interface RunStyle {
  bold: boolean;
  italics: boolean;
  underline: boolean;
  strike: boolean;
  subScript: boolean;
  superScript: boolean;
  font?: string;
  sizeHalf?: number;
  color?: string;
  highlightFill?: string;
}

/** Paragraph-level formatting read from the editor block element. */
interface ParaStyle {
  alignment?: (typeof AlignmentType)[keyof typeof AlignmentType];
  lineTwips?: number;
}

const HEADING_OPTIONS: { value: HeadingValue; label: string }[] = [
  { value: 'p', label: 'Normal' },
  { value: 'h1', label: 'Heading 1' },
  { value: 'h2', label: 'Heading 2' },
  { value: 'h3', label: 'Heading 3' },
];

const HEADING_LEVELS: Record<string, HeadingKey> = {
  H1: HeadingLevel.HEADING_1,
  H2: HeadingLevel.HEADING_2,
  H3: HeadingLevel.HEADING_3,
  H4: HeadingLevel.HEADING_4,
  H5: HeadingLevel.HEADING_5,
  H6: HeadingLevel.HEADING_6,
};

const FONT_FAMILIES = ['Arial', 'Times New Roman', 'Calibri', 'Courier New'];

const FONT_SIZE_POINTS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72];

const LINE_SPACINGS = [1.0, 1.15, 1.5, 2.0];

const LIST_TAGS = new Set(['UL', 'OL']);

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'BLOCKQUOTE',
  'LI',
  'SECTION',
  'ARTICLE',
  'TABLE',
  'THEAD',
  'TBODY',
  'TR',
  'TD',
  'TH',
  'HR',
  'IMG',
]);

const BLOCK_TAG_NAMES = ['P', 'DIV', 'LI', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TD', 'TH'];

const NAMED_COLORS: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  orange: 'FFA500',
  purple: '800080',
  pink: 'FFC0CB',
  gray: '808080',
  grey: '808080',
  cyan: '00FFFF',
  magenta: 'FF00FF',
};

/** CSS colour → six-digit hex without the leading "#", or undefined. */
function cssColorToHex(value: string | null | undefined): string | undefined {
  const v = String(value ?? '').trim();
  if (!v || v === 'inherit' || v === 'transparent' || v === 'auto') return undefined;
  if (v.startsWith('#')) {
    const hex = v.slice(1).toUpperCase();
    return hex.length === 3
      ? hex
          .split('')
          .map((ch) => ch + ch)
          .join('')
      : hex;
  }
  const rgb = v.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (rgb) {
    const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase();
  }
  const named = NAMED_COLORS[v.toLowerCase()];
  return named ?? undefined;
}

/** First family name of a CSS font-family value (quotes stripped). */
function fontFamilyName(value: string | null | undefined): string | undefined {
  const v = String(value ?? '').trim();
  if (!v || v === 'inherit') return undefined;
  const first = v.split(',')[0].trim();
  return first.replace(/^["']|["']$/g, '');
}

/** font-size CSS value → Word half-points (8pt = 16, 12px = 18, …). */
function fontSizeToHalfPoints(value: string | null | undefined): number | undefined {
  const v = String(value ?? '').trim();
  if (!v || v === 'inherit' || v === 'normal') return undefined;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  if (/pt$/i.test(v)) return Math.max(1, Math.round(n * 2));
  if (/%$/.test(v)) return Math.max(1, Math.round((n / 100) * 24)); // ~12pt base
  if (/px$/i.test(v)) return Math.max(1, Math.round(n * 1.5)); // px * 0.75pt * 2
  return Math.max(1, Math.round(n * 2)); // treat bare numbers as pt
}

/** line-height CSS value → paragraph line twips (240 twips per line). */
function lineHeightToTwips(value: string | null | undefined): number | undefined {
  const v = String(value ?? '').trim();
  if (!v || v === 'normal' || v === 'inherit') return undefined;
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  let multiplier = n;
  if (/%$/.test(v)) multiplier = n / 100;
  else if (/px$/.test(v)) multiplier = n / 16; // approximate (16px base)
  return Math.max(120, Math.round(multiplier * 240));
}

/** Alignment produced by execCommand justify* / computed text-align. */
function alignmentFromCss(value: string | null | undefined) {
  const align = String(value ?? '').trim().toLowerCase();
  if (align === 'center') return AlignmentType.CENTER;
  if (align === 'right') return AlignmentType.RIGHT;
  if (align === 'justify') return AlignmentType.BOTH;
  return AlignmentType.LEFT;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Strip characters that are reserved in file names on Windows/macOS/Linux
 * (< > : " / \ | ? * and control chars), plus trailing dots/spaces.
 */
function sanitizeDownloadFileName(value: string): string {
  // Strip ASCII control characters, then reserved file-name characters.
  const cleaned = Array.from(value)
    .filter((char) => char.charCodeAt(0) >= 32)
    .join('')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/[. ]+$/g, '');
  return cleaned.length > 0 ? cleaned : 'document';
}

const EMPTY_RUN_STYLE: RunStyle = {
  bold: false,
  italics: false,
  underline: false,
  strike: false,
  subScript: false,
  superScript: false,
};

/** Merge extra character formatting carried by a <span>/<font> element. */
function mergeInlineStyles(el: Element, base: RunStyle): RunStyle {
  const next = { ...base };
  const element = el as HTMLElement;
  const hasStyle = typeof element.style === 'object' && element.hasAttribute?.('style');
  if (hasStyle) {
    const font = fontFamilyName(element.style.fontFamily);
    if (font) next.font = font;
    const sizeHalf = fontSizeToHalfPoints(element.style.fontSize);
    if (sizeHalf) next.sizeHalf = sizeHalf;
    const color = cssColorToHex(element.style.color);
    if (color) next.color = color;
    const highlight = cssColorToHex(element.style.backgroundColor);
    if (highlight) next.highlightFill = highlight;
  }
  // Legacy <font color size face> markup (older execCommand output).
  const tag = el.nodeName.toUpperCase();
  if (tag === 'FONT') {
    const font = el as HTMLElement & { color?: string; face?: string; size?: string };
    const colorAttr = cssColorToHex(font.color ?? element.getAttribute('color'));
    if (colorAttr) next.color = colorAttr;
    const face = fontFamilyName(font.face ?? element.getAttribute('face'));
    if (face) next.font = face;
    const sizeAttr = Number(element.getAttribute('size'));
    if (Number.isInteger(sizeAttr) && sizeAttr >= 1 && sizeAttr <= 7) {
      const htmlSizesPt = [10, 13, 16, 18, 24, 32, 48];
      next.sizeHalf = htmlSizesPt[sizeAttr - 1] * 2;
    }
  }
  return next;
}

/**
 * Walk the inline children of a node and build docx TextRuns, translating
 * bold/italic/underline/strike/sub/superscript and span-level font, size,
 * colour and highlight styles.
 */
function buildRuns(parent: Node, inherited: RunStyle = { ...EMPTY_RUN_STYLE }): TextRun[] {
  const runs: TextRun[] = [];

  const visit = (node: Node, style: RunStyle) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? '';
      if (!text) return;
      runs.push(
        new TextRun({
          text,
          bold: style.bold ? true : undefined,
          italics: style.italics ? true : undefined,
          underline: style.underline ? {} : undefined,
          strike: style.strike ? true : undefined,
          subScript: style.subScript ? true : undefined,
          superScript: style.superScript ? true : undefined,
          font: style.font ? { ascii: style.font, hAnsi: style.font } : undefined,
          size: style.sizeHalf,
          color: style.color,
          shading: style.highlightFill
            ? { type: ShadingType.CLEAR, color: 'auto', fill: style.highlightFill }
            : undefined,
        })
      );
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.nodeName.toUpperCase();

    if (tag === 'BR') {
      runs.push(new TextRun({ break: 1 }));
      return;
    }
    if (tag === 'IMG') return; // images are handled as block-level content

    let next = style;
    if (tag === 'STRONG' || tag === 'B') next = { ...style, bold: true };
    else if (tag === 'EM' || tag === 'I') next = { ...style, italics: true };
    else if (tag === 'U') next = { ...style, underline: true };
    else if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') next = { ...style, strike: true };
    else if (tag === 'SUB') next = { ...style, subScript: true };
    else if (tag === 'SUP') next = { ...style, superScript: true };
    else if (tag === 'SPAN' || tag === 'FONT') next = mergeInlineStyles(node as Element, style);
    else if (BLOCK_TAGS.has(tag) || LIST_TAGS.has(tag)) return; // block handled elsewhere

    Array.from(node.childNodes).forEach((child) => visit(child, next));
  };

  Array.from(parent.childNodes).forEach((child) => visit(child, inherited));
  return runs;
}

type DocChild = Paragraph | Table;

/** Read paragraph-level alignment / spacing from an editor block element. */
function readBlockStyle(el: Element, fallbackAlignment?: ParaStyle['alignment']): ParaStyle {
  const style: ParaStyle = {};
  const element = el as HTMLElement;
  const hasStyle = typeof element.style === 'object' && element.hasAttribute?.('style');
  if (hasStyle) {
    const align = element.style.textAlign;
    if (align) style.alignment = alignmentFromCss(align);
    const twips = lineHeightToTwips(element.style.lineHeight);
    if (twips) style.lineTwips = twips;
  }
  if (!style.alignment && fallbackAlignment) style.alignment = fallbackAlignment;
  return style;
}

function makeParagraph(
  children: (TextRun | ImageRun)[],
  kind?: { type: 'heading'; heading: HeadingKey } | { type: 'list'; list: 'bullet' | 'ordered' },
  blockStyle?: ParaStyle
): Paragraph {
  const options: {
    children: (TextRun | ImageRun)[];
    heading?: HeadingKey;
    bullet?: { level: number };
    numbering?: { reference: string; level: number };
    alignment?: ParaStyle['alignment'];
    spacing?: { line?: number; lineRule?: (typeof LineRuleType)[keyof typeof LineRuleType] };
  } = { children };
  if (kind?.type === 'heading') options.heading = kind.heading;
  if (kind?.type === 'list') {
    if (kind.list === 'bullet') options.bullet = { level: 0 };
    else options.numbering = { reference: 'ordered-list', level: 0 };
  }
  if (blockStyle?.alignment) options.alignment = blockStyle.alignment;
  if (blockStyle?.lineTwips) {
    options.spacing = { line: blockStyle.lineTwips, lineRule: LineRuleType.AUTO };
  }
  return new Paragraph(options);
}

/** A `<img>` with an embedded PNG/JPEG data URL becomes one centered page image. */
function imageParagraph(imageElement: HTMLImageElement): Paragraph | null {
  const src = imageElement.getAttribute('src') || imageElement.currentSrc || '';
  const match = /^data:image\/(png|jpeg);base64,([a-zA-Z0-9+/=]+)$/i.exec(src);
  if (!match) return null;
  const type = match[1].toLowerCase() === 'png' ? 'png' : 'jpg';
  const naturalWidth = imageElement.naturalWidth || 1200;
  const naturalHeight = imageElement.naturalHeight || Math.round(naturalWidth * 0.75);
  const width = Math.min(500, naturalWidth);
  const height = Math.max(1, Math.round((width * naturalHeight) / naturalWidth));
  return new Paragraph({
    children: [
      new ImageRun({
        type,
        data: base64ToBytes(match[2]),
        transformation: { width, height },
      }),
    ],
    alignment: AlignmentType.CENTER,
  });
}

function horizontalRuleParagraph(): Paragraph {
  return new Paragraph({
    children: [new TextRun({ text: '' })],
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 8, color: '888888', space: 1 },
    },
    spacing: { after: 120 },
  });
}
/** Serialize table cells into a docx table. */
function addTableToBlocks(tableElement: Element, blocks: DocChild[]) {
  const rows: TableRow[] = [];
  const rowSelectors = ':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr';
  tableElement.querySelectorAll(rowSelectors).forEach((tr) => {
    const cells: TableCell[] = [];
    Array.from(tr.children).forEach((child) => {
      if (child.nodeName !== 'TD' && child.nodeName !== 'TH') return;
      const cellBlocks: DocChild[] = [];
      collectBlocksInto(child, cellBlocks);
      const cellParagraphs = cellBlocks.filter(
        (c): c is Paragraph => c instanceof Paragraph
      );
      cells.push(
        new TableCell({
          children:
            cellParagraphs.length > 0
              ? cellParagraphs
              : [new Paragraph({ children: [] })],
        })
      );
    });
    if (cells.length > 0) rows.push(new TableRow({ children: cells }));
  });
  if (rows.length > 0) {
    blocks.push(new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } }));
  }
}

/**
 * Convert the contentEditable DOM (paragraphs, headings, lists, tables,
 * images, rules and rich inline formatting) into docx elements.
 */
function collectBlocksInto(root: Node | null, blocks: DocChild[]) {
  if (!root) return;

  const addList = (listElement: Element, list: 'bullet' | 'ordered') => {
    Array.from(listElement.children)
      .filter((child) => child.nodeName === 'LI')
      .forEach((li) => {
        const runs = buildRuns(li);
        if (runs.length) {
          blocks.push(makeParagraph(runs, { type: 'list', list }, readBlockStyle(li)));
        }
        const nested = Array.from(li.children).find(
          (child) => child.nodeName === 'UL' || child.nodeName === 'OL'
        );
        if (nested) addList(nested, nested.nodeName === 'OL' ? 'ordered' : 'bullet');
      });
  };

  const addContentNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.textContent ?? '').trim();
      if (text) blocks.push(makeParagraph([new TextRun({ text })]));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    const tag = element.nodeName.toUpperCase();

    if (tag === 'UL' || tag === 'OL') {
      addList(element, tag === 'OL' ? 'ordered' : 'bullet');
      return;
    }
    if (tag === 'TABLE') {
      addTableToBlocks(element, blocks);
      return;
    }
    if (tag === 'HR') {
      blocks.push(horizontalRuleParagraph());
      return;
    }
    if (tag === 'IMG') {
      const paragraph = imageParagraph(element as HTMLImageElement);
      if (paragraph) blocks.push(paragraph);
      return;
    }
    if (HEADING_LEVELS[tag]) {
      const runs = buildRuns(element);
      if (runs.length) {
        blocks.push(
          makeParagraph(
            runs,
            { type: 'heading', heading: HEADING_LEVELS[tag] },
            readBlockStyle(element)
          )
        );
      }
      return;
    }

    const isContainer = tag === 'P' || tag === 'DIV' || tag === 'BLOCKQUOTE' || tag === 'LI';
    const hasBlockChildren = Array.from(element.children).some((child) => {
      const childTag = child.nodeName.toUpperCase();
      return (
        HEADING_LEVELS[childTag] ||
        LIST_TAGS.has(childTag) ||
        childTag === 'TABLE' ||
        childTag === 'HR' ||
        childTag === 'IMG' ||
        BLOCK_TAGS.has(childTag)
      );
    });
    if (isContainer && hasBlockChildren) {
      Array.from(element.childNodes).forEach((child) => addContentNode(child));
      return;
    }

    const runs = buildRuns(element);
    if (runs.length) blocks.push(makeParagraph(runs, undefined, readBlockStyle(element)));
  };

  Array.from(root.childNodes).forEach((child) => addContentNode(child));
}
interface DocumentCreatorProps {
  /** Fired when a non-Pro user attempts an export after the device trial is spent. */
  onFreeTrialExhausted?: () => void;
}

export const DocumentCreator: React.FC<DocumentCreatorProps> = ({ onFreeTrialExhausted }) => {
  const { isProUser, usageCount, incrementUsage } = useAuthStore();
  const [title, setTitle] = useState('');
  const [headingValue, setHeadingValue] = useState<HeadingValue>('p');
  const [hasContent, setHasContent] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [fontFamily, setFontFamily] = useState('Arial');
  const [fontSizePt, setFontSizePt] = useState(12);
  const [tableRows, setTableRows] = useState(3);
  const [tableCols, setTableCols] = useState(3);

  const editorRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  /** Keep the export button enabled when any content (text, tables, images…) exists. */
  const notifyChange = () => {
    const editor = editorRef.current;
    const hasText = (editor?.innerText ?? '').trim().length > 0;
    const hasMedia = Boolean(editor?.querySelector('img, table, hr'));
    setHasContent(hasText || hasMedia);
  };

  /** Run a browser contentEditable command (native undo/redo history applies). */
  const runCommand = (command: string, value?: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    document.execCommand(command, false, value);
    notifyChange();
  };

  const handleHeadingChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const value = event.target.value as HeadingValue;
    setHeadingValue(value);
    const tag = value === 'p' ? '<p>' : `<${value}>`;
    runCommand('formatBlock', tag);
  };

  const handleFontFamilyChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    setFontFamily(event.target.value);
    runCommand('fontName', event.target.value);
  };

  /** Font sizes need arbitrary pt values (execCommand only supports 1–7). */
  const handleFontSizeChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const pt = Number(event.target.value);
    setFontSizePt(pt);
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const span = document.createElement('span');
    span.style.fontSize = `${pt}px`;
    if (range.collapsed) {
      range.insertNode(span);
      const caret = document.createRange();
      caret.setStart(span, 0);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    } else {
      const fragment = range.extractContents();
      span.appendChild(fragment);
      range.insertNode(span);
      const caret = document.createRange();
      caret.selectNodeContents(span);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
    notifyChange();
  };
  /** Paragraphs touched by the current selection/caret. */
  const selectedBlocks = (): HTMLElement[] => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || selection.rangeCount === 0) return [];
    const range = selection.getRangeAt(0);
    const isBlockTag = (element: HTMLElement) => BLOCK_TAG_NAMES.includes(element.nodeName);

    const parentBlock = (node: Node | null): HTMLElement | null => {
      let current: Node | null = node;
      while (current && current !== editor) {
        if (current.nodeType === Node.ELEMENT_NODE && isBlockTag(current as HTMLElement)) {
          return current as HTMLElement;
        }
        current = current.parentElement;
      }
      return null;
    };

    const found = new Set<HTMLElement>();
    if (range.collapsed) {
      const block = parentBlock(range.startContainer);
      if (block) found.add(block);
      return Array.from(found);
    }

    const walk = (node: Node) => {
      Array.from(node.childNodes).forEach((child) => {
        if (child.nodeType !== Node.ELEMENT_NODE) return;
        const element = child as HTMLElement;
        if (isBlockTag(element) && range.intersectsNode(child)) {
          found.add(element);
        } else {
          walk(child);
        }
      });
    };
    const root =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : (range.commonAncestorContainer.parentNode ?? editor);
    walk(root);
    return Array.from(found);
  };

  const applyLineSpacing = (multiplier: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.focus();
    selectedBlocks().forEach((block) => {
      block.style.lineHeight = String(multiplier);
    });
    notifyChange();
  };

  const insertHorizontalRule = () => {
    runCommand('insertHTML', '<hr>');
  };

  const insertTable = () => {
    const rows = Math.max(1, Math.min(20, tableRows));
    const cols = Math.max(1, Math.min(10, tableCols));
    const cell = (): string => '<td style="border:1px solid #94a3b8;padding:6px"><br></td>';
    const rowHtml = `<tr>${Array.from({ length: cols }, cell).join('')}</tr>`;
    const tableHtml = `<table style="border-collapse:collapse;width:100%">${Array.from(
      { length: rows },
      () => rowHtml
    ).join('')}</table><p><br></p>`;
    runCommand('insertHTML', tableHtml);
  };

  const handleImagePicked = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      runCommand('insertHTML', `<p><img src="${dataUrl}" style="max-width:100%" /></p>`);
    };
    reader.readAsDataURL(file);
  };

  const canExport = title.trim().length > 0 || hasContent;

  /** Trial gate — Pro users bypass; free users get MAX_FREE_USES successful exports. */
  const canStartAction = (): boolean => {
    if (isProUser || usageCount < MAX_FREE_USES) return true;
    onFreeTrialExhausted?.();
    return false;
  };

  const handleExportDocx = async () => {
    const titleText = title.trim();
    const blocks: DocChild[] = [];
    const editor = editorRef.current;
    const bodyHtml = editor?.innerHTML.trim() ?? '';
    const bodyText = editor?.innerText.trim() ?? '';
    if (bodyHtml) {
      const bodySnapshot = document.createElement('div');
      bodySnapshot.innerHTML = bodyHtml;
      collectBlocksInto(bodySnapshot, blocks);
    }
    if (blocks.length === 0 && bodyText) {
      bodyText.split(/\r?\n/).forEach((line) => {
        const text = line.trim();
        if (text) blocks.push(new Paragraph({ children: [new TextRun({ text })] }));
      });
    }
    if (!titleText && blocks.length === 0) return;
    if (!canStartAction()) return;

    const children: DocChild[] = [];
    if (titleText) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: titleText, bold: true, size: 36 })],
        })
      );
    }
    children.push(...blocks);

    const doc = new Document({
      numbering: {
        config: [
          {
            reference: 'ordered-list',
            levels: [
              { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START },
            ],
          },
        ],
      },
      sections: [{ properties: {}, children }],
    });

    setIsExporting(true);
    setExportError('');
    try {
      const blob = await Packer.toBlob(doc);
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${sanitizeDownloadFileName(titleText)}.docx`;
      link.click();
      incrementUsage(); // Successful export consumes one free-trial use.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Failed to export the .docx file.');
    } finally {
      setIsExporting(false);
    }
  };
  const toolButtonClass =
    'inline-flex items-center justify-center rounded-md border border-slate-700 bg-slate-800 p-2 text-slate-300 transition hover:border-indigo-500 hover:bg-slate-700 hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-60';

  const selectClass =
    'rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs text-slate-200 focus:outline-none focus:ring-2 focus:ring-indigo-500';

  return (
    <div className="mx-auto max-w-5xl p-6 text-slate-100">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <FilePlus className="h-6 w-6 text-indigo-400" />
          <div>
            <h2 className="text-xl font-bold">New Document Creator</h2>
            <p className="text-xs text-slate-500">
              Bold, styles, fonts, colours, tables, images and more — all exported to .docx.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={handleExportDocx}
          disabled={!canExport || isExporting}
          className="flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isExporting ? (
            <LoaderCircle className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
          {isExporting ? 'Exporting…' : 'Export .docx'}
        </button>
      </div>

      {exportError && (
        <div className="mb-4 rounded-lg border border-red-800 bg-red-950/50 p-3 text-sm text-red-300">
          {exportError}
        </div>
      )}

      <div className="space-y-4 rounded-xl border border-slate-800 bg-slate-900 p-6">
        <input
          type="text"
          placeholder="Document Title"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="w-full rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-lg text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {/* Rich-text toolbar */}
        <div
          className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/60 p-2"
          role="toolbar"
          aria-label="Formatting tools"
        >
          {/* History */}
          <span className="flex items-center gap-1">
            <button
              type="button"
              title="Undo (Ctrl+Z)"
              aria-label="Undo"
              className={toolButtonClass}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runCommand('undo')}
            >
              <Undo2 className="h-4 w-4" />
            </button>
            <button
              type="button"
              title="Redo (Ctrl+Y)"
              aria-label="Redo"
              className={toolButtonClass}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => runCommand('redo')}
            >
              <Redo2 className="h-4 w-4" />
            </button>
          </span>
          <span className="h-5 w-px bg-slate-700" aria-hidden="true" />

          {/* Formatting */}
          <button
            type="button"
            title="Bold (Ctrl+B)"
            aria-label="Bold"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('bold')}
          >
            <Bold className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Italic (Ctrl+I)"
            aria-label="Italic"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('italic')}
          >
            <Italic className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Underline (Ctrl+U)"
            aria-label="Underline"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('underline')}
          >
            <Underline className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Strikethrough"
            aria-label="Strikethrough"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('strikeThrough')}
          >
            <Strikethrough className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Subscript"
            aria-label="Subscript"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('subscript')}
          >
            <Subscript className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Superscript"
            aria-label="Superscript"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('superscript')}
          >
            <Superscript className="h-4 w-4" />
          </button>
          <label
            title="Text colour"
            aria-label="Text colour"
            className={`${toolButtonClass} cursor-pointer`}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Palette className="h-4 w-4" />
            <input
              type="color"
              defaultValue="#e2e8f0"
              onChange={(event) => runCommand('foreColor', event.target.value)}
              className="sr-only"
            />
          </label>
          <label
            title="Highlight colour"
            aria-label="Highlight colour"
            className={`${toolButtonClass} cursor-pointer`}
            onMouseDown={(event) => event.preventDefault()}
          >
            <Highlighter className="h-4 w-4" />
            <input
              type="color"
              defaultValue="#fef08a"
              onChange={(event) => runCommand('hiliteColor', event.target.value)}
              className="sr-only"
            />
          </label>
          <span className="h-5 w-px bg-slate-700" aria-hidden="true" />

          {/* Typography */}
          <Type className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
          <select
            value={fontFamily}
            onChange={handleFontFamilyChange}
            aria-label="Font family"
            className={selectClass}
          >
            {FONT_FAMILIES.map((family) => (
              <option key={family} value={family} style={{ fontFamily: family }}>
                {family}
              </option>
            ))}
          </select>
          <select
            value={fontSizePt}
            onChange={handleFontSizeChange}
            aria-label="Font size"
            className={selectClass}
          >
            {FONT_SIZE_POINTS.map((pt) => (
              <option key={pt} value={pt}>
                {pt} pt
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 text-xs font-medium text-slate-400">
            <span className="hidden sm:inline">Style</span>
            <select
              value={headingValue}
              onChange={handleHeadingChange}
              aria-label="Heading style"
              className={selectClass}
            >
              {HEADING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <span className="h-5 w-px bg-slate-700" aria-hidden="true" />

          {/* Paragraph: alignment, spacing, lists */}
          <AlignLeft
            className="hidden h-4 w-4 text-slate-500 sm:block"
            aria-hidden="true"
          />
          <button
            type="button"
            title="Align left"
            aria-label="Align left"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('justifyLeft')}
          >
            <AlignLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Align center"
            aria-label="Align center"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('justifyCenter')}
          >
            <AlignCenter className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Align right"
            aria-label="Align right"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('justifyRight')}
          >
            <AlignRight className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Justify"
            aria-label="Justify"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('justifyFull')}
          >
            <AlignJustify className="h-4 w-4" />
          </button>
          <select
            aria-label="Line spacing"
            defaultValue="1.0"
            onChange={(event) => applyLineSpacing(Number(event.target.value))}
            className={selectClass}
            title="Line spacing"
          >
            {LINE_SPACINGS.map((multiplier) => (
              <option key={multiplier} value={multiplier}>
                {multiplier.toFixed(multiplier % 1 === 0 ? 0 : 2)} spacing
              </option>
            ))}
          </select>
          <button
            type="button"
            title="Bulleted list"
            aria-label="Bulleted list"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('insertUnorderedList')}
          >
            <List className="h-4 w-4" />
          </button>
          <button
            type="button"
            title="Numbered list"
            aria-label="Numbered list"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => runCommand('insertOrderedList')}
          >
            <ListOrdered className="h-4 w-4" />
          </button>
          <span className="h-5 w-px bg-slate-700" aria-hidden="true" />
          {/* Insert tools */}
          <button
            type="button"
            title="Insert inline image"
            aria-label="Insert image"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => imageInputRef.current?.click()}
          >
            <ImagePlus className="h-4 w-4" />
          </button>
          <span className="flex items-center gap-1 text-xs text-slate-500">
            <TableIcon className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <input
              type="number"
              min={1}
              max={20}
              value={tableRows}
              onChange={(event) => setTableRows(Math.max(1, Number(event.target.value) || 1))}
              aria-label="Table rows"
              title="Rows"
              className="w-11 rounded border border-slate-700 bg-slate-800 px-1 py-1 text-center text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <span aria-hidden="true">×</span>
            <input
              type="number"
              min={1}
              max={10}
              value={tableCols}
              onChange={(event) => setTableCols(Math.max(1, Number(event.target.value) || 1))}
              aria-label="Table columns"
              title="Columns"
              className="w-11 rounded border border-slate-700 bg-slate-800 px-1 py-1 text-center text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500"
            />
            <button
              type="button"
              title="Insert table"
              aria-label="Insert table"
              className="inline-flex items-center rounded-md border border-slate-700 bg-slate-800 px-2 py-1.5 text-xs font-semibold text-slate-300 transition hover:border-indigo-500 hover:text-indigo-300"
              onMouseDown={(event) => event.preventDefault()}
              onClick={insertTable}
            >
              Insert
            </button>
          </span>
          <button
            type="button"
            title="Insert horizontal rule"
            aria-label="Insert horizontal rule"
            className={toolButtonClass}
            onMouseDown={(event) => event.preventDefault()}
            onClick={insertHorizontalRule}
          >
            <Minus className="h-4 w-4" />
          </button>
        </div>

        {/* Rich-text editing surface */}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          data-placeholder="Start typing your document content..."
          onInput={notifyChange}
          className="doc-editor max-h-[60vh] min-h-[300px] w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 p-4 text-slate-200 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        <input
          ref={imageInputRef}
          type="file"
          accept="image/png,image/jpeg"
          className="hidden"
          tabIndex={-1}
          onChange={handleImagePicked}
        />
        <p className="text-xs text-slate-500">
          Select text and use the toolbar to format it. Ctrl+Z / Ctrl+Y undo and redo,
          tables, inline images, fonts, colours and alignment are all translated to Word.
        </p>
      </div>
    </div>
  );
};
