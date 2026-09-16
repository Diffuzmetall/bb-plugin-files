/**
 * Extensions the Files panel offers to open for other surfaces.
 *
 * Text, code, Markdown, and Excalidraw are what this plugin edits better than
 * BB's preview. Binary and media formats stay with BB's own preview, which is
 * lighter and already correct for them. BB accepts lowercase extensions
 * without the dot, and keeps rendering the first applicable opener unless the
 * user pins this one under Settings → Files.
 */
export const FILE_OPENER_EXTENSIONS = [
  "bash",
  "c",
  "cjs",
  "conf",
  "cpp",
  "cs",
  "css",
  "csv",
  "env",
  "excalidraw",
  "go",
  "h",
  "hpp",
  "htm",
  "html",
  "ini",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "less",
  "log",
  "markdown",
  "md",
  "mdx",
  "mjs",
  "php",
  "properties",
  "py",
  "rb",
  "rs",
  "scss",
  "sh",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
  "zsh",
] as const;
