(function () {
  'use strict';
  const strings = {
    zh: {
      title: '淘汰赛晋级',
      teams: '队淘汰赛',
      hint: '填写团队名称，图标自动匹配；点击队伍右侧箭头确认晋级。',
      empty: '请先由管理员从线上导出离线包，将 teams 目录放在本页旁边，然后重新打开页面。',
      unknown: '未找到团队，请从提示列表选择',
      ambiguous: '团队名称重复，请管理员修正导出资料',
      repeated: '同一团队不能占用多个席位',
      missingLogo: '团队没有图标',
      brokenLogo: '图标文件缺失，请检查 teams/logos 目录',
      placeholder: '填写团队名称',
      advance: '晋级',
      waiting: '等待上一轮胜者',
      champion: '冠军',
      undecided: '冠军待定',
      final: '决赛',
      round: '进',
      winner: '已晋级',
      save: '保存进度',
      load: '载入进度',
      reset: '重新排赛',
      resetConfirm: '清空当前版本的队伍和晋级结果？',
      full: '全屏展示',
      exit: '退出全屏',
      print: '打印',
      invalid: '进度文件无效，或队伍数量与当前版本不一致',
      stored: '进度已自动保存',
      storage: '浏览器无法自动保存，请使用“保存进度”下载备份',
      directory: '可用团队',
      exported: '资料导出时间',
      imported: '进度已载入',
    },
    en: {
      title: 'Knockout bracket',
      teams: 'team tournament',
      hint: 'Enter a team name to match its logo. Use the arrow to advance the winner.',
      empty:
        'Ask an administrator to export the offline bundle. Place the teams folder beside this page and reopen it.',
      unknown: 'Team not found. Choose a suggested name.',
      ambiguous: 'Duplicate team name. Ask an administrator to correct the export.',
      repeated: 'A team can only occupy one place.',
      missingLogo: 'This team has no logo.',
      brokenLogo: 'Logo file missing. Check the teams/logos folder.',
      placeholder: 'Enter team name',
      advance: 'Advance',
      waiting: 'Awaiting previous winner',
      champion: 'Champion',
      undecided: 'Champion undecided',
      final: 'Final',
      round: ' → ',
      winner: 'Advanced',
      save: 'Save progress',
      load: 'Load progress',
      reset: 'New tournament',
      resetConfirm: 'Clear the teams and results in this version?',
      full: 'Fullscreen',
      exit: 'Exit fullscreen',
      print: 'Print',
      invalid: 'Invalid progress file, or team count does not match this version.',
      stored: 'Progress saved automatically',
      storage: 'Automatic saving unavailable. Use Save progress to download a backup.',
      directory: 'Available teams',
      exported: 'Directory exported',
      imported: 'Progress loaded',
    },
  };
  let lang = 'zh';
  const t = (key) => strings[lang][key];
  const size = Number(document.body.dataset.teams);
  const data = window.TOURNAMENT_TEAMS;
  const catalog =
    data?.version === 1 && Array.isArray(data.teams)
      ? data.teams.filter(
          (team) =>
            team &&
            typeof team.id === 'string' &&
            team.id &&
            typeof team.name === 'string' &&
            team.name.trim(),
        )
      : [];
  const key = `mingcheng2048-bracket:${location.pathname}:${size}`;
  let restored;
  try {
    restored = JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    /* Downloadable backups remain available. */
  }
  let model = window.KnockoutBracket.create(size, catalog, restored);
  const bracket = document.querySelector('#bracket');
  const notice = document.querySelector('#notice');
  const storage = document.querySelector('#storage');
  const title = document.querySelector('#title');
  const suggestions = document.querySelector('#team-names');
  const slots = [];
  const choices = [];
  let champion;
  let expanded = false;

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  for (const name of [...new Set(catalog.map((team) => team.name))].sort()) {
    const option = node('option');
    option.value = name;
    suggestions.append(option);
  }

  function showLogo(target, team) {
    target.replaceChildren();
    target.classList.remove('is-missing');
    target.removeAttribute('title');
    if (!team) {
      target.textContent = '?';
      return;
    }
    if (typeof team.logo === 'string' && /^teams\/logos\/icon[1-9]\.svg$/.test(team.logo)) {
      const image = node('img');
      image.src = team.logo;
      image.alt = team.name;
      image.addEventListener(
        'error',
        () => {
          if (target.firstChild !== image) return;
          target.replaceChildren(node('span', '', '?'));
          target.classList.add('is-missing');
          target.title = t('brokenLogo');
          const warning = target.parentElement.querySelector('.team-error');
          if (warning) warning.textContent = t('brokenLogo');
        },
        { once: true },
      );
      target.append(image);
    } else if (typeof team.glyph === 'string' && team.glyph) {
      target.textContent = team.glyph;
    } else {
      target.textContent = '?';
      target.classList.add('is-missing');
      target.title = t('missingLogo');
    }
  }

  function build() {
    bracket.replaceChildren();
    slots.length = 0;
    choices.length = 0;
    const roundCount = Math.log2(size);
    for (let round = 0; round < roundCount; round += 1) {
      const stage = node('section', 'bracket-stage');
      const heading = node('h2');
      heading.dataset.round = String(round);
      stage.append(heading);
      const matches = node('div', 'stage-matches');
      for (let index = 0; index < size / 2 ** (round + 1); index += 1) {
        const match = node('article', 'match-card');
        const matchChoices = [];
        for (let side = 0; side < 2; side += 1) {
          const row = node('div', 'team-row');
          const logo = node('span', 'team-picture');
          const label = node('div', 'team-label');
          let input;
          if (round === 0) {
            input = node('input', 'team-input');
            input.type = 'text';
            input.maxLength = 80;
            input.autocomplete = 'off';
            input.setAttribute('list', 'team-names');
            const position = index * 2 + side;
            input.id = `team-${position}`;
            input.addEventListener('input', () => {
              model.setName(position, input.value);
              render();
            });
            label.append(input);
          } else {
            label.append(node('strong', 'team-name'));
          }
          const error = node('small', 'team-error');
          if (input) {
            error.id = `${input.id}-error`;
            input.setAttribute('aria-describedby', error.id);
          }
          label.append(error);
          const button = node('button', 'advance-button', '→');
          button.type = 'button';
          button.addEventListener('click', () => {
            if (model.choose(round, index, side)) render();
          });
          row.append(logo, label, button);
          match.append(row);
          matchChoices.push({ row, logo, label, button, error });
          if (input) slots.push({ input, error });
        }
        const caption = node('small', 'match-caption');
        match.append(caption);
        matches.append(match);
        choices.push({ round, index, rows: matchChoices, caption });
      }
      stage.append(matches);
      bracket.append(stage);
    }
    const stage = node('section', 'bracket-stage bracket-stage--champion');
    const heading = node('h2');
    heading.dataset.champion = 'true';
    const card = node('div', 'champion-card');
    const crown = node('div', 'champion-crown', '✦');
    const logo = node('div', 'champion-picture');
    const name = node('strong', 'champion-name');
    card.append(crown, logo, name);
    stage.append(heading, card);
    bracket.append(stage);
    champion = { logo, name, card };
    render();
  }

  function render() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    title.textContent = `${size} ${t('teams')}`;
    document.title = `2048 · ${title.textContent}`;
    document.querySelector('#hint').textContent = t('hint');
    notice.textContent = catalog.length
      ? `${t('directory')}: ${catalog.length}${data.exportedAt ? ` · ${t('exported')}: ${data.exportedAt.slice(0, 10)}` : ''}`
      : t('empty');
    notice.classList.toggle('is-warning', catalog.length === 0);
    document.querySelectorAll('[data-i18n]').forEach((element) => {
      element.textContent = t(element.dataset.i18n);
    });
    document.querySelector('#fullscreen').textContent = t(
      document.fullscreenElement || expanded ? 'exit' : 'full',
    );
    document.querySelectorAll('[data-round]').forEach((element) => {
      const count = size / 2 ** Number(element.dataset.round);
      element.textContent = count === 2 ? t('final') : `${count}${t('round')}${count / 2}`;
    });
    document.querySelector('[data-champion]').textContent = t('champion');
    const resolved = model.slots();
    const rounds = model.rounds();
    slots.forEach(({ input }, index) => {
      input.placeholder = t('placeholder');
      input.setAttribute('aria-label', `${t('placeholder')} ${index + 1}`);
      input.setAttribute('aria-invalid', String(Boolean(resolved[index].error)));
      if (input.value !== resolved[index].name) input.value = resolved[index].name;
    });
    for (const match of choices) {
      const result = rounds[match.round][match.index];
      match.rows.forEach((row, side) => {
        const team = result.teams[side];
        showLogo(row.logo, team);
        if (match.round > 0)
          row.label.querySelector('.team-name').textContent = team?.name || t('waiting');
        const status = match.round === 0 ? resolved[match.index * 2 + side].error : null;
        row.error.textContent = status ? t(status) : '';
        row.row.classList.toggle('is-winner', Boolean(team && team.id === result.winner?.id));
        row.button.disabled = !result.teams[0] || !result.teams[1];
        row.button.setAttribute('aria-label', `${t('advance')} ${team?.name || ''}`.trim());
        row.button.setAttribute(
          'aria-pressed',
          String(Boolean(team && team.id === result.winner?.id)),
        );
      });
      match.caption.textContent = result.winner ? `${t('winner')}: ${result.winner.name}` : 'VS';
    }
    const winner = rounds[rounds.length - 1][0].winner;
    showLogo(champion.logo, winner);
    champion.name.textContent = winner?.name || t('undecided');
    champion.card.classList.toggle('is-decided', Boolean(winner));
    try {
      localStorage.setItem(key, JSON.stringify(model.serialize()));
      storage.textContent = t('stored');
    } catch {
      storage.textContent = t('storage');
    }
  }

  function download(name, value) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }),
    );
    const link = node('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  document.querySelector('#language').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    render();
  });
  document
    .querySelector('#save')
    .addEventListener('click', () =>
      download(`2048-${size}-teams-progress.json`, model.serialize()),
    );
  document
    .querySelector('#load')
    .addEventListener('click', () => document.querySelector('#progress-file').click());
  document.querySelector('#progress-file').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 100000) throw new Error('File too large');
      const saved = JSON.parse(await file.text());
      if (
        saved.version !== 1 ||
        saved.size !== size ||
        !Array.isArray(saved.names) ||
        saved.names.length !== size ||
        !saved.names.every((name) => typeof name === 'string' && name.length <= 80) ||
        !Array.isArray(saved.winners) ||
        saved.winners.length !== Math.log2(size) ||
        !saved.winners.every(
          (round, index) =>
            Array.isArray(round) &&
            round.length === size / 2 ** (index + 1) &&
            round.every((id) => id === null || typeof id === 'string'),
        )
      )
        throw new Error('Invalid progress');
      model = window.KnockoutBracket.create(size, catalog, saved);
      render();
      storage.textContent = t('imported');
    } catch {
      storage.textContent = t('invalid');
    }
    event.target.value = '';
  });
  document.querySelector('#reset').addEventListener('click', () => {
    if (!confirm(t('resetConfirm'))) return;
    model = window.KnockoutBracket.create(size, catalog);
    render();
  });
  document.querySelector('#print').addEventListener('click', () => window.print());
  document.querySelector('#fullscreen').addEventListener('click', async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (expanded) {
      expanded = false;
      document.body.classList.remove('is-expanded');
    } else {
      try {
        await document.documentElement.requestFullscreen();
      } catch {
        expanded = true;
        document.body.classList.add('is-expanded');
      }
    }
    render();
  });
  document.addEventListener('fullscreenchange', render);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && expanded) {
      expanded = false;
      document.body.classList.remove('is-expanded');
      render();
    }
  });
  build();
})();
