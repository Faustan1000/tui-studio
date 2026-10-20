// Export panel for previewing and exporting TUI designs

import { useState } from 'react';
import { Download, Copy, Eye } from 'lucide-react';
import { useComponentStore, useCanvasStore } from '../../stores';
import {
  exportToText,
  exportToFiles,
  exportToHtmlFile,
  ansiToHtml,
} from '../../utils/export';
import { saveToDownloadFolder } from '../../utils/downloadManager';
type ExportMode = 'preview' | 'text' | 'code';

/** All screens, in order (formats that support several screens export all of them). */
function allScreens() {
  return useComponentStore.getState().getScreenRoots();
}

interface OutFile {
  name: string;
  content: string;
}

/** The files a code export consists of (entry point plus runtime/manifest where the framework needs them). */
function getCodeFiles(format: string, width: number, height: number): OutFile[] {
  const root = useComponentStore.getState().root;
  if (format === 'html') {
    return [{ name: 'tui-design.html', content: exportToHtmlFile(root, width, height) }];
  }
  return exportToFiles(root, format, allScreens()).map((f) => ({
    name: f.path,
    content: f.content,
  }));
}

export function ExportPanel() {
  const componentStore = useComponentStore();
  const canvasStore = useCanvasStore();

  const [mode, setMode] = useState<ExportMode>('preview');
  const [textFormat, setTextFormat] = useState<'text' | 'ansi' | 'ansi256' | 'trueColor'>('ansi');
  const [codeFormat, setCodeFormat] = useState('opentui');
  const [copied, setCopied] = useState(false);
  const [activeFile, setActiveFile] = useState(0);

  const codeFiles =
    mode === 'code' ? getCodeFiles(codeFormat, canvasStore.width, canvasStore.height) : [];
  const shownFile = codeFiles[Math.min(activeFile, Math.max(codeFiles.length - 1, 0))];

  const getOutput = () => {
    if (mode === 'code') return shownFile?.content ?? '';
    return exportToText(componentStore.root, {
      format: textFormat,
      width: canvasStore.width,
      height: canvasStore.height,
    });
  };

  const handleCopy = async () => {
    await navigator.clipboard.writeText(getOutput());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const saveFile = async (file: OutFile, mimeType: string) => {
    // Try saving to the user's selected download folder first
    if (await saveToDownloadFolder(file.content, file.name)) return;

    // Fall back to browser download link
    const blob = new Blob([file.content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDownload = async () => {
    if (mode === 'code') {
      // Every file of the export, e.g. ui.py and ui_runtime.py, one after the other.
      for (const file of codeFiles) {
        await saveFile(file, file.name.endsWith('.html') ? 'text/html' : 'text/plain');
        if (codeFiles.length > 1) await new Promise((r) => setTimeout(r, 250));
      }
      return;
    }
    await saveFile(
      {
        name: 'tui-design.txt',
        content: exportToText(componentStore.root, {
          format: textFormat,
          width: canvasStore.width,
          height: canvasStore.height,
          includeMetadata: true,
        }),
      },
      'text/plain'
    );
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b border-border">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase mb-3">Export</h2>

        {/* Mode Selection */}
        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setMode('preview')}
            className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
              mode === 'preview'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary hover:bg-secondary/80'
            }`}
          >
            <Eye className="w-4 h-4 inline mr-1" />
            Preview
          </button>
          <button
            onClick={() => setMode('text')}
            className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
              mode === 'text'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary hover:bg-secondary/80'
            }`}
          >
            Text/ANSI
          </button>
          <button
            onClick={() => setMode('code')}
            className={`flex-1 px-3 py-2 rounded text-sm font-medium transition-colors ${
              mode === 'code'
                ? 'bg-primary text-primary-foreground'
                : 'bg-secondary hover:bg-secondary/80'
            }`}
          >
            Code
          </button>
        </div>

        {/* Format Options */}
        {mode === 'text' && (
          <div>
            <label className="text-sm font-medium mb-2 block">Text Format</label>
            <select
              value={textFormat}
              onChange={(e) =>
                setTextFormat(e.target.value as 'text' | 'ansi' | 'ansi256' | 'trueColor')
              }
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-sm"
            >
              <option value="text">Plain Text</option>
              <option value="ansi">ANSI 16 Colors</option>
              <option value="ansi256">ANSI 256 Colors</option>
              <option value="trueColor">True Color (24-bit)</option>
            </select>
          </div>
        )}

        {mode === 'code' && (
          <div>
            <label className="text-sm font-medium mb-2 block">Framework</label>
            <select
              value={codeFormat}
              onChange={(e) => {
                setCodeFormat(e.target.value);
                setActiveFile(0);
              }}
              className="w-full px-3 py-2 bg-secondary border border-border rounded text-sm"
            >
              <option value="opentui">OpenTUI (React)</option>
              <option value="ink">Ink (React)</option>
              <option value="bubbletea">Bubble Tea (Go)</option>
              <option value="blessed">Blessed (Node.js)</option>
              <option value="textual">Textual (Python)</option>
              <option value="html">HTML + CSS</option>
              <option value="ratatui">Ratatui (Rust)</option>
              <option value="tview">tview (Go)</option>
            </select>
          </div>
        )}
      </div>

      {/* Preview/Output */}
      <div className="flex-1 overflow-auto p-4">
        {mode === 'preview' && <PreviewOutput />}
        {mode === 'text' && (
          <TextOutput format={textFormat} width={canvasStore.width} height={canvasStore.height} />
        )}
        {mode === 'code' && (
          <>
            {codeFiles.length > 1 && (
              <div className="mb-2">
                <div className="flex gap-1">
                  {codeFiles.map((file, i) => (
                    <button
                      key={file.name}
                      onClick={() => setActiveFile(i)}
                      className={`px-2 py-1 rounded text-xs font-mono transition-colors ${
                        file === shownFile
                          ? 'bg-primary text-primary-foreground'
                          : 'bg-secondary hover:bg-secondary/80'
                      }`}
                    >
                      {file.name}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground mt-1">
                  Keep these files in the same folder.
                </p>
              </div>
            )}
            <CodeOutput content={shownFile?.content ?? ''} />
          </>
        )}
      </div>

      {/* Actions */}
      <div className="p-4 border-t border-border space-y-2">
        <button
          onClick={handleCopy}
          className="w-full px-3 py-2 bg-secondary hover:bg-secondary/80 rounded text-sm font-medium flex items-center justify-center gap-2"
        >
          <Copy className="w-4 h-4" />
          {copied
            ? 'Copied!'
            : codeFiles.length > 1
              ? `Copy ${shownFile?.name}`
              : 'Copy to Clipboard'}
        </button>
        <button
          onClick={handleDownload}
          className="w-full px-3 py-2 bg-primary hover:bg-primary/80 text-primary-foreground rounded text-sm font-medium flex items-center justify-center gap-2"
        >
          <Download className="w-4 h-4" />
          {codeFiles.length > 1 ? `Download ${codeFiles.length} files` : 'Download File'}
        </button>
      </div>
    </div>
  );
}

function PreviewOutput() {
  const componentStore = useComponentStore();
  const canvasStore = useCanvasStore();

  const ansiOutput = exportToText(componentStore.root, {
    format: 'ansi',
    width: canvasStore.width,
    height: canvasStore.height,
  });

  const html = ansiToHtml(ansiOutput);

  return (
    <div
      className="text-xs font-mono bg-black text-[#cccccc] p-4 rounded overflow-auto leading-[1.4] border border-border"
      style={{ fontFamily: "'Courier New', Consolas, Monaco, monospace", whiteSpace: 'pre' }}
      dangerouslySetInnerHTML={{ __html: html || 'No components to preview' }}
    />
  );
}

function TextOutput({ format, width, height }: { format: string; width: number; height: number }) {
  const componentStore = useComponentStore();

  if (format === 'text') {
    const output = exportToText(componentStore.root, { format: 'text', width, height });
    return (
      <pre className="text-xs font-mono bg-secondary p-4 rounded overflow-auto whitespace-pre border border-border">
        {output || 'No components to export'}
      </pre>
    );
  }

  // For ANSI formats, show a visual (HTML) representation
  const ansiOutput = exportToText(componentStore.root, {
    format: format as 'ansi' | 'ansi256' | 'trueColor',
    width,
    height,
  });
  const html = ansiToHtml(ansiOutput);

  return (
    <div
      className="text-xs font-mono bg-black text-[#cccccc] p-4 rounded overflow-auto leading-[1.4] border border-border"
      style={{ fontFamily: "'Courier New', Consolas, Monaco, monospace", whiteSpace: 'pre' }}
      dangerouslySetInnerHTML={{ __html: html || 'No components to export' }}
    />
  );
}

function CodeOutput({ content }: { content: string }) {
  return (
    <pre className="text-xs font-mono bg-secondary p-4 rounded overflow-auto border border-border">
      {content}
    </pre>
  );
}

