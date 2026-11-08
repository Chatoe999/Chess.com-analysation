#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Chess.com Live Coach — локальный сервер оценки ходов.

Зависимости: только стандартная библиотека Python 3 и бинарник Stockfish
(пакет `stockfish`, обычно /usr/games/stockfish).

Запуск:
    python3 server.py
    python3 server.py --depth 18 --port 8765
    python3 server.py --engine /путь/к/stockfish

Сервер слушает только 127.0.0.1: принимает запросы от userscript'а
и раздаёт статический сайт из docs/.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import traceback
from collections import Counter, OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

# --------------------------------------------------------------------------
# Мини-шахматы: FEN, применение хода, мат-оценка, SEE
# --------------------------------------------------------------------------

FILES = "abcdefgh"
PIECE_VALUE = {"p": 1, "n": 3, "b": 3, "r": 5, "q": 9, "k": 0}
MATE_CP = 100000

KNIGHT_DELTAS = [(1, 2), (2, 1), (2, -1), (1, -2), (-1, -2), (-2, -1), (-2, 1), (-1, 2)]
KING_DELTAS = [(1, 0), (1, 1), (0, 1), (-1, 1), (-1, 0), (-1, -1), (0, -1), (1, -1)]
BISHOP_DIRS = [(1, 1), (1, -1), (-1, 1), (-1, -1)]
ROOK_DIRS = [(1, 0), (-1, 0), (0, 1), (0, -1)]


def other(color: str) -> str:
    return "b" if color == "w" else "w"


def sq_to_xy(sq: str):
    return FILES.index(sq[0]), int(sq[1]) - 1


def xy_to_sq(x: int, y: int):
    if 0 <= x < 8 and 0 <= y < 8:
        return FILES[x] + str(y + 1)
    return None


def parse_fen(fen: str) -> dict:
    parts = fen.strip().split()
    if len(parts) < 2:
        raise ValueError("Некорректный FEN: " + fen)
    board = {}
    for r, row in enumerate(parts[0].split("/")):
        rank = 8 - r
        file_idx = 0
        for ch in row:
            if ch.isdigit():
                file_idx += int(ch)
            elif ch in "pnbrqkPNBRQK":
                if file_idx >= 8:
                    raise ValueError("Некорректный FEN: " + fen)
                board[FILES[file_idx] + str(rank)] = ch
                file_idx += 1
            else:
                raise ValueError("Некорректный FEN: " + fen)
    return {
        "board": board,
        "turn": parts[1] if parts[1] in ("w", "b") else "w",
        "castling": parts[2] if len(parts) > 2 else "-",
        "ep": parts[3] if len(parts) > 3 else "-",
        "half": int(parts[4]) if len(parts) > 4 and parts[4].isdigit() else 0,
        "full": int(parts[5]) if len(parts) > 5 and parts[5].isdigit() else 1,
    }


def board_to_fen(board: dict, turn: str, castling: str, ep: str, half: int, full: int) -> str:
    rows = []
    for rank in range(8, 0, -1):
        row = ""
        empty = 0
        for file in FILES:
            piece = board.get(file + str(rank))
            if piece is None:
                empty += 1
            else:
                if empty:
                    row += str(empty)
                    empty = 0
                row += piece
        if empty:
            row += str(empty)
        rows.append(row)
    return f"{'/'.join(rows)} {turn} {castling or '-'} {ep or '-'} {half} {full}"


def apply_uci(fen: str, uci: str):
    """Применяет ход UCI к FEN. Ход считается легальным (проверки нет)."""
    if not uci or len(uci) < 4:
        return None
    st = parse_fen(fen)
    board = dict(st["board"])
    turn = st["turn"]
    src, dst = uci[0:2], uci[2:4]
    promo = uci[4:5].lower()
    piece = board.pop(src, None)
    if piece is None or src == dst:
        return None

    captured = board.get(dst)

    # Взятие на проходе
    if piece.lower() == "p" and src[0] != dst[0] and captured is None:
        board.pop(dst[0] + src[1], None)

    # Рокировка: двигаем ладью
    if piece.lower() == "k" and abs(FILES.index(src[0]) - FILES.index(dst[0])) == 2:
        if dst[0] == "g":
            rook_from, rook_to = "h" + src[1], "f" + src[1]
        else:
            rook_from, rook_to = "a" + src[1], "d" + src[1]
        rook = board.pop(rook_from, None)
        if rook:
            board[rook_to] = rook

    board[dst] = piece
    if promo:
        board[dst] = promo if piece.islower() else promo.upper()

    # Права на рокировку
    castling = st["castling"]
    if piece.lower() == "k":
        castling = castling.replace("K", "").replace("Q", "") if piece.isupper() else castling.replace("k", "").replace("q", "")
    for square, rights in (("a1", "Q"), ("h1", "K"), ("a8", "q"), ("h8", "k")):
        if src == square or dst == square:
            castling = castling.replace(rights, "")
    if not castling or castling == "":
        castling = "-"

    # Поле для взятия на проходе
    ep = "-"
    if piece.lower() == "p" and abs(int(src[1]) - int(dst[1])) == 2:
        ep = dst[0] + str((int(src[1]) + int(dst[1])) // 2)

    half = 0 if (piece.lower() == "p" or captured) else st["half"] + 1
    full = st["full"] + (1 if turn == "b" else 0)
    return board_to_fen(board, other(turn), castling, ep, half, full)


def derive_move(fen_before: str, fen_after: str):
    """Возвращает UCI-ход, который превратил одну позицию в другую."""
    before = parse_fen(fen_before)
    after = parse_fen(fen_after)
    a, b = before["board"], after["board"]
    mover = before["turn"]

    def is_mover(piece):
        return piece.isupper() if mover == "w" else piece.islower()

    # Рокировка
    king_from = next((sq for sq, p in a.items() if p.lower() == "k" and is_mover(p)), None)
    king_to = next((sq for sq, p in b.items() if p.lower() == "k" and is_mover(p)), None)
    if king_from and king_to and king_from != king_to:
        if abs(FILES.index(king_from[0]) - FILES.index(king_to[0])) == 2:
            return king_from + king_to

    squares = set(a) | set(b)
    removed = [sq for sq in squares if a.get(sq) and is_mover(a[sq]) and a.get(sq) != b.get(sq)]
    added = [sq for sq in squares if b.get(sq) and is_mover(b[sq]) and a.get(sq) != b.get(sq)]

    if len(removed) == 1 and len(added) == 1:
        src, dst = removed[0], added[0]
        uci = src + dst
        if a[src].lower() == "p" and b[dst].lower() != "p":
            uci += b[dst].lower()
        return uci
    return None


START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"


def king_square(board: dict, color: str):
    target = "K" if color == "w" else "k"
    for square, piece in board.items():
        if piece == target:
            return square
    return None


def in_check(board: dict, color: str) -> bool:
    square = king_square(board, color)
    if not square:
        return False
    return bool(attackers_map(board, other(color)).get(square))


def legal_moves(fen: str) -> list:
    """Все легальные ходы позиции в UCI. Без внешних библиотек."""
    state = parse_fen(fen)
    board = state["board"]
    turn = state["turn"]
    pseudo = []

    def own(piece):
        return bool(piece) and piece.isupper() == (turn == "w")

    def foe(piece):
        return bool(piece) and piece.isupper() != (turn == "w")

    promo_rank = "8" if turn == "w" else "1"

    for square, piece in board.items():
        if not own(piece):
            continue
        x, y = sq_to_xy(square)
        kind = piece.lower()
        if kind == "p":
            dy = 1 if turn == "w" else -1
            one = xy_to_sq(x, y + dy)
            if one and one not in board:
                if one[1] == promo_rank:
                    pseudo += [square + one + p for p in "qrbn"]
                else:
                    pseudo.append(square + one)
                    two = xy_to_sq(x, y + 2 * dy)
                    if square[1] == ("2" if turn == "w" else "7") and two and two not in board:
                        pseudo.append(square + two)
            for dx in (-1, 1):
                target = xy_to_sq(x + dx, y + dy)
                if not target:
                    continue
                if target in board and foe(board[target]):
                    if target[1] == promo_rank:
                        pseudo += [square + target + p for p in "qrbn"]
                    else:
                        pseudo.append(square + target)
                elif state["ep"] != "-" and target == state["ep"]:
                    pseudo.append(square + target)
        elif kind == "n":
            for dx, dy in KNIGHT_DELTAS:
                target = xy_to_sq(x + dx, y + dy)
                if target and (target not in board or foe(board[target])):
                    pseudo.append(square + target)
        elif kind == "k":
            for dx, dy in KING_DELTAS:
                target = xy_to_sq(x + dx, y + dy)
                if target and (target not in board or foe(board[target])):
                    pseudo.append(square + target)
        else:
            directions = []
            if kind in ("r", "q"):
                directions += ROOK_DIRS
            if kind in ("b", "q"):
                directions += BISHOP_DIRS
            for dx, dy in directions:
                for step in range(1, 8):
                    target = xy_to_sq(x + dx * step, y + dy * step)
                    if not target:
                        break
                    if target in board:
                        if foe(board[target]):
                            pseudo.append(square + target)
                        break
                    pseudo.append(square + target)

    # Рокировка: король перепрыгивает клетку, поэтому проверяем её отдельно.
    rank = "1" if turn == "w" else "8"
    rights = ("K", "Q") if turn == "w" else ("k", "q")
    if king_square(board, turn) == "e" + rank:
        for right, rook_file, empty_files, transit in (
            (rights[0], "h", ("f", "g"), "f"),
            (rights[1], "a", ("b", "c", "d"), "d"),
        ):
            if right not in state["castling"]:
                continue
            if board.get(rook_file + rank, "").lower() != "r":
                continue
            if any(name + rank in board for name in empty_files):
                continue
            if in_check(board, turn):
                continue
            step_fen = apply_uci(fen, "e" + rank + transit + rank)
            if not step_fen or in_check(parse_fen(step_fen)["board"], turn):
                continue
            pseudo.append("e" + rank + ("g" if right in ("K", "k") else "c") + rank)

    legal = []
    for uci in pseudo:
        after = apply_uci(fen, uci)
        if not after:
            continue
        if not in_check(parse_fen(after)["board"], turn):
            legal.append(uci)
    return legal


def material(board: dict, color: str) -> int:
    """Материал с точки зрения color (свои минус чужие), в пешках."""
    total = 0
    for piece in board.values():
        value = PIECE_VALUE[piece.lower()]
        total += value if (piece.isupper() == (color == "w")) else -value
    return total


def attackers_map(board: dict, color: str) -> dict:
    """Квадрат -> множество клеток, откуда color может туда пойти/взять."""
    result = {}

    def add(target, source):
        if target:
            result.setdefault(target, set()).add(source)

    for sq, piece in board.items():
        if (piece.isupper() and color != "w") or (piece.islower() and color != "b"):
            continue
        x, y = sq_to_xy(sq)
        kind = piece.lower()
        if kind == "p":
            dy = 1 if piece.isupper() else -1
            for dx in (-1, 1):
                add(xy_to_sq(x + dx, y + dy), sq)
        elif kind == "n":
            for dx, dy in KNIGHT_DELTAS:
                add(xy_to_sq(x + dx, y + dy), sq)
        elif kind == "k":
            for dx, dy in KING_DELTAS:
                add(xy_to_sq(x + dx, y + dy), sq)
        else:
            dirs = []
            if kind in ("b", "q"):
                dirs += BISHOP_DIRS
            if kind in ("r", "q"):
                dirs += ROOK_DIRS
            for dx, dy in dirs:
                nx, ny = x + dx, y + dy
                while True:
                    target = xy_to_sq(nx, ny)
                    if not target:
                        break
                    add(target, sq)
                    if target in board:
                        break
                    nx += dx
                    ny += dy
    return result


def see(board: dict, target: str, color: str, depth: int = 0):
    """Простое SEE: сколько материала color выигрывает, взяв на target."""
    if target not in board or depth > 8:
        return 0
    attackers = attackers_map(board, color).get(target, set())
    if not attackers:
        return 0
    victim_value = PIECE_VALUE[board[target].lower()]
    best = 0
    for source in attackers:
        piece = board[source]
        new_board = dict(board)
        new_board.pop(source, None)
        new_board[target] = piece
        value = victim_value - see(new_board, target, other(color), depth + 1)
        if value > best:
            best = value
    return best


def san_approx(fen: str, uci: str) -> str:
    """Приблизительная SAN-запись хода (без шаха и уточнений)."""
    if not uci or len(uci) < 4:
        return uci or "?"
    st = parse_fen(fen)
    board = st["board"]
    src, dst, promo = uci[0:2], uci[2:4], uci[4:5].lower()
    piece = board.get(src)
    if not piece:
        return uci
    if piece.lower() == "k" and abs(FILES.index(src[0]) - FILES.index(dst[0])) == 2:
        return "O-O" if dst[0] == "g" else "O-O-O"
    capture = dst in board or (piece.lower() == "p" and src[0] != dst[0])
    if piece.lower() == "p":
        text = (src[0] + "x" if capture else "") + dst
    else:
        text = piece.upper() + ("x" if capture else "") + dst
    if promo:
        text += "=" + promo.upper()
    return text


# --------------------------------------------------------------------------
# Оценка и классификация
# --------------------------------------------------------------------------

CATEGORIES = {
    "brilliant": {"label": "Блестящий ход", "icon": "!!", "emoji": "💎", "color": "#26c2a3"},
    "great": {"label": "Отличный ход", "icon": "!", "emoji": "🔥", "color": "#5c8bb0"},
    "best": {"label": "Лучший ход", "icon": "★", "emoji": "✅", "color": "#81b64c"},
    "excellent": {"label": "Превосходно", "icon": "", "emoji": "👍", "color": "#96bc4b"},
    "good": {"label": "Хороший ход", "icon": "", "emoji": "🙂", "color": "#95af8a"},
    "inaccuracy": {"label": "Неточность", "icon": "?!", "emoji": "🤔", "color": "#f7c631"},
    "mistake": {"label": "Ошибка", "icon": "?", "emoji": "❌", "color": "#ffa459"},
    "blunder": {"label": "Зевок", "icon": "??", "emoji": "💀", "color": "#fa412d"},
    "miss": {"label": "Упущенный шанс", "icon": "×", "emoji": "😬", "color": "#ff7769"},
}


def win_probability(cp: float) -> float:
    """Вероятность победы (0..100) по оценке в сантипешках (формула Lichess)."""
    cp = max(-1000.0, min(1000.0, float(cp)))
    return 50.0 + 50.0 * (2.0 / (1.0 + math.exp(-0.00368208 * cp)) - 1.0)


def line_white_cp(line: dict, turn: str):
    """Оценка линии с точки зрения белых + мат для белых."""
    score_type = line.get("score_type")
    value = line.get("score", 0)
    if score_type == "mate":
        mate_for_side = value
        cp = MATE_CP - abs(value) * 100
        if value < 0:
            cp = -cp
        white_cp = cp if turn == "w" else -cp
        mate_white = mate_for_side if turn == "w" else -mate_for_side
        return white_cp, mate_white
    cp = value
    white_cp = cp if turn == "w" else -cp
    return white_cp, None


def pov_cp(white_cp: float, color: str) -> float:
    return white_cp if color == "w" else -white_cp


def accuracy_from_winp_loss(loss_winp: float) -> float:
    """Точность по потере win-вероятности (0..100), как в Lichess."""
    loss_winp = max(0.0, min(100.0, loss_winp))
    value = 103.1668 * math.exp(-0.04354 * loss_winp) - 3.1669
    return max(0.0, min(100.0, value))


def classify(
    is_best: bool,
    loss_winp: float,
    before_cp: float,
    after_cp: float,
    sacrifice: bool,
    moved_value: int,
    gap_cp: float,
):
    if is_best:
        if sacrifice and moved_value >= 3 and after_cp >= 30 and before_cp >= -100 and before_cp <= 500:
            return "brilliant"
        if gap_cp >= 100 and -300 <= before_cp <= 300:
            return "great"
        return "best"

    if loss_winp < 2:
        category = "excellent"
    elif loss_winp < 5:
        category = "good"
    elif loss_winp < 10:
        category = "inaccuracy"
    elif loss_winp < 20:
        category = "mistake"
    else:
        category = "blunder"

    if category in ("mistake", "blunder") and before_cp >= 200 and after_cp <= 50:
        return "miss"
    return category


# --------------------------------------------------------------------------
# Stockfish (UCI через stdin/stdout)
# --------------------------------------------------------------------------

class EngineError(RuntimeError):
    pass


class Stockfish:
    def __init__(self, path: str, threads: int = 2, hash_mb: int = 128):
        self.path = path
        self.lock = threading.Lock()
        self.proc = subprocess.Popen(
            [path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        if not self.proc.stdin or not self.proc.stdout:
            raise EngineError("Не удалось запустить Stockfish")
        self.name = "Stockfish"
        self.cache: OrderedDict = OrderedDict()
        self.cache_lock = threading.Lock()
        self.cache_limit = 120
        self._send("uci")
        while True:
            line = self._readline()
            if line.startswith("id name"):
                self.name = line[8:].strip()
            if line.strip() == "uciok":
                break
        self._send(f"setoption name Threads value {max(1, threads)}")
        self._send(f"setoption name Hash value {max(16, hash_mb)}")
        self._send("isready")
        while self._readline().strip() != "readyok":
            pass

    def _send(self, command: str):
        if self.proc.poll() is not None:
            raise EngineError("Stockfish завершился")
        assert self.proc.stdin
        self.proc.stdin.write(command + "\n")
        self.proc.stdin.flush()

    def _readline(self) -> str:
        assert self.proc.stdout
        line = self.proc.stdout.readline()
        if line == "":
            raise EngineError("Stockfish не отвечает")
        return line.rstrip("\n")

    def analyse(self, fen: str, depth: int, multipv: int = 1, movetime_ms: int = 2500):
        key = (fen, depth, multipv, movetime_ms)
        # Результат, дошедший до нужной глубины, не зависит от лимита времени.
        canonical = (fen, depth, multipv, None)
        with self.cache_lock:
            if key in self.cache:
                self.cache.move_to_end(key)
                return self.cache[key]
            if canonical in self.cache:
                self.cache.move_to_end(canonical)
                return self.cache[canonical]

        with self.lock:
            self._send(f"setoption name MultiPV value {max(1, multipv)}")
            self._send("position fen " + fen)
            self._send(f"go depth {depth} movetime {movetime_ms}")
            lines = {}
            bestmove = None
            while True:
                line = self._readline()
                if line.startswith("bestmove"):
                    parts = line.split()
                    bestmove = parts[1] if len(parts) > 1 and parts[1] != "(none)" else None
                    break
                if not line.startswith("info") or " pv " not in line:
                    continue
                tokens = line.split()
                parsed = {"depth": 0, "multipv": 1, "score_type": None, "score": 0, "pv": []}
                i = 0
                while i < len(tokens):
                    token = tokens[i]
                    if token == "depth" and i + 1 < len(tokens):
                        try:
                            parsed["depth"] = int(tokens[i + 1])
                        except ValueError:
                            pass
                        i += 2
                    elif token == "multipv" and i + 1 < len(tokens):
                        try:
                            parsed["multipv"] = int(tokens[i + 1])
                        except ValueError:
                            pass
                        i += 2
                    elif token == "score" and i + 2 < len(tokens):
                        parsed["score_type"] = tokens[i + 1]
                        try:
                            parsed["score"] = int(tokens[i + 2])
                        except ValueError:
                            parsed["score"] = 0
                        i += 3
                    elif token == "pv":
                        parsed["pv"] = tokens[i + 1:]
                        break
                    else:
                        i += 1
                index = parsed["multipv"]
                if index not in lines or parsed["depth"] >= lines[index]["depth"]:
                    lines[index] = parsed
            result = [lines[k] for k in sorted(lines)]
            reached = max((line.get("depth", 0) for line in result), default=0) >= depth
            with self.cache_lock:
                self.cache[key] = (bestmove, result)
                if reached:
                    self.cache[canonical] = (bestmove, result)
                while len(self.cache) > self.cache_limit:
                    self.cache.popitem(last=False)
            return bestmove, result


# --------------------------------------------------------------------------
# Анализ хода
# --------------------------------------------------------------------------

class Analyzer:
    def __init__(self, engine: Stockfish, depth: int = 16, movetime_ms: int = 1600):
        self.engine = engine
        self.depth = depth
        self.movetime_ms = movetime_ms

    def analyse_move(self, fen_before: str, fen_after: str, depth: int | None = None) -> dict:
        depth = depth or self.depth
        played = derive_move(fen_before, fen_after)
        if not played:
            raise ValueError("Не удалось определить сыгранный ход по двум FEN")

        best_before, lines_before = self.engine.analyse(
            fen_before, depth, multipv=3, movetime_ms=self.movetime_ms)
        # multipv=3 и здесь: следующая позиция придёт как «до» следующего хода
        # и возьмётся из кэша движка без повторного поиска.
        _, lines_after = self.engine.analyse(
            fen_after, depth, multipv=3, movetime_ms=self.movetime_ms)
        return score_move(fen_before, fen_after, played, best_before, lines_before, lines_after)


def terminal_line(fen: str) -> list:
    """Синтетическая оценка для позиции без ходов (мат или пат)."""
    state = parse_fen(fen)
    if legal_moves(fen):
        return []
    if in_check(state["board"], state["turn"]):
        return [{"depth": 0, "multipv": 1, "score_type": "mate", "score": -1, "pv": []}]
    return [{"depth": 0, "multipv": 1, "score_type": "cp", "score": 0, "pv": []}]


def score_move(fen_before: str, fen_after: str, played: str, best_before: str | None,
               lines_before: list, lines_after: list) -> dict:
    before = parse_fen(fen_before)
    after = parse_fen(fen_after)
    mover = before["turn"]

    if not lines_before:
        lines_before = terminal_line(fen_before)
    if not lines_after:
        lines_after = terminal_line(fen_after)
    if not lines_before or not lines_after:
        raise EngineError("Stockfish не вернул оценку позиции")

    score_before, mate_before = line_white_cp(lines_before[0], mover)
    before_cp = pov_cp(score_before, mover)

    score_after, mate_after_white = line_white_cp(lines_after[0], other(mover))
    after_cp = pov_cp(score_after, mover)

    winp_before = win_probability(before_cp)
    winp_after = win_probability(after_cp)
    loss_winp = max(0.0, winp_before - winp_after)

    # Разрыв между лучшим и вторым ходом — для «отличного» хода.
    gap_cp = 0.0
    if len(lines_before) > 1:
        second_white, _ = line_white_cp(lines_before[1], mover)
        gap_cp = abs(before_cp - pov_cp(second_white, mover))

    is_best = bool(best_before and played == best_before)

    # --- обнаружение жертвы ---
    board_before = before["board"]
    board_after = after["board"]
    moved_piece = board_before.get(played[0:2], "")
    moved_value = PIECE_VALUE.get(moved_piece.lower(), 0)
    see_gain = see(board_after, played[2:4], other(mover))

    pv = lines_after[0].get("pv", [])
    mat_start = material(board_after, mover)
    mat_pv = mat_start
    best_reply_is_capture = False
    current_fen = fen_after
    for index, pv_move in enumerate(pv[:8]):
        board_now = parse_fen(current_fen)["board"]
        if index == 0 and pv_move[2:4] in board_now:
            best_reply_is_capture = True
        next_fen = apply_uci(current_fen, pv_move)
        if not next_fen:
            break
        current_fen = next_fen
        mat_pv = material(parse_fen(current_fen)["board"], mover)

    pv_drop = mat_start - mat_pv
    declined_sacrifice = (not best_reply_is_capture) and see_gain >= 2.0
    material_given = pv_drop >= 1.5
    sacrifice = bool(see_gain >= 1.5 and (material_given or declined_sacrifice))

    category = classify(
        is_best=is_best,
        loss_winp=loss_winp,
        before_cp=before_cp,
        after_cp=after_cp,
        sacrifice=sacrifice,
        moved_value=moved_value,
        gap_cp=gap_cp,
    )

    cp_loss = max(0.0, min(1000.0, before_cp - after_cp))
    accuracy = accuracy_from_winp_loss(loss_winp)

    meta = CATEGORIES[category]
    return {
        "uci": played,
        "san": san_approx(fen_before, played),
        "color": mover,
        "move_number": before["full"],
        "category": category,
        "label": meta["label"],
        "icon": meta["icon"],
        "emoji": meta["emoji"],
        "color_hex": meta["color"],
        "eval_before": round(before_cp, 1),
        "eval_after": round(after_cp, 1),
        "eval_before_white": round(score_before, 1),
        "eval_after_white": round(score_after, 1),
        "mate_before_white": mate_before,
        "mate_after_white": mate_after_white,
        "best_move": best_before,
        "best_move_san": san_approx(fen_before, best_before) if best_before else None,
        "depth": max(lines_before[0].get("depth", 0), lines_after[0].get("depth", 0)),
        "loss_winp": round(loss_winp, 2),
        "cp_loss": round(cp_loss, 1),
        "accuracy": round(accuracy, 1),
        "is_sacrifice": sacrifice,
        "see_gain": round(see_gain, 2),
        "pv_drop": round(pv_drop, 2),
    }


# --------------------------------------------------------------------------
# Хранилище партий
# --------------------------------------------------------------------------

GAMES = {}
GAMES_LOCK = threading.Lock()
EVENTS = []
EVENTS_LOCK = threading.Lock()
EVENT_SEQ = 0
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
GAMES_DIR = os.path.join(BASE_DIR, "games")


def safe_name(text: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", text)[:120] or "game"


def record_move(game_id: str, move: dict):
    global EVENT_SEQ
    with EVENTS_LOCK:
        EVENT_SEQ += 1
        move["seq"] = EVENT_SEQ
        EVENTS.append(move)
        if len(EVENTS) > 600:
            del EVENTS[:-600]
    with GAMES_LOCK:
        if game_id not in GAMES and len(GAMES) > 30:
            oldest = min(GAMES, key=lambda key: GAMES[key].get("created", 0))
            GAMES.pop(oldest, None)
        game = GAMES.setdefault(game_id, {"created": time.time(), "moves": []})
        game["moves"].append(move)
        if len(game["moves"]) > 600:
            game["moves"] = game["moves"][-600:]
    try:
        os.makedirs(GAMES_DIR, exist_ok=True)
        path = os.path.join(GAMES_DIR, safe_name(game_id) + ".jsonl")
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(move, ensure_ascii=False) + "\n")
    except OSError:
        pass


def recent_events(since: int = 0):
    with EVENTS_LOCK:
        items = [move for move in EVENTS if move.get("seq", 0) > since]
        last = EVENT_SEQ
    return items, last


def summarize(game_id: str, player_color: str | None):
    with GAMES_LOCK:
        moves = list(GAMES.get(game_id, {}).get("moves", []))
    if player_color not in ("w", "b"):
        player_color = None
    player_moves = [m for m in moves if player_color is None or m["color"] == player_color]
    counts = Counter(m["category"] for m in player_moves)
    accuracy = round(sum(m.get("accuracy", 0) for m in player_moves) / len(player_moves), 1) if player_moves else 0
    acpl = round(sum(m.get("cp_loss", 0) for m in player_moves) / len(player_moves), 1) if player_moves else 0

    def worst_key(move):
        return (move.get("cp_loss", 0), -move.get("move_number", 0))

    worst = max(player_moves, key=worst_key) if player_moves else None
    best = min(player_moves, key=lambda m: m.get("cp_loss", 0)) if player_moves else None

    return {
        "ok": True,
        "game_id": game_id,
        "total_moves": len(moves),
        "player_moves": len(player_moves),
        "player_color": player_color,
        "accuracy": accuracy,
        "acpl": acpl,
        "counts": dict(counts),
        "worst": worst,
        "best": best,
        "finished_at": time.time(),
    }


# --------------------------------------------------------------------------
# HTTP
# --------------------------------------------------------------------------

ANSI = {
    "reset": "\033[0m",
    "dim": "\033[2m",
    "bold": "\033[1m",
    "green": "\033[92m",
    "yellow": "\033[93m",
    "red": "\033[91m",
    "cyan": "\033[96m",
    "blue": "\033[94m",
    "magenta": "\033[95m",
}
CATEGORY_ANSI = {
    "brilliant": "cyan",
    "great": "blue",
    "best": "green",
    "excellent": "green",
    "good": "green",
    "inaccuracy": "yellow",
    "mistake": "yellow",
    "blunder": "red",
    "miss": "magenta",
}


def colorize(text: str, color: str) -> str:
    return f"{ANSI.get(color, '')}{text}{ANSI['reset']}"


DOCS_DIR = os.path.join(BASE_DIR, "docs")
ALLOWED_ORIGINS = {
    "https://www.chess.com",
    "https://chess.com",
    "http://127.0.0.1:8765",
    "http://localhost:8765",
}
MIME_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
}


class CoachHandler(BaseHTTPRequestHandler):
    analyzer: Analyzer | None = None
    depth: int = 16
    quiet: bool = False

    def log_message(self, fmt, *args):
        return

    def _cors_origin(self):
        origin = self.headers.get("Origin")
        return origin if origin in ALLOWED_ORIGINS else None

    def _json(self, payload: dict, status: int = 200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self._json({})

    def _send_file(self, path: str, content_type: str):
        try:
            with open(path, "rb") as handle:
                body = handle.read()
        except OSError:
            return self._json({"ok": False, "error": "Файл не найден"}, 404)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        origin = self._cors_origin()
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _send_static(self, path: str):
        """Отдаёт файл из docs/, не выпуская путь за пределы каталога."""
        rel = path.lstrip("/") or "index.html"
        if rel.endswith("/"):
            rel += "index.html"
        root = os.path.realpath(DOCS_DIR)
        full = os.path.realpath(os.path.join(root, rel))
        if full != root and not full.startswith(root + os.sep):
            return self._json({"ok": False, "error": "Файл не найден"}, 404)
        if os.path.isdir(full):
            full = os.path.join(full, "index.html")
        if not os.path.isfile(full):
            return self._json({"ok": False, "error": "Файл не найден"}, 404)
        content_type = MIME_TYPES.get(os.path.splitext(full)[1].lower(), "application/octet-stream")
        return self._send_file(full, content_type)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            return self._json({
                "ok": self.analyzer is not None,
                "engine": getattr(self.analyzer.engine, "name", None) if self.analyzer else None,
                "depth": self.depth,
                "games": len(GAMES),
                "version": "1.3.0",
            })
        if parsed.path == "/events":
            query = parse_qs(parsed.query)
            try:
                since = int(query.get("since", ["0"])[0] or 0)
            except ValueError:
                since = 0
            items, last = recent_events(since)
            return self._json({"ok": True, "events": items, "last": last})
        if parsed.path == "/summary":
            query = parse_qs(parsed.query)
            return self._json(summarize(query.get("game_id", [""])[0], query.get("player_color", [None])[0]))
        return self._send_static(parsed.path)

    def do_POST(self):
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/analyze":
                return self._handle_analyze()
            if parsed.path == "/eval_position":
                return self._handle_eval_position()
            if parsed.path == "/summary":
                data = self._body()
                return self._json(summarize(data.get("game_id", ""), data.get("player_color")))
            if parsed.path == "/reset":
                data = self._body()
                with GAMES_LOCK:
                    GAMES.pop(data.get("game_id", ""), None)
                return self._json({"ok": True})
            return self._json({"ok": False, "error": "Неизвестный маршрут"}, 404)
        except (ValueError, json.JSONDecodeError) as error:
            return self._json({"ok": False, "error": str(error)}, 400)
        except Exception as error:  # noqa: BLE001
            traceback.print_exc()
            return self._json({"ok": False, "error": str(error)}, 500)

    def _handle_eval_position(self):
        if self.analyzer is None:
            return self._json({"ok": False, "error": "Stockfish не запущен"}, 503)
        data = self._body()
        fen = (data.get("fen") or "").strip()
        if not fen:
            return self._json({"ok": False, "error": "Нужен fen"}, 400)
        try:
            depth = int(data.get("depth") or self.depth)
        except (TypeError, ValueError):
            depth = self.depth
        depth = max(6, min(24, depth))
        try:
            best, lines = self.analyzer.engine.analyse(fen, depth, multipv=3, movetime_ms=4000)
        except Exception as error:  # noqa: BLE001
            return self._json({"ok": False, "error": str(error)}, 500)
        return self._json({"ok": True, "fen": fen, "bestmove": best, "lines": lines})

    def _handle_analyze(self):
        if self.analyzer is None:
            return self._json({"ok": False, "error": "Stockfish не запущен"}, 503)
        data = self._body()
        fen_before = data.get("fen_before", "")
        fen_after = data.get("fen_after", "")
        game_id = data.get("game_id") or "unknown"
        if not fen_before or not fen_after:
            return self._json({"ok": False, "error": "Нужны fen_before и fen_after"}, 400)

        try:
            depth = int(data.get("depth") or self.depth)
        except (TypeError, ValueError):
            depth = self.depth
        depth = max(6, min(24, depth))

        move = self.analyzer.analyse_move(fen_before, fen_after, depth=depth)
        move["game_id"] = game_id
        move["player_color"] = data.get("player_color") or None
        move["played_at"] = time.time()
        record_move(game_id, move)

        if not self.quiet:
            is_me = move["player_color"] == move["color"]
            who = "Ты " if is_me else "Опп"
            eval_text = f"{move['eval_after'] / 100:+.2f}"
            category = colorize(f"{move['emoji']} {move['label']} {move['icon']}".strip(), CATEGORY_ANSI.get(move["category"], "reset"))
            print(
                f"[{move['move_number']:>3}] {who} {move['color']} "
                f"{move['san']:<7} {category:<28} eval {eval_text}"
                f"{'  ЖЕРТВА' if move['is_sacrifice'] else ''}",
                flush=True,
            )

        return self._json({"ok": True, "move": move})

def build_server(host: str = "127.0.0.1", port: int = 8765, analyzer=None,
                 depth: int = 14, quiet: bool = True):
    """Создаёт HTTP-сервер, не запуская его. Используется тестами и main()."""
    CoachHandler.analyzer = analyzer
    CoachHandler.depth = depth
    CoachHandler.quiet = quiet
    return ThreadingHTTPServer((host, port), CoachHandler)


def find_engine(explicit: str | None) -> str | None:
    candidates = []
    if explicit:
        candidates.append(explicit)
    candidates += [
        os.environ.get("STOCKFISH_PATH", ""),
        shutil.which("stockfish") or "",
        "/usr/games/stockfish",
        "/usr/local/bin/stockfish",
        "/usr/bin/stockfish",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "stockfish", "stockfish"),
    ]
    for candidate in candidates:
        if candidate and os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    return None


def main():
    parser = argparse.ArgumentParser(description="Chess.com Live Coach — локальный анализ ходов")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--engine", default=None, help="Путь к бинарнику Stockfish")
    parser.add_argument("--depth", type=int, default=14, help="Глубина анализа (по умолчанию 14)")
    parser.add_argument("--movetime", type=int, default=1600, help="Лимит времени на позицию, мс")
    parser.add_argument("--threads", type=int, default=max(1, min(4, (os.cpu_count() or 2) - 1)))
    parser.add_argument("--hash", type=int, default=128)
    parser.add_argument("--quiet", action="store_true")
    args = parser.parse_args()

    engine_path = find_engine(args.engine)
    analyzer = None
    if not engine_path:
        print(colorize("Stockfish не найден.", "red"))
        print("Установи его:  sudo apt install stockfish")
        print("Или укажи путь: python3 server.py --engine /путь/к/stockfish")
    else:
        try:
            engine = Stockfish(engine_path, threads=args.threads, hash_mb=args.hash)
            analyzer = Analyzer(engine, depth=args.depth, movetime_ms=args.movetime)
            print(colorize(f"Движок: {engine.name}", "green") + f"  ({engine_path})")
        except Exception as error:  # noqa: BLE001
            print(colorize(f"Не удалось запустить Stockfish: {error}", "red"))

    CoachHandler.analyzer = analyzer
    CoachHandler.depth = args.depth
    CoachHandler.quiet = args.quiet

    server = ThreadingHTTPServer((args.host, args.port), CoachHandler)
    print(colorize(f"Сервер: http://{args.host}:{args.port}", "cyan"))
    print(f"Глубина: {args.depth}   Потоки: {args.threads}")
    print("Остановка: Ctrl+C")
    print("-" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nПока!")
    finally:
        server.server_close()
        if analyzer is not None:
            try:
                analyzer.engine.proc.terminate()
            except Exception:  # noqa: BLE001
                pass


if __name__ == "__main__":
    main()
