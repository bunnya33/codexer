#!/usr/bin/env bash
set -euo pipefail

for tool in curl tar mktemp; do
  command -v "$tool" >/dev/null || { echo "缺少 $tool。" >&2; exit 1; }
done

temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
archive="$temporary/codexer.tar.gz"
source_dir="$temporary/source"
if [[ -n ${CODEXER_ARCHIVE_URL:-} ]]; then
  curl -fL --retry 3 --connect-timeout 15 --max-time 600 "$CODEXER_ARCHIVE_URL" -o "$archive"
  if [[ -n ${CODEXER_ARCHIVE_SHA256:-} ]]; then
    [[ $CODEXER_ARCHIVE_SHA256 =~ ^[a-fA-F0-9]{64}$ ]] || { echo "无效的 SHA256。" >&2; exit 1; }
    printf '%s  %s\n' "$CODEXER_ARCHIVE_SHA256" "$archive" | sha256sum -c -
  fi
  tar -tzf "$archive" >/dev/null
  mkdir -p "$source_dir"
  tar -xzf "$archive" -C "$source_dir" --strip-components=1
elif [[ -n ${CODEXER_REPO_URL:-} ]]; then
  command -v git >/dev/null || { echo "从仓库安装需要 Git。" >&2; exit 1; }
  git clone --depth 1 --branch "${CODEXER_REF:-main}" -- "$CODEXER_REPO_URL" "$source_dir"
else
  echo "请设置 CODEXER_ARCHIVE_URL（发布包）或 CODEXER_REPO_URL（新仓库地址）。" >&2
  exit 1
fi

[[ -f "$source_dir/install.sh" ]] || { echo "下载内容缺少 install.sh。" >&2; exit 1; }
bash "$source_dir/install.sh" "$@"
