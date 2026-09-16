import { describe, expect, it } from "vitest";
import { FILE_OPENER_EXTENSIONS } from "./file-opener-extensions";

describe("file opener extensions", () => {
	it("covers the formats the panel renders itself", () => {
		// Markdown/Excalidraw/SVG/HTML render as themselves, raster images render
		// as <img>, and text-ish sources render in the editor pane.
		for (const extension of ["md", "excalidraw", "svg", "html", "htm"]) {
			expect(FILE_OPENER_EXTENSIONS).toContain(extension);
		}
		for (const extension of [
			"png",
			"jpg",
			"jpeg",
			"gif",
			"webp",
			"avif",
			"bmp",
			"ico",
		]) {
			expect(FILE_OPENER_EXTENSIONS).toContain(extension);
		}
		for (const extension of ["ts", "tsx", "json", "yaml", "yml", "toml"]) {
			expect(FILE_OPENER_EXTENSIONS).toContain(extension);
		}
	});

	it("stays bare, lowercase, and unique", () => {
		const seen = new Set<string>();
		for (const extension of FILE_OPENER_EXTENSIONS) {
			expect(extension).not.toContain(".");
			expect(extension).toBe(extension.toLowerCase());
			expect(seen.has(extension)).toBe(false);
			seen.add(extension);
		}
	});
});
