#!/usr/bin/env bash
# Открывает терминал и запускает сервер Chess Coach.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
exec x-terminal-emulator -e bash -c "cd '$DIR' && ./start.sh; echo; echo 'Нажми Enter, чтобы закрыть окно...'; read -r"
