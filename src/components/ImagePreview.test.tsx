// @vitest-environment jsdom
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ImagePreview } from "./ImagePreview";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { this.callback([{ contentRect: { width: 432, height: 332 } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function loaded() {
  const result = render(<ImagePreview src="/image.png" alt="image.png" />);
  const img = result.getByRole("img", { hidden: true });
  Object.defineProperties(img, { naturalWidth: { value: 800 }, naturalHeight: { value: 600 } });
  fireEvent.load(img);
  return result;
}

it("fits, zooms with buttons and resets to fit or original size", () => {
  const result = loaded();
  const scale = result.getByLabelText("Image scale");
  expect(scale.textContent).toBe("50%");
  fireEvent.click(result.getByRole("button", { name: "Zoom in" }));
  expect(scale.textContent).toBe("63%");
  fireEvent.click(result.getByRole("button", { name: "Zoom out" }));
  expect(scale.textContent).toBe("50%");
  fireEvent.click(result.getByRole("button", { name: "1:1" }));
  expect(scale.textContent).toBe("100%");
  fireEvent.click(result.getByRole("button", { name: "Fit" }));
  expect(scale.textContent).toBe("50%");
});

it("zooms with wheel and keyboard, limits zoom and resets with double click", () => {
  const result = loaded();
  const region = result.getByRole("region");
  fireEvent.wheel(region, { deltaY: -100, clientX: 100, clientY: 100 });
  expect(result.getByLabelText("Image scale").textContent).toBe("82%");
  fireEvent.keyDown(region, { key: "0" });
  expect(result.getByLabelText("Image scale").textContent).toBe("50%");
  for (let i = 0; i < 40; i++) fireEvent.keyDown(region, { key: "+" });
  expect(result.getByLabelText("Image scale").textContent).toBe("400%");
  fireEvent.doubleClick(region);
  expect(result.getByRole("img").style.transform).toContain("translate(0px, 0px)");
});

it("pans with captured pointers, pinches to zoom and stops on cancellation", () => {
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  });
  const result = loaded();
  const region = result.getByRole("region");
  Object.defineProperty(region, "setPointerCapture", { value: vi.fn() });
  fireEvent.pointerDown(region, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(region, { pointerId: 1, clientX: 120, clientY: 130 });
  expect(result.getByRole("img").style.transform).toContain("translate(20px, 30px)");
  fireEvent.pointerDown(region, { pointerId: 2, clientX: 220, clientY: 130, button: 0 });
  fireEvent.pointerMove(region, { pointerId: 2, clientX: 320, clientY: 130 });
  expect(result.getByLabelText("Image scale").textContent).toBe("100%");
  fireEvent.pointerCancel(region, { pointerId: 1 });
  fireEvent.pointerUp(region, { pointerId: 2 });
  const transform = result.getByRole("img").style.transform;
  fireEvent.pointerMove(region, { pointerId: 2, clientX: 500, clientY: 500 });
  expect(result.getByRole("img").style.transform).toBe(transform);
});

it("shows a visible error instead of a permanently loading broken image", () => {
  const result = render(<ImagePreview src="/bad.png" alt="bad.png" />);
  fireEvent.error(result.getByRole("img", { hidden: true }));
  expect(result.getByText("Unable to load image preview.").getAttribute("role")).toBe("status");
  expect(result.getByRole("button", { name: "Zoom in" }).hasAttribute("disabled")).toBe(true);
});

it("resets view when EditorPane's image identity key changes", () => {
  const result = loaded();
  fireEvent.click(result.getByRole("button", { name: "1:1" }));
  result.rerender(<ImagePreview key="other-image" src="/other.png" alt="other.png" />);
  expect(result.getByText("Loading image preview…").getAttribute("role")).toBe("status");
  expect(result.getByRole("img", { hidden: true }).style.transform).toContain("translate(0px, 0px)");
});
