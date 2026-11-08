// Локальный анализ партии целиком в браузере: chess.js + Stockfish WASM.
// Ни одного запроса на сервер: страница может работать с GitHub Pages.

import { Chess } from './vendor/chess.js';

export const ENGINE_URL = './vendor/stockfish/stockfish-17.1-lite-single-03e3232.js';

// ---------------------------------------------------------------------------
// Константы и оценки
// ---------------------------------------------------------------------------

const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const MATE_CP = 100000;
const FILES = 'abcdefgh';
const KNIGHT_DELTAS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_DELTAS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const CATEGORIES = {
  brilliant: { label: 'Блестящий ход', icon: '!!', emoji: '💎', color: '#26c2a3' },
  great: { label: 'Отличный ход', icon: '!', emoji: '🔥', color: '#5c8bb0' },
  best: { label: 'Лучший ход', icon: '★', emoji: '✅', color: '#81b64c' },
  excellent: { label: 'Превосходно', icon: '', emoji: '👍', color: '#96bc4b' },
  good: { label: 'Хороший ход', icon: '', emoji: '🙂', color: '#95af8a' },
  inaccuracy: { label: 'Неточность', icon: '?!', emoji: '🤔', color: '#f7c631' },
  mistake: { label: 'Ошибка', icon: '?', emoji: '❌', color: '#ffa459' },
  blunder: { label: 'Зевок', icon: '??', emoji: '💀', color: '#fa412d' },
  miss: { label: 'Упущенный шанс', icon: '×', emoji: '😬', color: '#ff7769' },
};

export const DEFAULTS = {
  depth: 12,
  movetime: 1500,
  multipv: 3,
};

const other = (color) => (color === 'w' ? 'b' : 'w');
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

export function winProbability(cp) {
  const value = clamp(Number(cp) || 0, -1000, 1000);
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * value)) - 1);
}

export function accuracyFromWinpLoss(lossWinp) {
  const loss = clamp(Number(lossWinp) || 0, 0, 100);
  return clamp(103.1668 * Math.exp(-0.04354 * loss) - 3.1669, 0, 100);
}

function lineWhiteCp(line, turn) {
  if (!line) return [0, null];
  if (line.score_type === 'mate') {
    const mateForSide = line.score;
    let cp = MATE_CP - Math.abs(mateForSide) * 100;
    if (mateForSide < 0) cp = -cp;
    return [turn === 'w' ? cp : -cp, turn === 'w' ? mateForSide : -mateForSide];
  }
  return [turn === 'w' ? line.score : -line.score, null];
}

const povCp = (whiteCp, color) => (color === 'w' ? whiteCp : -whiteCp);

// ---------------------------------------------------------------------------
// SEE: сколько материала сторона color выигрывает, взяв на target
// ---------------------------------------------------------------------------

function parseFenBoard(fen) {
  const board = {};
  const rows = fen.split(' ')[0].split('/');
  for (let r = 0; r < 8; r += 1) {
    let file = 0;
    for (const ch of rows[r]) {
      if (ch >= '1' && ch <= '8') {
        file += Number(ch);
        continue;
      }
      board[FILES[file] + (8 - r)] = ch;
      file += 1;
    }
  }
  return board;
}

const xyToSq = (x, y) => (x >= 0 && x < 8 && y >= 0 && y < 8 ? FILES[x] + (y + 1) : null);

function attackersMap(board, color) {
  const result = {};
  const add = (target, source) => {
    if (!target) return;
    if (!result[target]) result[target] = new Set();
    result[target].add(source);
  };

  for (const [sq, piece] of Object.entries(board)) {
    const isWhite = piece === piece.toUpperCase();
    if ((isWhite && color !== 'w') || (!isWhite && color !== 'b')) continue;
    const x = FILES.indexOf(sq[0]);
    const y = Number(sq[1]) - 1;
    const kind = piece.toLowerCase();
    if (kind === 'p') {
      const dy = isWhite ? 1 : -1;
      for (const dx of [-1, 1]) add(xyToSq(x + dx, y + dy), sq);
    } else if (kind === 'n') {
      for (const [dx, dy] of KNIGHT_DELTAS) add(xyToSq(x + dx, y + dy), sq);
    } else if (kind === 'k') {
      for (const [dx, dy] of KING_DELTAS) add(xyToSq(x + dx, y + dy), sq);
    } else {
      const dirs = [];
      if (kind === 'b' || kind === 'q') dirs.push(...BISHOP_DIRS);
      if (kind === 'r' || kind === 'q') dirs.push(...ROOK_DIRS);
      for (const [dx, dy] of dirs) {
        let nx = x + dx;
        let ny = y + dy;
        for (;;) {
          const target = xyToSq(nx, ny);
          if (!target) break;
          add(target, sq);
          if (board[target]) break;
          nx += dx;
          ny += dy;
        }
      }
    }
  }
  return result;
}

function see(board, target, color, depth = 0) {
  if (!board[target] || depth > 8) return 0;
  const attackers = attackersMap(board, color)[target];
  if (!attackers || attackers.size === 0) return 0;
  const victim = PIECE_VALUE[board[target].toLowerCase()] || 0;
  let best = 0;
  for (const source of attackers) {
    const piece = board[source];
    const next = { ...board };
    delete next[source];
    next[target] = piece;
    const value = victim - see(next, target, other(color), depth + 1);
    if (value > best) best = value;
  }
  return best;
}

function material(board, color) {
  let total = 0;
  for (const piece of Object.values(board)) {
    const value = PIECE_VALUE[piece.toLowerCase()] || 0;
    const isWhite = piece === piece.toUpperCase();
    total += isWhite === (color === 'w') ? value : -value;
  }
  return total;
}

function materialChess(chess, color) {
  let total = 0;
  for (const row of chess.board()) {
    for (const square of row) {
      if (!square) continue;
      const value = PIECE_VALUE[square.type] || 0;
      total += square.color === color ? value : -value;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Классификация
// ---------------------------------------------------------------------------

export function classify({ isBest, lossWinp, beforeCp, afterCp, sacrifice, movedValue, gapCp }) {
  if (isBest) {
    if (sacrifice && movedValue >= 3 && afterCp >= 30 && beforeCp >= -100 && beforeCp <= 500) {
      return 'brilliant';
    }
    if (gapCp >= 100 && beforeCp >= -300 && beforeCp <= 300) return 'great';
    return 'best';
  }

  let category;
  if (lossWinp < 2) category = 'excellent';
  else if (lossWinp < 5) category = 'good';
  else if (lossWinp < 10) category = 'inaccuracy';
  else if (lossWinp < 20) category = 'mistake';
  else category = 'blunder';

  if ((category === 'mistake' || category === 'blunder') && beforeCp >= 200 && afterCp <= 50) {
    return 'miss';
  }
  return category;
}

function terminalLines(fen) {
  const chess = new Chess(fen);
  if (chess.isCheckmate()) {
    return [{ depth: 0, multipv: 1, score_type: 'mate', score: -1, pv: [] }];
  }
  if (chess.isStalemate()) {
    return [{ depth: 0, multipv: 1, score_type: 'cp', score: 0, pv: [] }];
  }
  return [];
}

export function scoreMove(fenBefore, fenAfter, played, bestBefore, linesBefore, linesAfter) {
  const mover = fenBefore.split(' ')[1];
  if (!linesBefore || !linesBefore.length) linesBefore = terminalLines(fenBefore);
  if (!linesAfter || !linesAfter.length) linesAfter = terminalLines(fenAfter);
  if (!linesBefore.length || !linesAfter.length) {
    throw new Error('Stockfish не вернул оценку позиции');
  }

  const [scoreBefore, mateBefore] = lineWhiteCp(linesBefore[0], mover);
  const beforeCp = povCp(scoreBefore, mover);

  const [scoreAfter, mateAfterWhite] = lineWhiteCp(linesAfter[0], other(mover));
  const afterCp = povCp(scoreAfter, mover);

  const winpBefore = winProbability(beforeCp);
  const winpAfter = winProbability(afterCp);
  const lossWinp = Math.max(0, winpBefore - winpAfter);

  let gapCp = 0;
  if (linesBefore.length > 1) {
    const [secondWhite] = lineWhiteCp(linesBefore[1], mover);
    gapCp = Math.abs(beforeCp - povCp(secondWhite, mover));
  }

  const isBest = Boolean(bestBefore && played === bestBefore);

  const boardBefore = parseFenBoard(fenBefore);
  const boardAfter = parseFenBoard(fenAfter);
  const movedPiece = boardBefore[played.slice(0, 2)] || '';
  const movedValue = PIECE_VALUE[movedPiece.toLowerCase()] || 0;
  const seeGain = see(boardAfter, played.slice(2, 4), other(mover));

  // Жертва: смотрим главный вариант после хода и падение материала.
  const pv = (linesAfter[0].pv || []).slice(0, 8);
  let bestReplyIsCapture = false;
  const probe = new Chess(fenAfter);
  const matStart = material(boardAfter, mover);
  let matPv = matStart;
  for (let i = 0; i < pv.length; i += 1) {
    const uci = pv[i];
    if (i === 0 && boardAfter[uci.slice(2, 4)]) bestReplyIsCapture = true;
    try {
      const applied = probe.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] || undefined });
      if (!applied) break;
    } catch (error) {
      break;
    }
    matPv = materialChess(probe, mover);
  }
  const pvDrop = matStart - matPv;
  const declinedSacrifice = !bestReplyIsCapture && seeGain >= 2.0;
  const materialGiven = pvDrop >= 1.5;
  const sacrifice = seeGain >= 1.5 && (materialGiven || declinedSacrifice);

  const category = classify({
    isBest, lossWinp, beforeCp, afterCp, sacrifice, movedValue, gapCp,
  });

  const cpLoss = clamp(beforeCp - afterCp, 0, 1000);
  const accuracy = accuracyFromWinpLoss(lossWinp);
  const meta = CATEGORIES[category];

  return {
    uci: played,
    color: mover,
    category,
    label: meta.label,
    icon: meta.icon,
    emoji: meta.emoji,
    color_hex: meta.color,
    eval_before: Math.round(beforeCp * 10) / 10,
    eval_after: Math.round(afterCp * 10) / 10,
    eval_before_white: Math.round(scoreBefore * 10) / 10,
    eval_after_white: Math.round(scoreAfter * 10) / 10,
    mate_before_white: mateBefore,
    mate_after_white: mateAfterWhite,
    best_move: bestBefore || null,
    depth: Math.max(linesBefore[0].depth || 0, linesAfter[0].depth || 0),
    loss_winp: Math.round(lossWinp * 100) / 100,
    cp_loss: Math.round(cpLoss * 10) / 10,
    accuracy: Math.round(accuracy * 10) / 10,
    is_sacrifice: sacrifice,
    see_gain: Math.round(seeGain * 100) / 100,
    pv_drop: Math.round(pvDrop * 100) / 100,
  };
}

// ---------------------------------------------------------------------------
// Stockfish WASM в Web Worker
// ---------------------------------------------------------------------------

function parseInfo(line) {
  const tokens = line.split(/\s+/);
  const info = { depth: 0, multipv: 1, score_type: null, score: 0, pv: [] };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === 'depth') {
      info.depth = Number(tokens[i + 1]) || 0;
    } else if (token === 'multipv') {
      info.multipv = Number(tokens[i + 1]) || 1;
    } else if (token === 'score') {
      const kind = tokens[i + 1];
      const value = Number(tokens[i + 2]);
      info.score_type = kind === 'mate' ? 'mate' : 'cp';
      info.score = Number.isFinite(value) ? value : 0;
      i += 2;
    } else if (token === 'pv') {
      info.pv = tokens.slice(i + 1);
      break;
    }
  }
  return info.pv.length ? info : null;
}

export class Engine {
  constructor(url = ENGINE_URL) {
    this.url = url;
    this.worker = null;
    this.ready = null;
    this.waiters = [];
    this.onSearchLine = null;
    this.queue = Promise.resolve();
    this.name = 'Stockfish';
  }

  _send(command) {
    if (this.worker) this.worker.postMessage(command);
  }

  _onLine(raw) {
    for (const text of String(raw).split('\n')) {
      const line = text.trim();
      if (!line) continue;
      if (line.startsWith('id name ')) this.name = line.slice(8).trim();
      for (const waiter of this.waiters.slice()) {
        if (waiter.test(line)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
      if (this.onSearchLine) this.onSearchLine(line);
    }
  }

  _waitFor(test) {
    return new Promise((resolve) => this.waiters.push({ test, resolve }));
  }

  start() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this.url);
      } catch (error) {
        reject(new Error('Не удалось запустить движок: ' + error.message));
        return;
      }
      this.worker.onerror = (event) => {
        reject(new Error(event.message || 'движок не загрузился'));
      };
      this.worker.onmessage = (event) => this._onLine(event.data);
      this._send('uci');
      this._waitFor((line) => line === 'uciok')
        .then(() => {
          this._send('setoption name Threads value 1');
          this._send('setoption name Hash value 32');
          this._send('isready');
          return this._waitFor((line) => line === 'readyok');
        })
        .then(() => resolve())
        .catch(reject);
    });
    return this.ready;
  }

  async _search(fen, depth, multipv, movetime) {
    await this.start();
    this._send(`setoption name MultiPV value ${Math.max(1, Math.floor(multipv))}`);
    this._send(`position fen ${fen}`);
    const lines = new Map();
    let bestmove = null;

    const finished = new Promise((resolve) => {
      this.onSearchLine = (line) => {
        if (line.startsWith('bestmove')) {
          const parts = line.split(/\s+/);
          bestmove = parts[1] && parts[1] !== '(none)' ? parts[1] : null;
          this.onSearchLine = null;
          resolve();
          return;
        }
        if (!line.startsWith('info') || !line.includes(' pv ')) return;
        const info = parseInfo(line);
        if (!info) return;
        const previous = lines.get(info.multipv);
        if (!previous || info.depth >= previous.depth) lines.set(info.multipv, info);
      };
    });

    this._send(`go depth ${depth} movetime ${movetime}`);
    await finished;
    return {
      bestmove,
      lines: [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value),
    };
  }

  analyse(fen, depth, multipv, movetime) {
    const task = () => this._search(fen, depth, multipv, movetime);
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => {});
    return result;
  }

  stop() {
    this._send('stop');
  }

  terminate() {
    if (this.worker) this.worker.terminate();
    this.worker = null;
    this.ready = null;
    this.waiters = [];
    this.onSearchLine = null;
  }
}

// ---------------------------------------------------------------------------
// Разбор партии
// ---------------------------------------------------------------------------

export async function reviewGame({ engine, pgn, depth = DEFAULTS.depth, movetime = DEFAULTS.movetime,
                                   multipv = DEFAULTS.multipv, onProgress, onPhase, shouldCancel }) {
  const chess = new Chess();
  chess.loadPgn(pgn);
  const headers = chess.header();
  const history = chess.history({ verbose: true });
  const cache = new Map();

  async function evalFen(fen) {
    if (cache.has(fen)) return cache.get(fen);
    const probe = new Chess(fen);
    let result;
    if (probe.isCheckmate() || probe.isStalemate()) {
      result = { bestmove: null, lines: terminalLines(fen) };
    } else {
      result = await engine.analyse(fen, depth, multipv, movetime);
      if (!result.lines || !result.lines.length) {
        result = { bestmove: result.bestmove, lines: [{ depth: 0, multipv: 1, score_type: 'cp', score: 0, pv: [] }] };
      }
    }
    cache.set(fen, result);
    return result;
  }

  const results = [];
  const total = history.length;
  for (let index = 0; index < total; index += 1) {
    if (shouldCancel && shouldCancel()) break;
    const move = history[index];
    if (onPhase) onPhase('search', index + 1, total);
    const before = await evalFen(move.before);
    const after = await evalFen(move.after);
    const played = move.from + move.to + (move.promotion || '');
    const scored = scoreMove(move.before, move.after, played, before.bestmove, before.lines, after.lines);
    scored.san = move.san;
    scored.color = move.color;
    scored.move_number = Number(move.before.split(' ')[5]) || 1;
    results.push(scored);
    if (onProgress) onProgress(index + 1, total, scored);
  }

  return { headers, moves: results, total };
}
