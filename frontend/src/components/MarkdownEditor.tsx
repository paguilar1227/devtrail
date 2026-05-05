// Bear-style inline markdown editor.
//
// Markdown remains the source of truth (so embeddings, search, and the
// REST API still see plain text). What the user sees while editing is
// styled: headings render larger, **bold** is bold, *italic* is italic,
// `code` is monospace with a tinted background. Markers (#, **, `) stay
// visible but in a muted color so the syntax remains discoverable —
// matches Bear's behavior, not the cursor-aware hide-on-blur approach
// Obsidian uses.
//
// CodeMirror 6 + @codemirror/lang-markdown does the parsing; a
// HighlightStyle maps Lezer tags to CSS rules. The editor theme keeps
// the background transparent so it inherits the modal's surface color.
import { useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorView } from '@codemirror/view';
import { tags as t } from '@lezer/highlight';

const bearHighlight = HighlightStyle.define([
  // Headings — keep the # visible (handled in the marker rule below) but
  // the actual heading content gets larger + bolder.
  { tag: t.heading1, fontSize: '1.6em', fontWeight: '700', lineHeight: '1.3' },
  { tag: t.heading2, fontSize: '1.35em', fontWeight: '700', lineHeight: '1.3' },
  { tag: t.heading3, fontSize: '1.15em', fontWeight: '600', lineHeight: '1.3' },
  { tag: t.heading4, fontSize: '1.05em', fontWeight: '600' },
  { tag: t.heading5, fontWeight: '600' },
  { tag: t.heading6, fontWeight: '600' },
  // The #, **, *, `, > markers — keep visible but muted.
  { tag: t.processingInstruction, color: 'var(--muted)', fontWeight: '400' },
  { tag: t.contentSeparator, color: 'var(--muted)' },
  // Inline emphasis.
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  // Code spans + fenced code blocks.
  { tag: t.monospace, fontFamily: 'var(--font-mono)', background: 'var(--glass-bg-soft)', padding: '1px 4px', borderRadius: '4px', fontSize: '0.92em' },
  // Links: text colored, URL muted.
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)', textDecoration: 'none' },
  // Lists + blockquotes get slightly muted markers.
  { tag: t.list, color: 'var(--text)' },
  { tag: t.quote, color: 'var(--muted)', fontStyle: 'italic' },
]);

const editorTheme = EditorView.theme(
  {
    '&': {
      fontSize: '13.5px',
      height: '100%',
      background: 'transparent',
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-sans)',
      lineHeight: '1.6',
      padding: '6px 4px',
    },
    '.cm-content': {
      color: 'var(--fg)',
      caretColor: 'var(--accent)',
    },
    '.cm-line': {
      padding: '0 6px',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--accent)',
    },
    '.cm-selectionBackground, ::selection': {
      background: 'var(--accent-soft, rgba(120,120,255,0.18)) !important',
    },
    '.cm-activeLine': {
      background: 'transparent',
    },
    '.cm-gutters': {
      display: 'none',
    },
  },
  { dark: true },
);

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
}

export function MarkdownEditor({ value, onChange, placeholder, autoFocus }: Props) {
  const extensions = useMemo(
    () => [
      markdown({ base: markdownLanguage }),
      syntaxHighlighting(bearHighlight),
      editorTheme,
      EditorView.lineWrapping,
    ],
    [],
  );

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      // theme="none" disables @uiw/react-codemirror's default *light* theme
      // (which paints cm-editor with a white background and made our bright
      // text look ghostly white-on-white). Our custom editorTheme above is
      // the only one that should apply.
      theme="none"
      placeholder={placeholder}
      autoFocus={autoFocus}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        autocompletion: false,
        searchKeymap: false,
      }}
      style={{ height: '100%' }}
    />
  );
}
