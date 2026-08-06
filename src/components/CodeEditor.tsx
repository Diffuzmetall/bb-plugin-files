import { useEffect, useRef } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  editorExtensions,
  languageCompartment,
  languageForPath,
} from "../codemirror";

export function CodeEditor({
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
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  const onSaveRef = useRef(onSave);
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: editorExtensions({
          onChange: (next) => onChangeRef.current(next),
          onSave: () => onSaveRef.current(),
        }),
      }),
    });
    viewRef.current = view;
    return () => {
      viewRef.current = null;
      view.destroy();
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    let cancelled = false;
    void languageForPath(filePath).then((extension) => {
      if (cancelled || viewRef.current === null) return;
      viewRef.current.dispatch({
        effects: languageCompartment.reconfigure(extension),
      });
    });
    return () => void (cancelled = true);
  }, [filePath]);

  return (
    <div
      ref={hostRef}
      className="h-full min-h-0 overflow-hidden"
      aria-label={`Editing ${filePath}`}
    />
  );
}
