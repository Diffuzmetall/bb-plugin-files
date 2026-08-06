import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

export type OperationKind = "create-file" | "create-directory" | "rename" | "duplicate";

export interface OperationRequest {
  kind: OperationKind;
  sourcePath: string | null;
  targetPath: string;
  entryKind: "file" | "directory";
}

const TITLES: Record<OperationKind, string> = {
  "create-file": "Create file",
  "create-directory": "Create folder",
  rename: "Rename",
  duplicate: "Duplicate",
};

export function OperationDialog({
  request,
  onClose,
  onSubmit,
}: {
  request: OperationRequest | null;
  onClose(): void;
  onSubmit(request: OperationRequest): Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [targetPath, setTargetPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    setTargetPath(request?.targetPath ?? "");
    setError(null);
  }, [request]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (request === null || targetPath.length === 0) return;
    setPending(true);
    const result = await onSubmit({ ...request, targetPath });
    setPending(false);
    if (result.ok) onClose();
    else setError(result.error);
  };

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>{request ? TITLES[request.kind] : "File operation"}</DialogTitle>
            <DialogDescription>
              {request?.kind === "create-file" 
                ? "Enter a project-relative path. If the file already exists, it will be opened."
                : "Enter a project-relative path. Existing destinations are never overwritten."}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            className="my-4"
            aria-label="Project-relative path"
            value={targetPath}
            onChange={(event) => setTargetPath(event.target.value)}
          />
          {error ? <p className="mb-4 text-sm text-destructive-text" role="alert">{error}</p> : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={pending || targetPath.length === 0}>
              {pending ? "Working…" : "Confirm"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
