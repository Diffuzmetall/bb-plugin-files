import { createElement, type ComponentType, type ReactNode } from "react";

interface ThreadPanelRegistration {
  id: string;
  title: string;
  icon?: string;
  layout?: "padded" | "flush";
  component: ComponentType<{ threadId: string; params: unknown }>;
  run?: unknown;
}

const captured = { threadPanelActions: [] as ThreadPanelRegistration[] };
let rpcHandlers: Record<string, (input: unknown) => unknown> = {};

export function resetPluginRuntime() {
  captured.threadPanelActions.length = 0;
  rpcHandlers = {};
}

export function getCapturedPluginApp() {
  return captured;
}

export function setRpcHandlers(
  handlers: Record<string, (input: unknown) => unknown>,
) {
  rpcHandlers = handlers;
}

export function definePluginApp(
  setup: (app: {
    slots: { threadPanelAction(registration: ThreadPanelRegistration): void };
  }) => void,
) {
  setup({
    slots: {
      threadPanelAction(registration) {
        captured.threadPanelActions.push(registration);
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

export function useBbContext() {
  return { projectId: null, threadId: null };
}

export function RuntimeProvider({ children }: { children: ReactNode }) {
  return children;
}
