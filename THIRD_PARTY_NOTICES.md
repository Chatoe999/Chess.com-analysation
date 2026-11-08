# Сторонние компоненты

Сайт использует две сторонние библиотеки. Они лежат в `docs/vendor/`, чтобы
сайт работал без внешних CDN.

## Stockfish 17.1 Lite (single-thread, WebAssembly)

- Файлы: `docs/vendor/stockfish/stockfish-17.1-lite-single-03e3232.js`,
  `docs/vendor/stockfish/stockfish-17.1-lite-single-03e3232.wasm`
- Лицензия: **GNU General Public License v3.0**
- Полный текст лицензии: `docs/vendor/stockfish/Copying.txt`
- Исходный код:
  - <https://github.com/official-stockfish/Stockfish>
  - <https://github.com/nmrugg/stockfish.js> — сборка Stockfish.js 17.1
- Авторские права: Stockfish contributors; обёртка Stockfish.js — Chess.com, LLC.

Stockfish — отдельная программа. Сайт запускает её в Web Worker и общается с ней
через текстовый протокол UCI, поэтому код сайта распространяется под MIT и это
не меняет лицензию самого движка.

## chess.js 1.4.0

- Файл: `docs/vendor/chess.js`
- Лицензия: **MIT**
- Текст лицензии: `docs/vendor/chess.js.LICENSE`
- Исходный код: <https://github.com/jhlywa/chess.js>
- Автор: Jeff Hlywa.

## Собственный код

Код сайта и локального сервера лицензирован по MIT — см. `LICENSE`.
