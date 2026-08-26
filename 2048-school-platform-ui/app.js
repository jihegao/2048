(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const number = (value) => Math.round(Number(value) || 0).toLocaleString('zh-CN');
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const pad = (value, size = 2) => String(value).padStart(size, '0');

  const appState = {
    role: 'student',
    loggedIn: false,
    route: 'dashboard',
    roomFilter: 'all',
    toastTimer: null,
    duelStarted: false,
    teamStarted: false,
    liveStarted: false,
  };

  const routeMeta = {
    dashboard: ['首页 / 概览', '下午好，林晨'],
    rooms: ['挑战 / 房间大厅', '房间大厅'],
    solo: ['挑战 / 单人练习', '单人练习'],
    duel: ['赛事 / 1v1 实时对抗', '1v1 实时对抗'],
    team: ['赛事 / 组队对抗', '组队对抗'],
    leaderboard: ['数据 / 排行榜', '排行榜'],
    live: ['赛事 / 比赛实况', '比赛实况'],
    admin: ['管理 / 赛事控制台', '赛事管理'],
  };

  function showToast(message, title = '操作成功') {
    const toast = $('#toast');
    if (!toast) return;
    $('#toast-title').textContent = title;
    $('#toast-text').textContent = message;
    toast.classList.add('show');
    window.clearTimeout(appState.toastTimer);
    appState.toastTimer = window.setTimeout(() => toast.classList.remove('show'), 2800);
  }

  function setRole(role) {
    appState.role = role === 'teacher' ? 'teacher' : 'student';
    const teacher = appState.role === 'teacher';
    $$('.teacher-only').forEach((element) => {
      element.hidden = !teacher;
    });

    const profile = teacher
      ? { name: '周老师', meta: '数学组 · 赛事管理员', chip: '教师管理员', initial: '周' }
      : { name: '林晨', meta: '高一（3）班 · 学生', chip: '学生账号', initial: '林' };

    $('#profile-name').textContent = profile.name;
    $('#profile-meta').textContent = profile.meta;
    $('#chip-name').textContent = profile.name;
    $('#chip-role').textContent = profile.chip;
    $$('#side-profile .avatar, #user-chip .avatar').forEach((avatar) => {
      avatar.textContent = profile.initial;
    });
    routeMeta.dashboard[1] = teacher ? '下午好，周老师' : '下午好，林晨';
  }

  function login(role = 'student') {
    setRole(role);
    appState.loggedIn = true;
    $('#login').hidden = true;
    $('#platform').hidden = false;
    navigate(role === 'teacher' ? 'admin' : 'dashboard', false);
    showToast(role === 'teacher' ? '已进入教师赛事管理端' : '学生身份验证通过', '登录成功');
  }

  function logout() {
    appState.loggedIn = false;
    $('#platform').hidden = true;
    $('#login').hidden = false;
    $('#profile-menu').hidden = true;
    $('#sidebar').classList.remove('open');
    document.title = '校园 2048 在线挑战平台';
  }

  function navigate(route, updateHistory = true) {
    if (!routeMeta[route]) route = 'dashboard';
    if (route === 'admin' && appState.role !== 'teacher') {
      showToast('赛事管理仅对教师管理员开放', '无访问权限');
      route = 'dashboard';
    }

    appState.route = route;
    $$('.page[data-page]').forEach((page) => page.classList.toggle('active', page.dataset.page === route));
    $$('.side-nav .nav-item[data-route]').forEach((button) => button.classList.toggle('active', button.dataset.route === route));
    $$('.mobile-nav button[data-route]').forEach((button) => button.classList.toggle('active', button.dataset.route === route));

    $('#breadcrumb').textContent = routeMeta[route][0];
    $('#page-title').textContent = routeMeta[route][1];
    document.title = `${routeMeta[route][1]} · 校园 2048`;
    $('#sidebar').classList.remove('open');

    if (route === 'duel') startDuelSimulation();
    if (route === 'team') startTeamSimulation();
    if (route === 'live') startLiveSimulation();

    if (updateHistory && window.history?.replaceState) {
      const url = new URL(window.location.href);
      url.searchParams.set('route', route);
      if (appState.loggedIn) url.searchParams.set('demo', appState.role);
      window.history.replaceState(null, '', url);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Authentication and shell interactions.
  $('#login-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const studentId = $('#student-id').value.trim();
    const password = $('#password').value;
    if (studentId.length < 6 || password.length < 4) {
      showToast('请检查学号和密码后重试', '登录信息不完整');
      return;
    }
    login('student');
  });

  $$('[data-login-role]').forEach((button) => button.addEventListener('click', () => login(button.dataset.loginRole)));

  $('#toggle-password')?.addEventListener('click', () => {
    const input = $('#password');
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    $('#toggle-password').textContent = visible ? '显示' : '隐藏';
  });

  $$('[data-route]').forEach((element) => {
    element.addEventListener('click', (event) => {
      event.preventDefault();
      navigate(element.dataset.route);
    });
  });

  $('#menu-button')?.addEventListener('click', (event) => {
    event.stopPropagation();
    $('#sidebar').classList.toggle('open');
  });

  document.addEventListener('click', (event) => {
    const sidebar = $('#sidebar');
    if (window.innerWidth <= 820 && sidebar?.classList.contains('open') && !sidebar.contains(event.target) && event.target !== $('#menu-button')) {
      sidebar.classList.remove('open');
    }
  });

  function toggleProfile(event) {
    event?.stopPropagation();
    const menu = $('#profile-menu');
    menu.hidden = !menu.hidden;
  }
  $('#user-chip')?.addEventListener('click', toggleProfile);
  $('#side-profile')?.addEventListener('click', toggleProfile);
  $('#logout')?.addEventListener('click', logout);
  document.addEventListener('click', (event) => {
    const menu = $('#profile-menu');
    if (menu && !menu.hidden && !menu.contains(event.target) && !$('#user-chip')?.contains(event.target) && !$('#side-profile')?.contains(event.target)) {
      menu.hidden = true;
    }
  });

  $('#toast > button')?.addEventListener('click', () => $('#toast').classList.remove('show'));
  $$('[data-toast]').forEach((button) => button.addEventListener('click', () => showToast(button.dataset.toast)));

  // Generic tab groups.
  $$('.tabs, .large-tabs').forEach((tabGroup) => {
    tabGroup.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      $$('button', tabGroup).forEach((item) => item.classList.toggle('active', item === button));
      if (tabGroup.id === 'rank-scopes' || tabGroup.id === 'rank-types') {
        showToast(`榜单已切换为“${button.textContent.trim()}”`, '筛选已应用');
      }
    });
  });

  // Room lobby.
  function filterRooms() {
    const query = ($('#room-search')?.value || '').trim().toLowerCase();
    $$('#room-list .room-card').forEach((card) => {
      const matchesType = appState.roomFilter === 'all' || card.dataset.type === appState.roomFilter;
      const matchesText = !query || (card.dataset.name || '').includes(query) || card.textContent.toLowerCase().includes(query);
      card.hidden = !(matchesType && matchesText);
    });
  }

  $('#room-search')?.addEventListener('input', filterRooms);
  $('#room-filters')?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]');
    if (!button) return;
    appState.roomFilter = button.dataset.filter;
    $$('[data-filter]', $('#room-filters')).forEach((item) => item.classList.toggle('active', item === button));
    filterRooms();
  });

  const codeInputs = $$('#room-code input');
  codeInputs.forEach((input, index) => {
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^a-z0-9]/gi, '').slice(-1).toUpperCase();
      if (input.value && codeInputs[index + 1]) codeInputs[index + 1].focus();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !input.value && codeInputs[index - 1]) codeInputs[index - 1].focus();
      if (event.key === 'Enter') $('#quick-join')?.click();
    });
  });

  $('#code-focus')?.addEventListener('click', () => {
    navigate('rooms');
    const target = codeInputs.find((input) => !input.value) || codeInputs[0];
    target.focus();
    target.select();
  });

  $('#quick-join')?.addEventListener('click', () => {
    const code = codeInputs.map((input) => input.value).join('');
    if (code.length < 3) {
      showToast('请输入至少三位房间码', '未找到房间');
      return;
    }
    if (code.startsWith('A08') || code === 'A08') {
      showToast('已找到官方房间 A-08，正在进入候场', '房间验证通过');
      window.setTimeout(() => navigate('duel'), 450);
    } else {
      showToast(`已模拟加入房间 ${code}`, '房间验证通过');
      window.setTimeout(() => navigate('team'), 450);
    }
  });

  $$('[data-enter]').forEach((button) => button.addEventListener('click', () => {
    showToast('身份与比赛资格校验通过，已加入房间', '进入成功');
    window.setTimeout(() => navigate(button.dataset.enter), 350);
  }));

  const modal = $('#room-modal');
  function openRoomModal() {
    modal.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeRoomModal() {
    modal.hidden = true;
    document.body.style.overflow = '';
  }
  $('#new-room')?.addEventListener('click', openRoomModal);
  $('#admin-new-room')?.addEventListener('click', openRoomModal);
  $$('.close-modal').forEach((button) => button.addEventListener('click', closeRoomModal));
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeRoomModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && modal && !modal.hidden) closeRoomModal();
  });

  $('#room-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    closeRoomModal();
    const generatedCode = `N-${Math.floor(10 + Math.random() * 89)}`;
    showToast(`新房间 ${generatedCode} 已创建，可复制房间码邀请学生`, '创建成功');
    navigate('rooms');
  });

  // Small non-destructive demo actions.
  $$('button').forEach((button) => {
    const text = button.textContent.trim();
    if (text.includes('导入学生') && !button.dataset.toast) {
      button.addEventListener('click', () => showToast('已打开学生账号批量导入流程', '导入学生'));
    }
    if (text === '查看运行详情') {
      button.addEventListener('click', () => showToast('实时房间、认证与数据库服务均处于正常状态', '系统运行正常'));
    }
    if (text === '导出榜单') {
      button.addEventListener('click', () => showToast('榜单导出任务已创建（原型演示）', '导出成功'));
    }
  });

  // 2048 game engine.
  class Game2048 {
    constructor(name, options = {}) {
      this.name = name;
      this.board = $(`#${name}-board`);
      this.overLayer = $(`#${name}-over`);
      this.onChange = options.onChange || (() => {});
      this.onMilestone = options.onMilestone || (() => {});
      this.grid = [];
      this.score = 0;
      this.moves = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.startedAt = null;
      this.timer = null;
      this.touchStart = null;
      this.reset();
      this.bindTouch();
    }

    reset() {
      this.grid = Array(16).fill(0);
      this.score = 0;
      this.moves = 0;
      this.combo = 0;
      this.maxCombo = 0;
      this.startedAt = null;
      this.highestReported = 4;
      window.clearInterval(this.timer);
      this.timer = window.setInterval(() => this.emit(), 1000);
      this.addRandom();
      this.addRandom();
      if (this.overLayer) this.overLayer.hidden = true;
      this.render();
      this.emit();
    }

    addRandom() {
      const empty = this.grid.map((value, index) => (value === 0 ? index : -1)).filter((index) => index >= 0);
      if (!empty.length) return;
      const index = empty[Math.floor(Math.random() * empty.length)];
      this.grid[index] = Math.random() < 0.9 ? 2 : 4;
    }

    slide(line) {
      const values = line.filter(Boolean);
      const result = [];
      let gained = 0;
      let merges = 0;
      for (let index = 0; index < values.length; index += 1) {
        if (values[index] === values[index + 1]) {
          const merged = values[index] * 2;
          result.push(merged);
          gained += merged;
          merges += 1;
          if (merged >= 256 && merged > this.highestReported) {
            this.highestReported = merged;
            this.onMilestone(merged);
          }
          index += 1;
        } else {
          result.push(values[index]);
        }
      }
      while (result.length < 4) result.push(0);
      return { line: result, gained, merges };
    }

    getRows() {
      return [0, 1, 2, 3].map((row) => this.grid.slice(row * 4, row * 4 + 4));
    }

    getColumns() {
      return [0, 1, 2, 3].map((column) => [0, 1, 2, 3].map((row) => this.grid[row * 4 + column]));
    }

    setRows(rows) {
      this.grid = rows.flat();
    }

    setColumns(columns) {
      this.grid = Array(16).fill(0);
      columns.forEach((column, columnIndex) => column.forEach((value, rowIndex) => {
        this.grid[rowIndex * 4 + columnIndex] = value;
      }));
    }

    move(direction) {
      if (!this.board || this.overLayer?.hidden === false) return false;
      const before = this.grid.join(',');
      const vertical = direction === 'up' || direction === 'down';
      const reverse = direction === 'right' || direction === 'down';
      const lines = vertical ? this.getColumns() : this.getRows();
      let gained = 0;
      let merges = 0;
      const next = lines.map((original) => {
        const prepared = reverse ? [...original].reverse() : [...original];
        const result = this.slide(prepared);
        gained += result.gained;
        merges += result.merges;
        return reverse ? result.line.reverse() : result.line;
      });
      if (vertical) this.setColumns(next); else this.setRows(next);

      if (before === this.grid.join(',')) return false;
      if (!this.startedAt) this.startedAt = Date.now();
      this.score += gained;
      this.moves += 1;
      this.combo = merges ? this.combo + merges : 0;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.addRandom();
      this.render();
      this.emit();
      if (!this.canMove()) {
        if (this.overLayer) this.overLayer.hidden = false;
      }
      return true;
    }

    canMove() {
      if (this.grid.some((value) => value === 0)) return true;
      for (let row = 0; row < 4; row += 1) {
        for (let column = 0; column < 4; column += 1) {
          const index = row * 4 + column;
          if (column < 3 && this.grid[index] === this.grid[index + 1]) return true;
          if (row < 3 && this.grid[index] === this.grid[index + 4]) return true;
        }
      }
      return false;
    }

    elapsed() {
      return this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    }

    highest() {
      return Math.max(...this.grid, 2);
    }

    snapshot() {
      return {
        score: this.score,
        moves: this.moves,
        combo: this.maxCombo,
        elapsed: this.elapsed(),
        highest: this.highest(),
      };
    }

    emit() {
      this.onChange(this.snapshot());
    }

    render() {
      if (!this.board) return;
      this.board.innerHTML = '';
      this.grid.forEach((value) => {
        const tile = document.createElement('div');
        const visualValue = value > 8192 ? 8192 : value;
        tile.className = value ? `tile v${visualValue}` : 'tile empty';
        tile.textContent = value || '';
        this.board.appendChild(tile);
      });
    }

    bindTouch() {
      if (!this.board) return;
      this.board.addEventListener('pointerdown', (event) => {
        this.touchStart = { x: event.clientX, y: event.clientY };
      });
      this.board.addEventListener('pointerup', (event) => {
        if (!this.touchStart) return;
        const dx = event.clientX - this.touchStart.x;
        const dy = event.clientY - this.touchStart.y;
        this.touchStart = null;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 22) return;
        this.move(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      });
    }
  }

  function formatTime(seconds) {
    const safe = Math.max(0, Math.floor(seconds));
    return `${pad(Math.floor(safe / 60))}:${pad(safe % 60)}`;
  }

  const games = {};
  games.solo = new Game2048('solo', {
    onChange: (state) => {
      $('#solo-score').textContent = number(state.score);
      $('#solo-max').textContent = number(state.highest);
      $('#solo-moves').textContent = number(state.moves);
      $('#solo-combo').textContent = number(state.combo);
      $('#solo-time').textContent = formatTime(state.elapsed);
      $('#solo-points').textContent = `+${number(Math.floor(state.score / 120))}`;
    },
    onMilestone: (value) => showToast(`已合成 ${value} 方块`, '练习里程碑'),
  });

  const duelState = { opponentScore: 0, opponentMoves: 0, opponentMax: 2, remaining: 120, eventIndex: 0 };
  games.duel = new Game2048('duel', {
    onChange: (state) => updateDuel(state),
    onMilestone: (value) => addDuelFeed(`你合成了 ${value}，获得一波领先`, 'green'),
  });

  const teamState = {
    mates: [12460, 9880, 8240, 6920],
    enemies: [13120, 10560, 8760, 7940, 6580],
    remaining: 300,
  };
  games.team = new Game2048('team', {
    onChange: (state) => updateTeam(state),
    onMilestone: (value) => showToast(`你合成了 ${value}，团队分数已同步`, '团队贡献提升'),
  });

  $$('.game-reset').forEach((button) => button.addEventListener('click', () => games[button.dataset.game]?.reset()));
  $$('[data-game][data-move]').forEach((button) => button.addEventListener('click', () => games[button.dataset.game]?.move(button.dataset.move)));

  document.addEventListener('keydown', (event) => {
    if (!appState.loggedIn || !['solo', 'duel', 'team'].includes(appState.route)) return;
    if (/input|select|textarea/i.test(document.activeElement?.tagName || '')) return;
    const keys = {
      ArrowUp: 'up', w: 'up', W: 'up',
      ArrowDown: 'down', s: 'down', S: 'down',
      ArrowLeft: 'left', a: 'left', A: 'left',
      ArrowRight: 'right', d: 'right', D: 'right',
    };
    const direction = keys[event.key];
    if (!direction) return;
    event.preventDefault();
    games[appState.route]?.move(direction);
  });

  function updateDuel(own = games.duel.snapshot()) {
    $('#duel-score').textContent = number(own.score);
    $('#duel-max').textContent = number(own.highest);
    $('#duel-seq').textContent = `#${pad(own.moves, 3)}`;
    $('#duel-own-top').textContent = number(own.score);
    $('#duel-opp-top').textContent = number(duelState.opponentScore);
    $('#duel-opp-score').textContent = number(duelState.opponentScore);
    $('#duel-opp-moves').textContent = number(duelState.opponentMoves);
    $('#duel-opp-max').textContent = number(duelState.opponentMax);
    $('#duel-timer').textContent = formatTime(duelState.remaining);

    const gap = own.score - duelState.opponentScore;
    const gapNode = $('#duel-gap');
    gapNode.textContent = `${gap >= 0 ? '+' : '−'}${number(Math.abs(gap))}`;
    gapNode.classList.toggle('positive', gap >= 0);
    gapNode.classList.toggle('negative', gap < 0);
    const stateNode = $('#duel-state');
    stateNode.textContent = gap >= 0 ? '你领先' : '正在追赶';
    stateNode.className = `pill ${gap >= 0 ? 'green' : 'red'}`;
    const total = own.score + duelState.opponentScore;
    $('#duel-bar').style.width = `${total ? clamp((own.score / total) * 100, 8, 92) : 50}%`;
  }

  function addDuelFeed(text, tone = 'violet') {
    const feed = $('#duel-feed');
    if (!feed) return;
    const item = document.createElement('div');
    item.innerHTML = `<i class="feed-dot ${tone}"></i><p>${text}<small>刚刚</small></p>`;
    feed.prepend(item);
    while (feed.children.length > 5) feed.lastElementChild.remove();
  }

  function startDuelSimulation() {
    if (appState.duelStarted) return;
    appState.duelStarted = true;
    window.setInterval(() => {
      if (!appState.loggedIn || appState.route !== 'duel' || duelState.remaining <= 0) return;
      duelState.remaining -= 1;
      if (duelState.remaining % 2 === 0) {
        const gain = Math.floor(70 + Math.random() * 420) * (Math.random() < 0.12 ? 3 : 1);
        duelState.opponentScore += gain;
        duelState.opponentMoves += Math.floor(1 + Math.random() * 3);
        if (duelState.opponentScore > 18000) duelState.opponentMax = 2048;
        else if (duelState.opponentScore > 9000) duelState.opponentMax = 1024;
        else if (duelState.opponentScore > 3500) duelState.opponentMax = 512;
        else if (duelState.opponentScore > 1200) duelState.opponentMax = 256;
      }
      if ([100, 70, 40, 15].includes(duelState.remaining)) {
        addDuelFeed(duelState.remaining === 15 ? '比赛进入最后 15 秒' : `对手刚刚获得一轮连续得分`, duelState.remaining === 15 ? 'red' : 'violet');
      }
      updateDuel();
      if (duelState.remaining === 0) {
        $('#duel-over').hidden = false;
        addDuelFeed('比赛结束，服务器正在确认最终结果', 'green');
      }
    }, 1000);
  }

  function updateTeam(own = games.team.snapshot()) {
    $('#team-own-score').textContent = number(own.score);
    $('#team-own-roster').textContent = number(own.score);
    $('#team-max').textContent = number(own.highest);
    $('#team-roster-max').textContent = number(own.highest);
    teamState.mates.forEach((score, index) => {
      const node = $(`#mate-${index + 1}`);
      if (node) node.textContent = number(score);
    });
    teamState.enemies.forEach((score, index) => {
      const node = $(`#enemy-${index + 1}`);
      if (node) node.textContent = number(score);
    });
    const blue = own.score + teamState.mates.reduce((sum, value) => sum + value, 0);
    const red = teamState.enemies.reduce((sum, value) => sum + value, 0);
    const total = Math.max(1, blue + red);
    const bluePct = (blue / total) * 100;
    $('#blue-score').textContent = number(blue);
    $('#red-score').textContent = number(red);
    $('#blue-pct').textContent = `${bluePct.toFixed(1)}%`;
    $('#red-pct').textContent = `${(100 - bluePct).toFixed(1)}%`;
    $('#team-bar').style.width = `${clamp(bluePct, 5, 95)}%`;
    $('#team-contribution').textContent = `${blue ? ((own.score / blue) * 100).toFixed(1) : '0.0'}%`;
    $('#team-timer').textContent = formatTime(teamState.remaining);
  }

  function startTeamSimulation() {
    if (appState.teamStarted) return;
    appState.teamStarted = true;
    updateTeam();
    window.setInterval(() => {
      if (!appState.loggedIn || appState.route !== 'team' || teamState.remaining <= 0) return;
      teamState.remaining -= 1;
      if (teamState.remaining % 2 === 0) {
        const mate = Math.floor(Math.random() * teamState.mates.length);
        const enemy = Math.floor(Math.random() * teamState.enemies.length);
        teamState.mates[mate] += Math.floor(60 + Math.random() * 390);
        teamState.enemies[enemy] += Math.floor(70 + Math.random() * 420);
      }
      updateTeam();
      if (teamState.remaining === 0) {
        $('#team-over').hidden = false;
        showToast('本轮比赛结束，团队成绩已进入结算', '比赛结束');
      }
    }, 1000);
  }

  // Live spectator simulation.
  const liveState = { blue: 86420, red: 81960, remaining: 516, viewers: 236, ticks: 0 };
  function updateLive() {
    const total = Math.max(1, liveState.blue + liveState.red);
    const bluePct = (liveState.blue / total) * 100;
    $('#live-blue').textContent = number(liveState.blue);
    $('#live-red').textContent = number(liveState.red);
    $('#live-blue-pct').textContent = `${bluePct.toFixed(1)}%`;
    $('#live-red-pct').textContent = `${(100 - bluePct).toFixed(1)}%`;
    $('#live-bar').style.width = `${clamp(bluePct, 5, 95)}%`;
    $('#live-timer').textContent = formatTime(liveState.remaining);
    $('#viewer-count').textContent = number(liveState.viewers);
  }

  function addLiveFeed(team) {
    const blueNames = ['林晨', '周宇航', '陈一凡', '许诺'];
    const redNames = ['江浩', '唐舒', '沈越', '何嘉'];
    const name = (team === 'blue' ? blueNames : redNames)[Math.floor(Math.random() * 4)];
    const score = Math.floor(180 + Math.random() * 2600);
    const item = document.createElement('div');
    item.innerHTML = `<span class="feed-icon ${team === 'blue' ? 'violet' : 'red'}">↗</span><p><b>${name}</b> 连续得分 +${number(score)}<small>${team === 'blue' ? '蓝队' : '红队'} · 刚刚</small></p>`;
    $('#live-feed').prepend(item);
    while ($('#live-feed').children.length > 6) $('#live-feed').lastElementChild.remove();
  }

  function startLiveSimulation() {
    if (appState.liveStarted) return;
    appState.liveStarted = true;
    updateLive();
    window.setInterval(() => {
      if (!appState.loggedIn || appState.route !== 'live' || liveState.remaining <= 0) return;
      liveState.remaining -= 1;
      liveState.ticks += 1;
      liveState.blue += Math.floor(60 + Math.random() * 370);
      liveState.red += Math.floor(60 + Math.random() * 390);
      if (Math.random() < 0.12) liveState.viewers += Math.random() < 0.72 ? 1 : -1;
      if (liveState.ticks % 8 === 0) addLiveFeed(liveState.blue >= liveState.red ? 'blue' : 'red');
      updateLive();
    }, 1000);
  }

  // Dashboard countdown.
  let dashboardCountdown = 1 * 3600 + 24 * 60 + 36;
  window.setInterval(() => {
    dashboardCountdown = Math.max(0, dashboardCountdown - 1);
    $('#cd-h').textContent = pad(Math.floor(dashboardCountdown / 3600));
    $('#cd-m').textContent = pad(Math.floor((dashboardCountdown % 3600) / 60));
    $('#cd-s').textContent = pad(dashboardCountdown % 60);
  }, 1000);

  // URL-controlled demo state makes screenshots and reviews reproducible.
  const params = new URLSearchParams(window.location.search);
  const demoRole = params.get('demo');
  const demoRoute = params.get('route');
  if (demoRole === 'teacher' || demoRole === 'student') {
    login(demoRole);
    if (demoRoute) navigate(demoRoute, false);
  }
})();
