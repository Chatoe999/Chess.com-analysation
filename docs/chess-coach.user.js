// ==UserScript==
// @name         Chess.com Live Coach (RU)
// @namespace    local.chesscoach
// @version      1.3.0
// @description  Оценка ходов на Chess.com в реальном времени: бриллиант, ошибка, зевок. Локальный Stockfish.
// @match        https://www.chess.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-idle
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------
  // Настройки
  // ---------------------------------------------------------------------

  const API = 'http://127.0.0.1:8765';
  const POLL_MS = 350;
  const HEALTH_MS = 10000;
  const PAGE = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  const S = {
    path: null,
    session: null,
    lastFen: null,
    playerColor: null,
    queue: [],
    busy: false,
    history: [],
    enabled: load('enabled', true),
    sound: load('sound', true),
    visible: load('visible', true),
    serverOk: null,
    gameOverShown: false,
    lastResult: null,
    lastPair: null,
  };

  // ---------------------------------------------------------------------
  // Утилиты
  // ---------------------------------------------------------------------

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem('cc_' + key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      localStorage.setItem('cc_' + key, JSON.stringify(value));
    } catch (e) { /* ignore */ }
  }

  function log(...args) {
    if (load('debug', false)) console.log('%c[coach]', 'color:#26c2a3', ...args);
  }

  function hexToRgba(hex, alpha) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    if (!m) return 'rgba(120,120,120,' + alpha + ')';
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${alpha})`;
  }

  // ---------------------------------------------------------------------
  // Доступ к странице Chess.com
  // ---------------------------------------------------------------------

  function getBoard() {
    try {
      const board = PAGE.document.querySelector('wc-chess-board');
      if (!board || !board.game) return null;
      if (typeof board.game.getFEN !== 'function') return null;
      return board;
    } catch (e) {
      return null;
    }
  }

  function getFen(board) {
    try {
      return board.game.getFEN();
    } catch (e) {
      return null;
    }
  }

  function getPlayerColor(board) {
    try {
      const playingAs = board.game.getPlayingAs && board.game.getPlayingAs();
      if (playingAs === 1) return 'w';
      if (playingAs === 2) return 'b';
    } catch (e) { /* ignore */ }
    return null;
  }

  function isGameOver(board) {
    try {
      const info = board.game.getPositionInfo && board.game.getPositionInfo();
      return Boolean(info && info.gameOver);
    } catch (e) {
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // HTTP-клиент (GM_xmlhttpRequest обходит CSP Chess.com)
  // ---------------------------------------------------------------------

  function request(method, path, payload) {
    const gm = (typeof GM_xmlhttpRequest === 'function')
      ? GM_xmlhttpRequest
      : (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function' ? GM.xmlHttpRequest : null);

    if (gm) {
      return new Promise((resolve, reject) => {
        gm({
          method: method,
          url: API + path,
          headers: payload ? { 'Content-Type': 'application/json' } : undefined,
          data: payload ? JSON.stringify(payload) : undefined,
          timeout: 45000,
          onload: (response) => {
            try {
              resolve(JSON.parse(response.responseText));
            } catch (e) {
              reject(new Error('Некорректный ответ сервера'));
            }
          },
          onerror: () => reject(new Error('Сервер недоступен')),
          ontimeout: () => reject(new Error('Таймаут сервера')),
        });
      });
    }

    return fetch(API + path, {
      method: method,
      headers: payload ? { 'Content-Type': 'application/json' } : undefined,
      body: payload ? JSON.stringify(payload) : undefined,
      credentials: 'omit',
    }).then((response) => response.json());
  }

  // ---------------------------------------------------------------------
  // Интерфейс
  // ---------------------------------------------------------------------

  const host = document.createElement('div');
  host.id = 'cc-coach-host';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;pointer-events:none;';
  document.documentElement.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .panel {
        --accent: #8b949e;
        width: 268px;
        background: linear-gradient(160deg, rgba(22,26,31,.97), rgba(13,16,20,.98));
        border: 1px solid rgba(255,255,255,.09);
        border-radius: 16px;
        box-shadow: 0 18px 50px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
        color: #e6edf3;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        font-size: 13px;
        overflow: hidden;
        pointer-events: auto;
        position: relative;
        transition: border-color .25s, box-shadow .25s;
      }
      .panel.flash { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent), 0 18px 50px rgba(0,0,0,.55); }
      .panel.shake { animation: cc-shake .35s; }
      @keyframes cc-shake { 10%,90%{transform:translateX(-1px)} 30%,70%{transform:translateX(2px)} 50%{transform:translateX(-3px)} }
      .head { display:flex; align-items:center; gap:7px; padding:10px 12px; background:rgba(255,255,255,.03); border-bottom:1px solid rgba(255,255,255,.06); cursor:grab; user-select:none; touch-action:none; }
      .panel.dragging .head { cursor:grabbing; }
      .panel.dragging { transition:none; }
      .dot { width:8px; height:8px; border-radius:50%; background:#666; flex:0 0 auto; transition:background .2s; }
      .dot.ok { background:#3fb950; box-shadow:0 0 8px rgba(63,185,80,.7); }
      .dot.bad { background:#f85149; }
      .title { font-weight:700; letter-spacing:.3px; font-size:12px; text-transform:uppercase; color:#b8c4d0; }
      .spacer { flex:1; }
      .iconbtn { appearance:none; border:0; background:transparent; color:#7d8994; width:22px; height:22px; border-radius:6px; cursor:pointer; font-size:13px; line-height:1; }
      .iconbtn:hover { background:rgba(255,255,255,.08); color:#e6edf3; }
      .body { padding:12px 12px 10px; }
      .badge {
        display:flex; align-items:center; justify-content:center; gap:6px;
        min-height:42px; padding:8px 6px; border-radius:10px;
        background: rgba(139,148,158,.12); color:#b8c4d0;
        font-weight:800; font-size:15px; text-align:center; line-height:1.15;
        transition: background .25s, color .25s;
      }
      .row { display:flex; align-items:baseline; gap:8px; margin-top:10px; }
      .eval { font-variant-numeric: tabular-nums; font-weight:800; font-size:20px; letter-spacing:-.4px; }
      .eval.pos { color:#7ee787; }
      .eval.neg { color:#ff7b72; }
      .eval.mate { color:#d2a8ff; }
      .meta { color:#8b949e; font-size:11.5px; margin-left:auto; text-align:right; line-height:1.25; }
      .hist { display:flex; gap:3px; margin-top:10px; min-height:20px; flex-wrap:wrap; }
      .chip { width:20px; height:20px; border-radius:5px; display:flex; align-items:center; justify-content:center; font-size:11px; background:rgba(255,255,255,.06); cursor:default; }
      .foot { display:flex; justify-content:space-between; gap:6px; padding:7px 12px 9px; border-top:1px solid rgba(255,255,255,.05); color:#6e7681; font-size:10px; }
      .foot .fair { color:#6e7681; }
      .mini {
        width:46px; height:46px; border-radius:50%; border:1px solid rgba(255,255,255,.12);
        background:linear-gradient(160deg,#161a1f,#0d1014); color:#e6edf3; font-size:22px;
        cursor:pointer; pointer-events:auto; box-shadow:0 10px 30px rgba(0,0,0,.5); display:none;
      }
      .particle { position:absolute; left:50%; top:50%; font-size:16px; pointer-events:none; animation: cc-fly 1.2s ease-out forwards; z-index:5; }
      @keyframes cc-fly { 0%{opacity:1; transform:translate(-50%,-50%) scale(.6)} 100%{opacity:0; transform:translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) scale(1.25) rotate(var(--rot))} }
      .warn { position:absolute; left:0; right:0; top:39px; bottom:0; background:rgba(13,16,20,.97); padding:16px; display:flex; flex-direction:column; gap:9px; justify-content:center; z-index:10; }
      .warn b { color:#f7c631; font-size:13px; }
      .warn p { margin:0; color:#b8c4d0; font-size:12px; line-height:1.45; }
      .warn button { margin-top:4px; align-self:flex-start; border:0; border-radius:8px; padding:7px 14px; background:#238636; color:#fff; font-weight:700; cursor:pointer; }
      .summary { position:fixed; inset:0; background:rgba(0,0,0,.55); display:flex; align-items:center; justify-content:center; pointer-events:auto; z-index:20; backdrop-filter: blur(3px); }
      .scard { width:min(92vw, 360px); background:linear-gradient(160deg,#161a1f,#0d1014); border:1px solid rgba(255,255,255,.1); border-radius:18px; padding:18px; color:#e6edf3; box-shadow:0 24px 70px rgba(0,0,0,.7); }
      .scard h2 { margin:0 0 12px; font-size:16px; }
      .sline { display:flex; justify-content:space-between; padding:5px 0; border-bottom:1px solid rgba(255,255,255,.05); font-size:12.5px; color:#b8c4d0; }
      .sline b { color:#e6edf3; }
      .scounts { display:flex; flex-wrap:wrap; gap:5px; margin:12px 0; }
      .scount { background:rgba(255,255,255,.06); border-radius:6px; padding:3px 7px; font-size:11px; }
      .sclose { width:100%; margin-top:6px; border:0; border-radius:9px; padding:9px; background:#21262d; color:#e6edf3; font-weight:700; cursor:pointer; }
      .sclose:hover { background:#30363d; }
      .hidden { display:none !important; }
    </style>

    <div class="panel" id="panel">
      <div class="head">
        <span class="dot" id="dot"></span>
        <span class="title" id="title" title="Перетащи за заголовок, двойной клик — вернуть в угол">Тренер</span>
        <span class="spacer"></span>
        <button class="iconbtn" id="btnPause" title="Пауза">⏸</button>
        <button class="iconbtn" id="btnSound" title="Звук">🔊</button>
        <button class="iconbtn" id="btnHide" title="Свернуть">—</button>
      </div>
      <div class="body">
        <div class="badge" id="badge">Ожидание хода…</div>
        <div class="row">
          <div class="eval" id="eval">—</div>
          <div class="meta" id="meta">ход не сделан</div>
        </div>
        <div class="hist" id="hist"></div>
      </div>
      <div class="foot">
        <span id="conn">проверка сервера…</span>
        <span class="fair">только для тренировок</span>
      </div>
      <div class="warn" id="warn">
        <b>⚠️ Fair play</b>
        <p>Использовать движок в партиях против людей запрещено — и в рейтинговых, и в нерейтинговых. Годится для игры против компьютера, тренировки и разбора партий.</p>
        <button id="warnOk">Понятно</button>
      </div>
    </div>
    <button class="mini" id="mini" title="Открыть тренера">🎓</button>
  `;

  const $ = (id) => shadow.getElementById(id);
  const panel = $('panel');
  const badge = $('badge');
  const evalEl = $('eval');
  const metaEl = $('meta');
  const histEl = $('hist');
  const connEl = $('conn');
  const dotEl = $('dot');
  const miniEl = $('mini');
  const warnEl = $('warn');

  function applyVisible() {
    panel.classList.toggle('hidden', !S.visible);
    miniEl.style.display = S.visible ? 'none' : 'block';
  }

  function applyPause() {
    const btn = $('btnPause');
    btn.textContent = S.enabled ? '⏸' : '▶';
    btn.title = S.enabled ? 'Пауза' : 'Продолжить';
    if (!S.enabled) {
      badge.textContent = '⏸ Пауза';
      badge.style.background = 'rgba(139,148,158,.12)';
      badge.style.color = '#8b949e';
    }
  }

  function applySound() {
    $('btnSound').textContent = S.sound ? '🔊' : '🔇';
  }

  $('btnPause').addEventListener('click', () => {
    S.enabled = !S.enabled;
    save('enabled', S.enabled);
    applyPause();
  });

  $('btnSound').addEventListener('click', () => {
    S.sound = !S.sound;
    save('sound', S.sound);
    applySound();
  });

  $('btnHide').addEventListener('click', () => {
    S.visible = false;
    save('visible', false);
    applyVisible();
  });

  miniEl.addEventListener('click', () => {
    S.visible = true;
    save('visible', true);
    applyVisible();
  });

  if (load('warned', false)) {
    warnEl.classList.add('hidden');
  } else {
    $('warnOk').addEventListener('click', () => {
      warnEl.classList.add('hidden');
      save('warned', true);
    });
  }

  applyVisible();
  applyPause();
  applySound();

  // ---------------------------------------------------------------------
  // Перетаскивание панели
  // ---------------------------------------------------------------------

  const PANEL_W = 268;
  const PANEL_H = 180;
  const headEl = panel.querySelector('.head');
  let drag = null;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function placeHost(left, top) {
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    host.style.left = Math.round(left) + 'px';
    host.style.top = Math.round(top) + 'px';
  }

  function panelSize() {
    const box = panel.getBoundingClientRect();
    return { width: box.width || PANEL_W, height: box.height || PANEL_H };
  }

  function clampToViewport(left, top) {
    const size = panelSize();
    return {
      left: clamp(left, 4, window.innerWidth - size.width - 4),
      top: clamp(top, 4, window.innerHeight - size.height - 4),
    };
  }

  function resetPos() {
    host.style.left = '';
    host.style.top = '';
    host.style.right = '16px';
    host.style.bottom = '16px';
    save('pos', null);
  }

  function restorePos() {
    const pos = load('pos', null);
    if (!pos || typeof pos.left !== 'number' || typeof pos.top !== 'number') return;
    const spot = clampToViewport(pos.left, pos.top);
    placeHost(spot.left, spot.top);
  }

  headEl.addEventListener('pointerdown', (event) => {
    if (event.button !== undefined && event.button !== 0) return;
    if (event.target.closest('button')) return;
    const box = panel.getBoundingClientRect();
    if (!box.width) return;
    drag = {
      dx: event.clientX - box.left,
      dy: event.clientY - box.top,
      width: box.width,
      height: box.height,
      moved: false,
      id: event.pointerId,
    };
    panel.classList.add('dragging');
    document.documentElement.style.userSelect = 'none';
    try { headEl.setPointerCapture(event.pointerId); } catch (e) { /* синтетические события */ }
    event.preventDefault();
    event.stopPropagation();
  });

  headEl.addEventListener('pointermove', (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.moved = true;
    const spot = clampToViewport(event.clientX - drag.dx, event.clientY - drag.dy);
    placeHost(spot.left, spot.top);
    event.preventDefault();
  });

  function endDrag(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const moved = drag.moved;
    drag = null;
    panel.classList.remove('dragging');
    document.documentElement.style.userSelect = '';
    if (moved) {
      const box = panel.getBoundingClientRect();
      save('pos', { left: Math.round(box.left), top: Math.round(box.top) });
    }
  }

  headEl.addEventListener('pointerup', endDrag);
  headEl.addEventListener('pointercancel', endDrag);
  headEl.addEventListener('lostpointercapture', endDrag);

  headEl.addEventListener('dblclick', (event) => {
    if (event.target.closest('button')) return;
    resetPos();
  });

  window.addEventListener('resize', () => {
    const pos = load('pos', null);
    if (!pos) return;
    const spot = clampToViewport(pos.left, pos.top);
    placeHost(spot.left, spot.top);
  });

  window.requestAnimationFrame(restorePos);

  // ---------------------------------------------------------------------
  // Отрисовка результата
  // ---------------------------------------------------------------------

  function evalForPlayer(move) {
    const sign = S.playerColor === 'b' ? -1 : 1;
    if (move.mate_after_white !== null && move.mate_after_white !== undefined) {
      return move.mate_after_white * sign * 10000;
    }
    return (move.eval_after_white || 0) * sign;
  }

  function evalText(move) {
    const sign = S.playerColor === 'b' ? -1 : 1;
    if (move.mate_after_white !== null && move.mate_after_white !== undefined) {
      const value = move.mate_after_white * sign;
      return (value >= 0 ? '#' : '#-') + Math.abs(move.mate_after_white);
    }
    const cp = (move.eval_after_white || 0) * sign;
    return (cp >= 0 ? '+' : '−') + (Math.abs(cp) / 100).toFixed(2);
  }

  function renderMove(move) {
    const me = S.playerColor && move.color === S.playerColor;
    const accent = move.color_hex || '#8b949e';
    panel.style.setProperty('--accent', accent);

    badge.textContent = `${move.emoji} ${move.label}${move.icon ? ' ' + move.icon : ''}`;
    badge.style.background = hexToRgba(accent, 0.15);
    badge.style.color = accent;

    const value = evalForPlayer(move);
    evalEl.textContent = evalText(move);
    evalEl.className = 'eval ' + (move.mate_after_white !== null && move.mate_after_white !== undefined ? 'mate' : value >= 0 ? 'pos' : 'neg');

    const whose = S.playerColor ? (me ? 'Ты' : 'Соперник') : (move.color === 'w' ? 'Белые' : 'Чёрные');
    const dots = move.color === 'w' ? '.' : '…';
    metaEl.innerHTML = `${whose} · ${move.move_number}${dots} ${move.san}` +
      `<br><span style="opacity:.7">глубина ${move.depth}, потеря ${(move.cp_loss / 100).toFixed(2)}</span>`;

    panel.classList.remove('flash');
    void panel.offsetWidth;
    panel.classList.add('flash');

    if (move.category === 'brilliant') {
      burst(['💎', '✨', '💎', '⭐']);
      chime([660, 880, 1320], 0.09);
    } else if (move.category === 'blunder') {
      panel.classList.remove('shake');
      void panel.offsetWidth;
      panel.classList.add('shake');
      chime([180, 120], 0.12, 'sawtooth');
    } else if (move.category === 'great') {
      chime([520, 780], 0.07);
    }

    window.setTimeout(() => panel.classList.remove('flash'), 900);
  }

  function renderHistory() {
    histEl.innerHTML = '';
    S.history.slice(-12).forEach((move) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = move.emoji;
      chip.title = `${move.move_number}${move.color === 'w' ? '.' : '…'} ${move.san} — ${move.label}`;
      chip.style.color = move.color_hex;
      histEl.appendChild(chip);
    });
  }

  function burst(emojis) {
    for (let i = 0; i < 12; i += 1) {
      const particle = document.createElement('span');
      particle.className = 'particle';
      particle.textContent = emojis[i % emojis.length];
      particle.style.setProperty('--dx', `${Math.random() * 180 - 90}px`);
      particle.style.setProperty('--dy', `${-40 - Math.random() * 120}px`);
      particle.style.setProperty('--rot', `${Math.random() * 240 - 120}deg`);
      particle.style.animationDelay = `${Math.random() * 120}ms`;
      panel.appendChild(particle);
      window.setTimeout(() => particle.remove(), 1500);
    }
  }

  let audioCtx = null;
  function chime(freqs, duration, type) {
    if (!S.sound) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      freqs.forEach((freq, index) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = type || 'sine';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.06, audioCtx.currentTime + 0.01 + index * duration);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration * (index + 1.5));
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + index * duration);
        osc.stop(audioCtx.currentTime + duration * (index + 1.6));
      });
    } catch (e) { /* ignore */ }
  }

  function markServer(ok, message) {
    S.serverOk = ok;
    dotEl.className = 'dot ' + (ok ? 'ok' : 'bad');
    if (!ok) {
      connEl.textContent = message || 'сервер не запущен';
    }
  }

  function clearPanel() {
    badge.textContent = 'Ожидание хода…';
    badge.style.background = 'rgba(139,148,158,.12)';
    badge.style.color = '#b8c4d0';
    evalEl.textContent = '—';
    evalEl.className = 'eval';
    metaEl.textContent = 'ход не сделан';
    histEl.innerHTML = '';
  }

  // ---------------------------------------------------------------------
  // Сводка после партии
  // ---------------------------------------------------------------------

  async function showSummary() {
    if (!S.playerColor) return;
    let data;
    try {
      data = await request('POST', '/summary', { game_id: S.session, player_color: S.playerColor });
    } catch (e) {
      return;
    }
    if (!data || !data.ok) return;

    const counts = data.counts || {};
    const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'blunder', 'miss'];
    const labels = {
      brilliant: '💎', great: '🔥', best: '✅', excellent: '👍', good: '🙂',
      inaccuracy: '🤔', mistake: '❌', blunder: '💀', miss: '😬',
    };
    const chips = order
      .filter((key) => counts[key])
      .map((key) => `<span class="scount">${labels[key]} ${counts[key]}</span>`)
      .join('');

    const worst = data.worst
      ? `${data.worst.move_number}${data.worst.color === 'w' ? '.' : '…'} ${data.worst.san} (${data.worst.label})`
      : '—';

    const overlay = document.createElement('div');
    overlay.className = 'summary';
    overlay.innerHTML = `
      <div class="scard">
        <h2>🎓 Партия окончена</h2>
        <div class="sline"><span>Точность</span><b>${data.accuracy.toFixed(1)}%</b></div>
        <div class="sline"><span>Средняя потеря</span><b>${data.acpl.toFixed(0)} cp</b></div>
        <div class="sline"><span>Ходов оценено</span><b>${data.player_moves}</b></div>
        <div class="sline"><span>Худший ход</span><b>${worst}</b></div>
        <div class="scounts">${chips || '<span class="scount">нет данных</span>'}</div>
        <button class="sclose" id="ccSummaryClose">Закрыть</button>
      </div>
    `;
    shadow.appendChild(overlay);
    overlay.querySelector('#ccSummaryClose').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) overlay.remove();
    });
  }

  // ---------------------------------------------------------------------
  // Основной цикл
  // ---------------------------------------------------------------------

  function ensureSession() {
    const path = location.pathname;
    if (path !== S.path) {
      S.path = path;
      S.session = path + '#' + Date.now().toString(36);
      S.lastFen = null;
      S.history = [];
      S.playerColor = null;
      S.gameOverShown = false;
      S.enabled = load('enabled', true);
      applyPause();
      clearPanel();
      log('новая сессия', S.session);
    }
  }

  function enqueue(before, after) {
    if (!before || !after || before === after) return;
    const now = Date.now();
    const last = S.lastPair;
    if (last && last.before === before && last.after === after && now - last.t < 5000) {
      return; // тот же переход уже отправлен — повтор не нужен
    }
    S.lastPair = { before, after, t: now };
    S.queue.push({ before: before, after: after });
    if (S.queue.length > 12) S.queue.shift();
    pump();
  }

  async function pump() {
    if (S.busy || S.queue.length === 0) return;
    S.busy = true;
    const item = S.queue.shift();
    try {
      const response = await request('POST', '/analyze', {
        game_id: S.session,
        fen_before: item.before,
        fen_after: item.after,
        player_color: S.playerColor || '',
        url: location.href,
      });
      if (!response || !response.ok || !response.move) {
        throw new Error((response && response.error) || 'Ошибка анализа');
      }
      const move = response.move;
      S.lastResult = move;
      S.history.push(move);
      if (S.history.length > 40) S.history.shift();
      renderMove(move);
      renderHistory();
      dotEl.className = 'dot ok';
    } catch (e) {
      log('ошибка', e);
      markServer(false, e.message === 'Сервер недоступен' ? 'сервер не запущен' : e.message);
    } finally {
      S.busy = false;
      if (S.queue.length > 0) window.setTimeout(pump, 0);
    }
  }

  function tick() {
    ensureSession();
    const board = getBoard();
    if (!board) return;

    const color = getPlayerColor(board);
    if (color) S.playerColor = color;

    const fen = getFen(board);
    if (!fen) return;

    if (S.lastFen && fen !== S.lastFen) {
      if (S.enabled) enqueue(S.lastFen, fen);
    }
    S.lastFen = fen;

    if (isGameOver(board) && !S.gameOverShown && !S.busy && S.queue.length === 0) {
      S.gameOverShown = true;
      window.setTimeout(showSummary, 800);
    }
  }

  async function checkHealth() {
    try {
      const data = await request('GET', '/health');
      if (data && data.ok) {
        markServer(true);
        connEl.textContent = `${data.engine || 'Stockfish'} · глубина ${data.depth}`;
      } else {
        markServer(false, data && data.engine === null ? 'Stockfish не запущен' : 'сервер без движка');
      }
    } catch (e) {
      markServer(false, 'сервер не запущен');
    }
  }

  window.setInterval(tick, POLL_MS);
  window.setInterval(checkHealth, HEALTH_MS);
  window.setTimeout(checkHealth, 400);
  log('userscript запущен');
})();
