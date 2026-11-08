#!/usr/bin/env bash
# Создаёт ярлык запуска локального live-тренера для текущего пользователя.
# Ярлык кладётся в ~/.local/share/applications и не попадает в репозиторий.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
TARGET="$TARGET_DIR/chess-coach.desktop"

mkdir -p "$TARGET_DIR"
cat > "$TARGET" <<EOF
[Desktop Entry]
Type=Application
Name=Chess Coach
Comment=Локальный тренер для Chess.com (Stockfish)
Exec="$DIR/launch.sh"
Path=$DIR
Icon=applications-games
Terminal=false
Categories=Game;
StartupNotify=true
EOF
chmod +x "$TARGET"

if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$TARGET_DIR" >/dev/null 2>&1 || true
fi

echo "Ярлык установлен: $TARGET"
echo "Запуск: меню приложений → Chess Coach."
echo "Удалить: rm \"$TARGET\""
