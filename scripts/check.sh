#!/usr/bin/env bash

# 專案檢查入口：語法檢查 + 全量測試
# 用法：./scripts/check.sh

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd -- "${SCRIPT_DIR}/.."

echo "==> 語法檢查（git tracked .js / .mjs）"
file_count=0
syntax_failed=0
while IFS= read -r -d '' file; do
    file_count=$((file_count + 1))
    if ! node --check "${file}"; then
        syntax_failed=1
    fi
done < <(git ls-files -z -- '*.js' '*.mjs')

if [ "${syntax_failed}" -ne 0 ]; then
    echo "語法檢查失敗" >&2
    exit 1
fi
echo "    通過：${file_count} 個檔案"

echo "==> 全量測試"
node --experimental-vm-modules --test tests/*.test.mjs
