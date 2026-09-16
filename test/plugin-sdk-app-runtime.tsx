import { createElement, type ComponentType, type ReactNode } from "react";

interface ThreadPanelRegistration {
  id: string;
  title: string;
  icon?: string;
  layout?: "padded" | "flush";
  component: ComponentType<{ threadId: string; params: unknown }>;
  run?: unknown;
}

interface NavPanelRegistration {
  id: string;
  title: string;
  icon: string;
  path: string;
  component: ComponentType<{ subPath: string }>;
}

const captured = {
  threadPanelActions: [] as ThreadPanelRegistration[],
  fileOpeners: [] as FileOpenerRegistration[],
  navPanels: [] as NavPanelRegistration[],
};
let rpcHandlers: Record<string, (input: unknown) => unknown> = {};
let bbContext = { projectId: null as string | null, threadId: null as string | null };

export function resetPluginRuntime() {
  captured.threadPanelActions.length = 0;
  captured.fileOpeners.length = 0;
  captured.navPanels.length = 0;
  rpcHandlers = {};
  bbContext = { projectId: null, threadId: null };
}

export function getCapturedPluginApp() {
  return captured;
}

export function setRpcHandlers(
  handlers: Record<string, (input: unknown) => unknown>,
) {
  rpcHandlers = handlers;
}

interface FileOpenerRegistration {
  id: string;
  title: string;
  extensions: readonly string[];
  component: ComponentType<unknown>;
}

export function definePluginApp(
  setup: (app: {
    slots: {
      threadPanelAction(registration: ThreadPanelRegistration): void;
      fileOpener(registration: FileOpenerRegistration): void;
      navPanel(registration: NavPanelRegistration): void;
    };
  }) => void,
) {
  setup({
    slots: {
      threadPanelAction(registration) {
        captured.threadPanelActions.push(registration);
      },
      fileOpener(registration) {
        captured.fileOpeners.push(registration);
      },
      navPanel(registration) {
        captured.navPanels.push(registration);
      },
    },
  });
  return captured;
}

export function useRpc() {
  return {
    async call(method: string, input: unknown = null) {
      const handler = rpcHandlers[method];
      if (handler === undefined) throw new Error(`Missing RPC handler: ${method}`);
      return handler(input);
    },
  };
}

export function Markdown({ content, className }: { content: string; className?: string }) {
  return createElement(
    "article",
    { className, "data-testid": "native-markdown" },
    content,
  );
}

export function setBbContext(context: { projectId: string | null; threadId: string | null }) {
  bbContext = context;
}

export function useBbContext() {
  return bbContext;
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  return children;
}
