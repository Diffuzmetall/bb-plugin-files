import { Editor, Extension, InputRule } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useRef } from "react";
import { Markdown } from "tiptap-markdown";
import { parseMarkdownDocument } from "../markdown-document";

interface EditableDocument {
  body: string;
  prefix: string;
}

function editableDocument(content: string): EditableDocument {
  const document = parseMarkdownDocument(content);
  const leadingBreaks = document.frontmatter
    ? (/^(?:\r?\n)*/.exec(document.body)?.[0] ?? "")
    : "";
  return {
    body: document.body,
    prefix: document.frontmatter + leadingBreaks,
  };
}

const MarkdownTaskInput = Extension.create({
  name: "markdownTaskInput",
  priority: 200,
  addInputRules() {
    return [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/,
        handler: ({ range, match, chain }) => {
          const commands = chain().deleteRange(range).toggleTaskList();
          if (/[xX]/.test(match[1] ?? "")) {
            commands.updateAttributes("taskItem", { checked: true });
          }
          commands.run();
        },
      }),
    ];
  },
});

export function MarkdownEditor({
  filePath,
  value,
  onChange,
  onSave,
}: {
  filePath: string;
  value: string;
  onChange(value: string): void;
  onSave(): void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<Editor | null>(null);
  const prefixRef = useRef("");
  const lastEmittedValueRef = useRef<string | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const initial = editableDocument(value);
    prefixRef.current = initial.prefix;
    lastEmittedValueRef.current = null;

    const editor = new Editor({
      element: root,
      extensions: [
        StarterKit,
        Link.configure({ openOnClick: false, autolink: true }),
        Image.configure({ allowBase64: false }),
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true, lastColumnResizable: false }),
        TableRow,
        TableHeader,
        TableCell,
        MarkdownTaskInput,
        Markdown.configure({
          html: true,
          tightLists: true,
          bulletListMarker: "-",
          linkify: true,
        }),
      ],
      content: initial.body,
      editorProps: {
        attributes: {
          "aria-label": `Editing preview of ${filePath}`,
          spellcheck: "true",
        },
        handleKeyDown(_view, event) {
          if (
            event.key.toLowerCase() === "s" &&
            (event.metaKey || event.ctrlKey) &&
            !event.altKey
          ) {
            event.preventDefault();
            onSaveRef.current();
            return true;
          }
          return false;
        },
      },
    });

    editor.on("update", () => {
      const markdown =
        prefixRef.current + editor.storage.markdown.getMarkdown();
      lastEmittedValueRef.current = markdown;
      onChangeRef.current(markdown);
    });
    editorRef.current = editor;

    return () => {
      editorRef.current = null;
      editor.destroy();
    };
  }, [filePath]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || value === lastEmittedValueRef.current) return;

    const next = editableDocument(value);
    prefixRef.current = next.prefix;
    lastEmittedValueRef.current = null;
    editor.commands.setContent(next.body, false);
  }, [value]);

  return (
    <div
      ref={rootRef}
      className="bb-files-markdown-editor h-full min-h-0 overflow-y-auto bg-background"
      data-testid="bb-files-markdown-editor"
    />
  );
}
