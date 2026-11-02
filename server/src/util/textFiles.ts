// Which skill files are text: opened in the 파일 tab and checked before an install.

/** The most read of one file (the 파일 tab and the install scan). */
export const MAX_FILE_BYTES = 256 * 1024;
const TEXT_EXT =
  /\.(md|markdown|mdx|txt|rst|json|jsonc|ya?ml|toml|ini|cfg|conf|env|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|fish|ps1|psm1|bat|cmd|rb|pl|php|lua|r|go|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|scala|sql|html?|css|scss|xml|svg|csv|tsv|graphql|proto|tf|hcl|gradle|properties|lock|gitignore|dockerignore|editorconfig)$/i;
const TEXT_NAMES = /^(LICENSE|LICENCE|NOTICE|README|CHANGELOG|Makefile|Dockerfile|Gemfile|Procfile|\.[a-z]+rc)(\.[a-z]+)?$/i;

export function isTextPath(path: string): boolean {
  const name = path.split('/').pop() ?? path;
  return TEXT_EXT.test(name) || TEXT_NAMES.test(name);
}
