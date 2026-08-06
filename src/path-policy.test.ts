import { describe, expect, it } from "vitest";
import {
  joinProjectPaths,
  parseRelativePath,
  resolveProjectPath,
} from "./path-policy";

describe("project path policy", () => {
  it("accepts tree root but requires mutation targets", () => {
    expect(parseRelativePath("", { allowEmpty: true }).normalized).toBe("");
    expect(() => parseRelativePath("", { allowEmpty: false })).toThrow(
      "must not be empty",
    );
  });

  it.each([
    "/etc/passwd",
    "../secret",
    "src/../secret",
    "src/./file",
    "C:\\Windows\\system.ini",
    "\\\\server\\share\\file",
    "src//file",
  ])("rejects unsafe path %s", (candidate) => {
    expect(() =>
      parseRelativePath(candidate, { allowEmpty: false }),
    ).toThrow();
  });

  it("resolves POSIX and Windows project paths with containment", () => {
    expect(
      resolveProjectPath("/work/repo", "src/app.tsx", { allowEmpty: false }),
    ).toEqual({
      absolutePath: "/work/repo/src/app.tsx",
      relativePath: "src/app.tsx",
    });
    expect(
      resolveProjectPath("C:\\work\\repo", "src/app.tsx", {
        allowEmpty: false,
      }),
    ).toEqual({
      absolutePath: "C:\\work\\repo\\src\\app.tsx",
      relativePath: "src/app.tsx",
    });
  });

  it("joins validated relative paths", () => {
    expect(joinProjectPaths("src", "components/App.tsx")).toBe(
      "src/components/App.tsx",
    );
    expect(() => joinProjectPaths("src", "../outside")).toThrow();
  });
});
