#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Не найден python3"
  exit 1
fi

if ! command -v stockfish >/dev/null 2>&1 && [ ! -x /usr/games/stockfish ]; then
  echo "Stockfish пока не установлен."
  echo "Выполни в терминале:  sudo apt install stockfish"
  echo
fi

exec python3 server.py "$@"
