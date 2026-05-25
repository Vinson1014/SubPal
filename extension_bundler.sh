#!/bin/bash

# Chrome Extension 打包腳本
# 自動選擇必要檔案並打包成 ZIP

set -euo pipefail

# 設定變數
EXTENSION_NAME="SubPal"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT_FILE="${EXTENSION_NAME}-$(date +%Y%m%d-%H%M%S).zip"
OUTPUT_PATH="${SCRIPT_DIR}/${OUTPUT_FILE}"
BUILD_DIR="$(mktemp -d "${TMPDIR:-/tmp}/${EXTENSION_NAME}.build.XXXXXX")"

cleanup() {
    if [ -n "${BUILD_DIR:-}" ] && [ -d "$BUILD_DIR" ]; then
        rm -rf -- "$BUILD_DIR"
    fi
}
trap cleanup EXIT

# 從腳本所在目錄執行，避免不同工作目錄造成打包內容錯誤。
cd "$SCRIPT_DIR"

# 定義必要檔案和目錄
REQUIRED_FILES=(
    "manifest.json"
    "popup.html"
    "popup.js"
    "options.html"
    "options.css"
    "options.js"
    "tutorial.html"
    "tutorial.css"
    "tutorial.js"
    "content.js"
    "background.js"
    "netflix-page-script.js"
)

REQUIRED_DIRS=(
    "icons"
    "content"
    "background"
    "shared"
)

# 檢查必要檔案與目錄，缺少任一項就停止，避免產生不完整套件。
echo "檢查必要檔案與目錄..."
missing_items=()

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        missing_items+=("檔案: $file")
    fi
done

for dir in "${REQUIRED_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
        missing_items+=("目錄: $dir")
    fi
done

if [ "${#missing_items[@]}" -gt 0 ]; then
    echo "錯誤: 缺少必要項目，已停止打包。" >&2
    for item in "${missing_items[@]}"; do
        echo "- $item" >&2
    done
    exit 1
fi

if [ -e "$OUTPUT_PATH" ]; then
    echo "錯誤: 輸出檔案已存在: $OUTPUT_PATH" >&2
    exit 1
fi

if ! command -v zip >/dev/null 2>&1; then
    echo "錯誤: 找不到 zip 指令，請先安裝 zip。" >&2
    exit 1
fi

if ! command -v unzip >/dev/null 2>&1; then
    echo "錯誤: 找不到 unzip 指令，請先安裝 unzip。" >&2
    exit 1
fi

# 複製必要檔案
echo "複製必要檔案..."
for file in "${REQUIRED_FILES[@]}"; do
    cp -- "$file" "$BUILD_DIR/"
    echo "✓ 複製: $file"
done

# 複製必要目錄
echo "複製必要目錄..."
for dir in "${REQUIRED_DIRS[@]}"; do
    cp -R -- "$dir" "$BUILD_DIR/"
    echo "✓ 複製目錄: $dir"
done

# 移除常見非發佈雜訊檔案。
find "$BUILD_DIR" -name ".DS_Store" -delete

# 建立 ZIP 檔案
echo "建立 ZIP 檔案..."
(
    cd "$BUILD_DIR"
    zip -r "$OUTPUT_PATH" . -x "*.DS_Store"
)

# 顯示結果
echo ""
echo "=============================================="
echo "🎉 打包完成！"
echo "輸出檔案: $OUTPUT_PATH"
echo "檔案大小: $(du -h "$OUTPUT_PATH" | cut -f1)"
echo "=============================================="
echo ""
echo "包含的檔案："
unzip -l "$OUTPUT_PATH"
