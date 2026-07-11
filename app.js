/* Calgary Charity Fitness Challenge — app logic */
/* global API_URL */
(function () {
  'use strict';

  var CATEGORIES = [
    { key: 'circuits', label: 'Circuits' },
    { key: 'lifts', label: 'Lifts' },
    { key: 'core', label: 'Core' },
    { key: 'cardio', label: 'Cardio' },
    { key: 'mobility', label: 'Mobility' }
  ];
  var EVENTS = [
    { key: 'run', label: '1-Mile Run', kind: 'time' },
    { key: 'plank', label: 'Front Plank', kind: 'time' },
    { key: 'wallsit', label: 'Wall Sit', kind: 'time' },
    { key: 'pushups', label: 'Push-Ups (5 min)', kind: 'reps' }
  ];

  var state = {
    config: null,
    teamCode: localStorage.getItem('cfc_teamCode') || '',
    lastMemberId: localStorage.getItem('cfc_memberId') || '',
    teamData: null,
    publicData: null,
    finalData: null,
    scheduleData: null,
    adminPin: '',        // memory only — never persisted
    adminState: null,
    standingsMode: 'teams',
    top25Week: 0,        // 0 = cumulative
    finalMode: 'schedule'
  };

  // ------------------------------------------------------------------ utils

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function apiConfigured() {
    return typeof API_URL === 'string' && API_URL.indexOf('https://script.google.com') === 0;
  }

  function apiGet(action, params) {
    var qs = 'action=' + encodeURIComponent(action);
    if (params) Object.keys(params).forEach(function (k) {
      qs += '&' + k + '=' + encodeURIComponent(params[k]);
    });
    return fetch(API_URL + '?' + qs).then(function (r) { return r.json(); });
  }

  function apiPost(body) {
    return fetch(API_URL, { method: 'POST', body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }

  function notice(el, kind, msg) {
    el.innerHTML = msg ? '<div class="notice ' + kind + '">' + msg + '</div>' : '';
  }

  function secondsToClock(s) {
    s = Math.round(s);
    var m = Math.floor(s / 60), r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  function weekDateLabel(weekNum) {
    if (!state.config || !state.config.startDate) return '';
    var parts = state.config.startDate.split('-');
    var start = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    start.setDate(start.getDate() + (weekNum - 1) * 7);
    var end = new Date(start); end.setDate(end.getDate() + 6);
    var opt = { month: 'short', day: 'numeric' };
    return start.toLocaleDateString(undefined, opt) + ' – ' + end.toLocaleDateString(undefined, opt);
  }

  function scoreWeekLocal(minutes) {
    var cfg = state.config;
    var perCategory = {}, base = 0, hit = 0;
    CATEGORIES.forEach(function (c) {
      var mpp = cfg.minutesPerPoint[c.key];
      var pts = Math.min(Math.floor((minutes[c.key] || 0) / mpp), cfg.categoryMaxPerWeek);
      perCategory[c.key] = pts; base += pts; if (pts >= 1) hit++;
    });
    var bonus = hit === CATEGORIES.length ? cfg.weeklyBonusPoints : 0;
    return { perCategory: perCategory, base: base, bonus: bonus, total: base + bonus };
  }

  /** "Boost your score" donation card. Empty string if no donation URL is set. */
  function donateCardHtml() {
    var cfg = state.config;
    if (!cfg || !cfg.donationPageUrl) return '';
    return '<div class="card"><h2>Boost your score</h2>' +
      '<p class="muted">Every $' + cfg.donationDollarsPerPoint +
      ' your team raises adds 1 bonus point. No refunds. No shame.</p>' +
      '<a class="btn gold" style="text-decoration:none;text-align:center" href="' +
      esc(cfg.donationPageUrl) + '" target="_blank" rel="noopener">Donate to ' +
      esc(cfg.charityName) + '</a></div>';
  }

  /** Sponsor thank-you card. Empty string when there are no sponsors. */
  function sponsorCardHtml() {
    var sponsors = (state.config && state.config.sponsors) || [];
    if (!sponsors.length) return '';
    var html = '<div class="card sponsor-card"><h2>Thank you to our sponsors</h2><div class="sponsor-grid">';
    sponsors.forEach(function (s) {
      var inner = s.logo
        ? '<img src="sponsors/' + esc(s.logo) + '" alt="' + esc(s.name) + '" loading="lazy">'
        : '<span class="sponsor-name">' + esc(s.name) + '</span>';
      var tag = s.tier === 'title' ? '<span class="sponsor-tier">Title sponsor</span>' : '';
      var block = '<div class="sponsor">' + inner + tag + '</div>';
      html += s.url
        ? '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + block + '</a>'
        : block;
    });
    html += '</div></div>';
    return html;
  }

  // ------------------------------------------------------------------ nav

  var tabButtons = document.querySelectorAll('.tabbar button');
  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () { showView(btn.dataset.view); });
  });

  function showView(name) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    $('view-' + name).classList.add('active');
    tabButtons.forEach(function (b) { b.classList.toggle('on', b.dataset.view === name); });
    if (name === 'standings') loadStandings();
    if (name === 'team') renderTeamView();
    if (name === 'final') renderFinalView();
    if (name === 'more') renderMore();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    if (!apiConfigured()) {
      notice($('global-notice'), 'error',
        '<strong>Setup needed:</strong> the backend URL has not been added to config.js yet. See SETUP-GUIDE.md.');
      return;
    }
    apiGet('appConfig').then(function (cfg) {
      if (cfg.error) throw new Error(cfg.error);
      state.config = cfg;
      $('hdr-title').textContent = cfg.challengeName || 'Fitness Challenge';
      var eyebrow = (cfg.seasonLabel ? cfg.seasonLabel + ' · ' : '') +
        'In support of ' + (cfg.charityName || 'charity');
      var title = (cfg.sponsors || []).filter(function (s) { return s.tier === 'title'; })[0];
      if (title) eyebrow += ' · Presented by ' + title.name;
      $('hdr-eyebrow').textContent = eyebrow;
      document.title = cfg.challengeName || 'Fitness Challenge';
      showView('standings');
    }).catch(function (e) {
      notice($('global-notice'), 'error',
        'Could not reach the server. Check your connection and pull to refresh. <span class="muted">(' + esc(e.message) + ')</span>');
    });
  }

  // ------------------------------------------------------------------ standings

  $('standings-seg').addEventListener('click', function (e) {
    var btn = e.target.closest('button'); if (!btn) return;
    state.standingsMode = btn.dataset.mode;
    this.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === btn); });
    renderStandings();
  });

  function loadStandings() {
    if (!state.config) return;
    $('standings-body').innerHTML = '<div class="loading">Loading standings…</div>';
    apiGet('publicDashboard').then(function (data) {
      if (data.error) throw new Error(data.error);
      state.publicData = data;
      renderStandings();
    }).catch(function (e) {
      $('standings-body').innerHTML = '<div class="notice error">Could not load standings. ' + esc(e.message) +
        '</div><button class="btn ghost" onclick="location.reload()">Retry</button>';
    });
  }

  function renderStandings() {
    var d = state.publicData;
    if (!d) return;
    var html = '';
    if (state.standingsMode === 'teams') {
      html += donateCardHtml();
      html += '<div class="card"><h2>Team standings</h2>';
      if (!d.standings.length) {
        html += '<p class="muted">No teams yet. Be the first — register from the My Team tab.</p>';
      } else {
        html += '<table class="board"><thead><tr><th></th><th>Team</th><th style="text-align:right">Points</th></tr></thead><tbody>';
        d.standings.forEach(function (t, i) {
          var rank = i + 1;
          html += '<tr><td><span class="rank-chip rank-' + rank + '">' +
            (rank === 1 ? '<span class="belt">🥇</span>' : rank) + '</span></td>' +
            '<td><strong>' + esc(t.teamName) + '</strong><div class="sub">' +
            t.workoutPoints + ' workout · ' + t.donationPoints + ' donation</div></td>' +
            '<td class="num">' + t.total + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
      html += sponsorCardHtml();
    } else {
      var weeks = state.config.numWeeks;
      html += '<div class="card"><h2>Top 25 individuals</h2><div class="seg" id="top25-seg">';
      html += '<button data-w="0" class="' + (state.top25Week === 0 ? 'on' : '') + '">Overall</button>';
      for (var w = 1; w <= weeks; w++) {
        html += '<button data-w="' + w + '" class="' + (state.top25Week === w ? 'on' : '') + '">W' + w + '</button>';
      }
      html += '</div>';

      var rowsData = d.top25.map(function (p) {
        return {
          name: p.name, teamName: p.teamName,
          pts: state.top25Week === 0 ? p.cumulative : (p.weeklyPoints[state.top25Week - 1] || 0)
        };
      }).sort(function (a, b) { return b.pts - a.pts; }).slice(0, 25);

      if (!rowsData.length) {
        html += '<p class="muted">No workouts logged yet.</p>';
      } else {
        html += '<table class="board"><thead><tr><th></th><th>Name</th><th style="text-align:right">' +
          (state.top25Week === 0 ? 'Total' : 'Week ' + state.top25Week) + '</th></tr></thead><tbody>';
        rowsData.forEach(function (p, i) {
          var rank = i + 1;
          html += '<tr><td><span class="rank-chip rank-' + rank + '">' + rank + '</span></td>' +
            '<td><strong>' + esc(p.name) + '</strong><div class="sub">' + esc(p.teamName) + '</div></td>' +
            '<td class="num">' + p.pts + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    }
    $('standings-body').innerHTML = html;
    var seg = $('top25-seg');
    if (seg) seg.addEventListener('click', function (e) {
      var btn = e.target.closest('button'); if (!btn) return;
      state.top25Week = Number(btn.dataset.w);
      renderStandings();
    });
  }

  // ------------------------------------------------------------------ my team

  function renderTeamView() {
    if (!state.config) return;
    if (!state.teamCode) { renderTeamGate(); return; }
    $('team-body').innerHTML = '<div class="loading">Loading your team…</div>';
    apiGet('teamDashboard', { code: state.teamCode }).then(function (data) {
      if (data.error) {
        localStorage.removeItem('cfc_teamCode');
        state.teamCode = '';
        renderTeamGate('That team code no longer works — enter it again.');
        return;
      }
      state.teamData = data;
      renderTeamDashboard();
    }).catch(function () {
      $('team-body').innerHTML = '<div class="notice error">Could not load your team. Check your connection.</div>' +
        '<button class="btn ghost" id="team-retry">Retry</button>';
      $('team-retry').addEventListener('click', renderTeamView);
    });
  }

  function renderTeamGate(msg) {
    var html = '';
    if (msg) html += '<div class="notice error">' + esc(msg) + '</div>';
    html += '<div class="card"><h2>Join your team</h2>' +
      '<p class="muted">Enter the 6-character team code your captain received at registration.</p>' +
      '<label for="gate-code">Team code</label>' +
      '<input type="text" id="gate-code" autocapitalize="characters" autocomplete="off" maxlength="6" placeholder="e.g. K7M2XQ">' +
      '<div id="gate-notice"></div>' +
      '<button class="btn" id="gate-go">Open my team</button></div>';

    if (state.config.registrationOpen) {
      html += '<div class="card"><h2>Register a new team</h2>' +
        '<p class="muted">Captains: register your team of ' + state.config.teamSize + ' here. ' +
        'Minimum $50 donation per person to ' + esc(state.config.charityName) + ' — all donations are tax deductible.</p>' +
        '<button class="btn gold" id="gate-register">Register a team</button></div>';
    } else {
      html += '<div class="notice info">Registration is currently closed.</div>';
    }
    $('team-body').innerHTML = html;

    $('gate-go').addEventListener('click', function () {
      var code = $('gate-code').value.trim().toUpperCase();
      if (code.length !== 6) { notice($('gate-notice'), 'error', 'Team codes are 6 characters.'); return; }
      state.teamCode = code;
      localStorage.setItem('cfc_teamCode', code);
      renderTeamView();
    });
    var reg = $('gate-register');
    if (reg) reg.addEventListener('click', renderRegisterForm);
  }

  function renderRegisterForm() {
    var n = state.config.teamSize;
    var html = '<div class="card"><h2>Register your team</h2>' +
      '<label for="reg-name">Team name</label>' +
      '<input type="text" id="reg-name" maxlength="40" placeholder="e.g. Amortized Gains">';
    for (var i = 1; i <= n; i++) {
      html += '<h3>Member ' + i + (i === 1 ? ' (captain)' : '') + '</h3>' +
        '<input type="text" id="m' + i + '-name" placeholder="Full name" autocomplete="off">' +
        '<div class="spacer"></div><div class="row2">' +
        '<input type="email" id="m' + i + '-email" placeholder="Email">' +
        '<input type="tel" id="m' + i + '-phone" placeholder="Phone"></div>';
    }
    html += '<div id="reg-notice"></div>' +
      '<button class="btn gold" id="reg-submit">Create team</button>' +
      '<button class="btn ghost" id="reg-back">Back</button></div>';
    $('team-body').innerHTML = html;

    $('reg-back').addEventListener('click', function () { renderTeamGate(); });
    $('reg-submit').addEventListener('click', function () {
      var btn = this;
      var members = [];
      for (var i = 1; i <= n; i++) {
        members.push({
          name: $('m' + i + '-name').value,
          email: $('m' + i + '-email').value,
          phone: $('m' + i + '-phone').value
        });
      }
      var teamName = $('reg-name').value.trim();
      if (!teamName) { notice($('reg-notice'), 'error', 'Give your team a name.'); return; }
      var missing = members.filter(function (m) { return !m.name.trim(); }).length;
      if (missing) { notice($('reg-notice'), 'error', 'All ' + n + ' member names are required.'); return; }

      btn.disabled = true; btn.textContent = 'Creating team…';
      apiPost({ action: 'registerTeam', teamName: teamName, members: members }).then(function (res) {
        if (res.error) {
          notice($('reg-notice'), 'error', esc(res.error));
          btn.disabled = false; btn.textContent = 'Create team';
          return;
        }
        state.teamCode = res.teamCode;
        localStorage.setItem('cfc_teamCode', res.teamCode);
        $('team-body').innerHTML =
          '<div class="card"><h2>You\'re in! 🎉</h2>' +
          '<p><strong>' + esc(res.teamName) + '</strong> is registered. This is your team code — every member uses it to log workouts:</p>' +
          '<div class="code-hero"><div class="muted" style="color:#b7c2d8">TEAM CODE</div><div class="code">' + esc(res.teamCode) + '</div></div>' +
          '<div class="notice info"><strong>Screenshot this</strong> and share it with your team. You can always find it again in the Admin panel if lost.</div>' +
          '<p class="muted">Next: your captain will receive a fundraising page link from ' + esc(state.config.charityName) + '. Every $' + state.config.donationDollarsPerPoint + ' raised = 1 bonus point.</p>' +
          '<button class="btn" id="reg-done">Go to my team</button></div>';
        $('reg-done').addEventListener('click', renderTeamView);
      }).catch(function () {
        notice($('reg-notice'), 'error', 'Could not reach the server — try again.');
        btn.disabled = false; btn.textContent = 'Create team';
      });
    });
  }

  function renderTeamDashboard() {
    var d = state.teamData;
    var weeks = state.config.numWeeks;
    var html = '';

    html += '<div class="stats">' +
      '<div class="stat"><div class="v">#' + d.rank + '</div><div class="k">of ' + d.teamCount + ' teams</div></div>' +
      '<div class="stat"><div class="v">' + d.total + '</div><div class="k">Total pts</div></div>' +
      '<div class="stat"><div class="v">' + d.donationPoints + '</div><div class="k">Donation pts</div></div>' +
      '</div>';

    html += '<div class="card"><h2>' + esc(d.teamName) + '</h2>' +
      '<button class="btn gold" id="log-open">Log / edit workouts</button>';

    html += '<h3>Team scoreboard</h3><table class="board"><thead><tr><th>Member</th>';
    for (var w = 1; w <= weeks; w++) html += '<th style="text-align:right">W' + w + '</th>';
    html += '<th style="text-align:right">Total</th></tr></thead><tbody>';
    d.members.forEach(function (m) {
      html += '<tr><td><strong>' + esc(m.name) + '</strong></td>';
      m.weekly.forEach(function (wk) {
        html += '<td style="text-align:right;font-variant-numeric:tabular-nums">' +
          (wk.logged ? wk.total + (wk.bonus ? '<span class="sub" style="color:var(--green)">★</span>' : '') : '<span class="sub">—</span>') + '</td>';
      });
      html += '<td class="num" style="font-size:18px">' + m.cumulative + '</td></tr>';
    });
    html += '</tbody></table>' +
      '<p class="muted" style="margin-top:8px">★ = weekly bonus earned (' + state.config.weeklyBonusPoints +
      ' pts for scoring in all 5 categories). Donations: $' + d.donationDollars + ' raised = ' +
      d.donationPoints + ' bonus points.</p></div>';

    html += donateCardHtml();
    html += '<button class="btn ghost" id="team-switch">Use a different team code</button>';
    $('team-body').innerHTML = html;

    $('log-open').addEventListener('click', renderLogForm);
    $('team-switch').addEventListener('click', function () {
      localStorage.removeItem('cfc_teamCode');
      state.teamCode = ''; state.teamData = null;
      renderTeamGate();
    });
  }

  function renderLogForm() {
    var d = state.teamData;
    if (!state.config.loggingOpen) {
      $('team-body').insertAdjacentHTML('afterbegin', '<div class="notice info">Workout logging is closed for the season.</div>');
      return;
    }
    var weeks = state.config.numWeeks;
    var html = '<div class="card"><h2>Log workouts</h2>' +
      '<p class="muted">Enter total minutes for the week. Already-saved weeks load automatically — just change the numbers and save again.</p>' +
      '<label for="log-member">Who</label><select id="log-member">';
    d.members.forEach(function (m) {
      var sel = m.memberId === state.lastMemberId ? ' selected' : '';
      html += '<option value="' + esc(m.memberId) + '"' + sel + '>' + esc(m.name) + '</option>';
    });
    html += '</select><label for="log-week">Week</label><select id="log-week">';
    for (var w = 1; w <= weeks; w++) {
      html += '<option value="' + w + '">Week ' + w + ' · ' + weekDateLabel(w) + '</option>';
    }
    html += '</select><h3>Minutes by category</h3>';

    CATEGORIES.forEach(function (c) {
      var mpp = state.config.minutesPerPoint[c.key];
      html += '<div class="cat-row">' +
        '<div class="cat-name">' + c.label + '<span class="cat-rate">1 pt per ' + mpp + ' min · max ' +
        state.config.categoryMaxPerWeek + ' pts</span></div>' +
        '<input type="number" inputmode="numeric" min="0" step="5" id="log-' + c.key + '" placeholder="0" aria-label="' + c.label + ' minutes">' +
        '<div class="cat-pts" id="pts-' + c.key + '">0</div></div>';
    });

    html += '<div class="score-preview"><div><div style="font-size:12px;opacity:0.8">This week</div>' +
      '<span class="bonus-tag off" id="bonus-tag">All-5 bonus</span></div>' +
      '<div class="total" id="pts-total">0</div></div>' +
      '<div id="log-notice"></div>' +
      '<button class="btn gold" id="log-save">Save week</button>' +
      '<button class="btn ghost" id="log-back">Back to team</button></div>';
    $('team-body').innerHTML = html;

    function currentMinutes() {
      var m = {};
      CATEGORIES.forEach(function (c) {
        var v = parseFloat($('log-' + c.key).value);
        m[c.key] = isNaN(v) || v < 0 ? 0 : v;
      });
      return m;
    }

    function refreshPreview() {
      var s = scoreWeekLocal(currentMinutes());
      CATEGORIES.forEach(function (c) {
        var el = $('pts-' + c.key);
        el.textContent = s.perCategory[c.key];
        el.classList.toggle('capped', s.perCategory[c.key] === state.config.categoryMaxPerWeek);
      });
      $('pts-total').textContent = s.total;
      var tag = $('bonus-tag');
      tag.classList.toggle('off', !s.bonus);
      tag.textContent = s.bonus ? '+' + s.bonus + ' all-5 bonus' : 'All-5 bonus';
    }

    function prefill() {
      var memberId = $('log-member').value;
      var week = Number($('log-week').value);
      var member = d.members.filter(function (m) { return m.memberId === memberId; })[0];
      var wk = member ? member.weekly[week - 1] : null;
      CATEGORIES.forEach(function (c) {
        $('log-' + c.key).value = wk && wk.logged && wk.minutes[c.key] ? wk.minutes[c.key] : '';
      });
      notice($('log-notice'), wk && wk.logged ? 'info' : '',
        wk && wk.logged ? 'This week was already saved — you\'re editing it.' : '');
      refreshPreview();
    }

    CATEGORIES.forEach(function (c) { $('log-' + c.key).addEventListener('input', refreshPreview); });
    $('log-member').addEventListener('change', prefill);
    $('log-week').addEventListener('change', prefill);

    // Default to the current week if we're inside the challenge window.
    var wkSelect = $('log-week');
    var startParts = state.config.startDate.split('-');
    var start = new Date(Number(startParts[0]), Number(startParts[1]) - 1, Number(startParts[2]));
    var diffWeeks = Math.floor((Date.now() - start.getTime()) / (7 * 86400000)) + 1;
    if (diffWeeks >= 1 && diffWeeks <= weeks) wkSelect.value = String(diffWeeks);
    prefill();

    $('log-back').addEventListener('click', renderTeamView);
    $('log-save').addEventListener('click', function () {
      var btn = this;
      var body = { action: 'saveWeek', code: state.teamCode, memberId: $('log-member').value, week: Number($('log-week').value) };
      var mins = currentMinutes();
      CATEGORIES.forEach(function (c) { body[c.key + 'Min'] = mins[c.key]; });
      btn.disabled = true; btn.textContent = 'Saving…';
      state.lastMemberId = body.memberId;
      localStorage.setItem('cfc_memberId', body.memberId);
      apiPost(body).then(function (res) {
        if (res.error) {
          notice($('log-notice'), 'error', esc(res.error));
          btn.disabled = false; btn.textContent = 'Save week';
          return;
        }
        notice($('log-notice'), 'ok',
          (res.updated ? 'Updated' : 'Saved') + ' — ' + esc(res.memberName) + ', week ' + res.week +
          ': <strong>' + res.score.total + ' pts</strong>' + (res.score.bonus ? ' (incl. +' + res.score.bonus + ' bonus)' : '') + '.');
        btn.disabled = false; btn.textContent = 'Save week';
        state.teamData = null; // force refresh next time
        apiGet('teamDashboard', { code: state.teamCode }).then(function (data) {
          if (!data.error) { state.teamData = data; d = data; }
        });
      }).catch(function () {
        notice($('log-notice'), 'error', 'Could not reach the server — your entry was not saved. Try again.');
        btn.disabled = false; btn.textContent = 'Save week';
      });
    });
  }

  // ------------------------------------------------------------------ final

  $('final-seg').addEventListener('click', function (e) {
    var btn = e.target.closest('button'); if (!btn) return;
    state.finalMode = btn.dataset.mode;
    this.querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b === btn); });
    renderFinalView();
  });

  function renderFinalView() {
    if (!state.config) return;
    var body = $('final-body');
    body.innerHTML = '<div class="loading">Loading…</div>';
    if (state.finalMode === 'schedule') {
      apiGet('schedule').then(function (data) {
        if (data.error) throw new Error(data.error);
        state.scheduleData = data;
        renderSchedule();
      }).catch(function (e) { body.innerHTML = '<div class="notice error">' + esc(e.message) + '</div>'; });
    } else if (state.finalMode === 'enter') {
      renderFinalEntry();
    } else {
      apiGet('finalDashboard').then(function (data) {
        if (data.error) throw new Error(data.error);
        state.finalData = data;
        renderFinalLive();
      }).catch(function (e) { body.innerHTML = '<div class="notice error">' + esc(e.message) + '</div>'; });
    }
  }

  function renderSchedule() {
    var d = state.scheduleData;
    var cfg = state.config;
    var html = '<div class="card"><h2>Final Challenge</h2>' +
      '<p class="muted">' + esc(cfg.finalEventDate || '') + (cfg.finalLocation ? ' · ' + esc(cfg.finalLocation) : '') + '</p>' +
      '<p class="muted">Minimum ' + cfg.finalMinParticipants + ' team members must participate to qualify for each event.</p>' +
      '<h3>Run of show</h3><table class="board"><tbody>';
    d.blocks.forEach(function (b) {
      html += '<tr><td style="white-space:nowrap"><strong>' + esc(b.start) + '</strong>' +
        (b.end ? ' – ' + esc(b.end) : '') + '</td><td>' + esc(b.label) + '</td></tr>';
    });
    html += '</tbody></table></div>';

    html += '<div class="card"><h2>Station rotation</h2>';
    if (!d.teams.length) {
      html += '<p class="muted">The rotation hasn\'t been published yet. It appears here once the organizer generates it.</p>';
    } else {
      html += '<div style="overflow-x:auto"><table class="board"><thead><tr><th>Team</th>' +
        '<th>P1</th><th>P2</th><th>P3</th><th>P4</th></tr></thead><tbody>';
      d.teams.forEach(function (t) {
        html += '<tr><td><strong>' + esc(t.teamName) + '</strong></td>';
        t.periods.forEach(function (p) { html += '<td class="sub">' + esc(p) + '</td>'; });
        html += '</tr>';
      });
      html += '</tbody></table></div>';
    }
    html += '</div>';
    $('final-body').innerHTML = html;
  }

  function renderFinalEntry() {
    var body = $('final-body');
    if (!state.config.finalPortalOpen) {
      body.innerHTML = '<div class="notice info">Result entry opens on Final Challenge day.</div>';
      return;
    }
    if (!state.teamCode || !state.teamData) {
      body.innerHTML = '<div class="notice info">Open the <strong>My Team</strong> tab first and enter your team code — then come back here to record results.</div>';
      return;
    }
    var d = state.teamData;
    var html = '<div class="card"><h2>Enter results</h2>' +
      '<p class="muted">Record each member\'s result as they finish. Entries can be corrected — saving again overwrites.</p>' +
      '<label for="fin-member">Who</label><select id="fin-member">';
    d.members.forEach(function (m) {
      html += '<option value="' + esc(m.memberId) + '">' + esc(m.name) + '</option>';
    });
    html += '</select><label for="fin-event">Event</label><select id="fin-event">';
    EVENTS.forEach(function (ev) { html += '<option value="' + ev.key + '">' + ev.label + '</option>'; });
    html += '</select><div id="fin-inputs"></div><div id="fin-notice"></div>' +
      '<button class="btn gold" id="fin-save">Save result</button></div>';
    body.innerHTML = html;

    var finGender = 'male';
    var finStyle = 'regular';

    function pushupMultiplier() {
      return finGender === 'female' && finStyle === 'regular' ? 2 : 1;
    }

    function refreshPushupToggles() {
      var genderSeg = $('fin-gender');
      var styleSeg = $('fin-style');
      if (!genderSeg) return;
      genderSeg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', b.dataset.v === finGender);
      });
      var locked = finGender === 'male';
      if (locked) finStyle = 'regular';
      styleSeg.classList.toggle('locked', locked);
      styleSeg.querySelectorAll('button').forEach(function (b) {
        b.classList.toggle('on', b.dataset.v === finStyle);
        b.disabled = locked;
      });
      $('fin-mult').textContent = 'Each rep counts ' + pushupMultiplier() + 'x toward the team score.';
    }

    function renderInputs() {
      var ev = EVENTS.filter(function (e) { return e.key === $('fin-event').value; })[0];
      var el = $('fin-inputs');
      if (ev.kind === 'time') {
        el.innerHTML = '<label>Result (time)</label><div class="row2">' +
          '<input type="number" inputmode="numeric" min="0" id="fin-min" placeholder="min">' +
          '<input type="number" inputmode="numeric" min="0" max="59" id="fin-sec" placeholder="sec"></div>';
      } else {
        el.innerHTML = '<label>Gender</label>' +
          '<div class="seg mini" id="fin-gender">' +
          '<button type="button" data-v="male">Male</button>' +
          '<button type="button" data-v="female">Female</button></div>' +
          '<label>Push-up style</label>' +
          '<div class="seg mini" id="fin-style">' +
          '<button type="button" data-v="regular">Regular</button>' +
          '<button type="button" data-v="kneeling">Kneeling</button></div>' +
          '<p class="muted" id="fin-mult"></p>' +
          '<label for="fin-reps">Push-ups completed (5 min)</label>' +
          '<input type="number" inputmode="numeric" min="0" id="fin-reps" placeholder="reps">';
        $('fin-gender').addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b) return;
          finGender = b.dataset.v;
          refreshPushupToggles();
        });
        $('fin-style').addEventListener('click', function (e) {
          var b = e.target.closest('button'); if (!b || b.disabled) return;
          if (finGender !== 'female') return;
          finStyle = b.dataset.v;
          refreshPushupToggles();
        });
        refreshPushupToggles();
      }
    }
    $('fin-event').addEventListener('change', renderInputs);
    renderInputs();

    $('fin-save').addEventListener('click', function () {
      var btn = this;
      var evKey = $('fin-event').value;
      var ev = EVENTS.filter(function (e) { return e.key === evKey; })[0];
      var payload = { action: 'saveFinalResult', code: state.teamCode, memberId: $('fin-member').value, event: evKey };
      if (ev.kind === 'time') {
        var mins = parseFloat($('fin-min').value) || 0;
        var secs = parseFloat($('fin-sec').value) || 0;
        var total = Math.round(mins * 60 + secs);
        if (total <= 0) { notice($('fin-notice'), 'error', 'Enter a time.'); return; }
        payload.value = total;
      } else {
        var reps = parseFloat($('fin-reps').value);
        if (isNaN(reps) || reps < 0) { notice($('fin-notice'), 'error', 'Enter a rep count.'); return; }
        payload.value = reps;
        payload.value2 = finGender === 'male' ? 'male-regular'
          : (finStyle === 'regular' ? 'female-regular' : 'female-kneeling');
      }
      btn.disabled = true; btn.textContent = 'Saving…';
      apiPost(payload).then(function (res) {
        btn.disabled = false; btn.textContent = 'Save result';
        if (res.error) { notice($('fin-notice'), 'error', esc(res.error)); return; }
        notice($('fin-notice'), 'ok', (res.updated ? 'Updated' : 'Saved') + ' — ' + esc(res.memberName) +
          ', ' + esc(EVENTS.filter(function (e) { return e.key === res.event; })[0].label) + '.');
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Save result';
        notice($('fin-notice'), 'error', 'Could not reach the server — try again.');
      });
    });
  }

  function renderFinalLive() {
    var d = state.finalData;
    var html = donateCardHtml();
    html += '<div class="card"><h2>Grand standings</h2>' +
      '<p class="muted">4-week challenge points + Final Challenge event points.</p>';
    if (!d.grandStandings.length) {
      html += '<p class="muted">Nothing to show yet.</p>';
    } else {
      html += '<table class="board"><thead><tr><th></th><th>Team</th><th style="text-align:right">Total</th></tr></thead><tbody>';
      d.grandStandings.forEach(function (t, i) {
        var rank = i + 1;
        html += '<tr><td><span class="rank-chip rank-' + rank + '">' +
          (rank === 1 ? '<span class="belt">🏆</span>' : rank) + '</span></td>' +
          '<td><strong>' + esc(t.teamName) + '</strong><div class="sub">' +
          t.challengePoints + ' challenge + ' + t.finalPoints + ' final</div></td>' +
          '<td class="num">' + t.grandTotal + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    html += '<button class="btn ghost" id="final-refresh">Refresh</button></div>';

    EVENTS.forEach(function (ev) {
      var board = d.events[ev.key];
      if (!board) return;
      html += '<div class="card"><h2>' + esc(board.label) + '</h2>';
      if (!board.entries.length) {
        html += '<p class="muted">No results yet.</p>';
      } else {
        html += '<table class="board"><thead><tr><th></th><th>Team</th><th style="text-align:right">' +
          (ev.kind === 'time' ? 'Avg time' : 'Avg pts') + '</th><th style="text-align:right">Pts</th></tr></thead><tbody>';
        board.entries.forEach(function (t) {
          html += '<tr><td>' + (t.place ? '<span class="rank-chip rank-' + t.place + '">' + t.place + '</span>' : '') + '</td>' +
            '<td><strong>' + esc(t.teamName) + '</strong><div class="sub">' + t.participants + ' participating' +
            (t.qualified ? '' : ' · needs ' + d.config.finalMinParticipants + ' to qualify') + '</div></td>' +
            '<td class="num" style="font-size:17px">' + (ev.kind === 'time' ? secondsToClock(t.avg) : Math.round(t.avg)) + '</td>' +
            '<td class="num" style="font-size:17px;color:var(--gold)">' + (t.points || '') + '</td></tr>';
        });
        html += '</tbody></table>';
      }
      html += '</div>';
    });
    html += sponsorCardHtml();
    $('final-body').innerHTML = html;
    $('final-refresh').addEventListener('click', renderFinalView);
  }

  // ------------------------------------------------------------------ more / admin

  function renderMore() {
    var cfg = state.config;
    if (!cfg) return;
    var mpp = cfg.minutesPerPoint;
    var html = '<div class="card"><h2>How scoring works</h2>' +
      '<p>Log minutes each week in five categories. Circuits, Lifts, Core and Mobility earn 1 point per ' + mpp.circuits +
      ' minutes; Cardio earns 1 point per ' + mpp.cardio + ' minutes. Each category caps at ' + cfg.categoryMaxPerWeek +
      ' points per week (Monday to Sunday).</p><div class="spacer"></div>' +
      '<p>Score at least 1 point in all five categories in the same week and your total gets a +' + cfg.weeklyBonusPoints +
      ' bonus. Every $' + cfg.donationDollarsPerPoint + ' your team raises for ' + esc(cfg.charityName) +
      ' adds 1 bonus point to the team total.</p></div>';

    if (cfg.donationPageUrl) {
      html += '<div class="card"><h2>Donate</h2><p class="muted">All donations are tax deductible.</p>' +
        '<a class="btn gold" style="text-decoration:none;text-align:center" href="' + esc(cfg.donationPageUrl) +
        '" target="_blank" rel="noopener">Open the donation page</a></div>';
    }

    html += '<div class="card"><h2>Add this app to your phone</h2>' +
      '<p class="muted"><strong>iPhone:</strong> open this page in Safari → tap the Share button → "Add to Home Screen".<br>' +
      '<strong>Android:</strong> open in Chrome → menu (⋮) → "Add to Home screen".</p></div>';

    html += '<div class="card"><h2>Organizer</h2><div id="admin-area">' +
      '<label for="admin-pin">Admin PIN</label>' +
      '<input type="password" id="admin-pin" autocomplete="off">' +
      '<div id="admin-notice"></div>' +
      '<button class="btn ghost" id="admin-go">Open admin panel</button></div></div>';

    $('more-body').innerHTML = html;
    $('admin-go').addEventListener('click', function () {
      var pin = $('admin-pin').value.trim();
      if (!pin) { notice($('admin-notice'), 'error', 'Enter the PIN.'); return; }
      var btn = this; btn.disabled = true; btn.textContent = 'Checking…';
      apiPost({ action: 'adminGetState', pin: pin }).then(function (res) {
        btn.disabled = false; btn.textContent = 'Open admin panel';
        if (res.error) { notice($('admin-notice'), 'error', esc(res.error)); return; }
        state.adminPin = pin;
        state.adminState = res;
        renderAdmin();
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Open admin panel';
        notice($('admin-notice'), 'error', 'Could not reach the server.');
      });
    });
  }

  function renderAdmin() {
    var s = state.adminState;
    var c = s.config;
    var html = '<div class="card"><h2>Season settings</h2>' +
      '<label>Challenge name</label><input type="text" id="ad-name" value="' + esc(c.challengeName) + '">' +
      '<div class="row2"><div><label>Season label</label><input type="text" id="ad-season" value="' + esc(c.seasonLabel) + '"></div>' +
      '<div><label>Weeks</label><input type="number" id="ad-weeks" value="' + esc(c.numWeeks) + '"></div></div>' +
      '<div class="row2"><div><label>Week 1 starts (Mon)</label><input type="date" id="ad-start" value="' + esc(c.startDate) + '"></div>' +
      '<div><label>Final event date</label><input type="date" id="ad-finaldate" value="' + esc(c.finalEventDate) + '"></div></div>' +
      '<div class="row2"><div><label>Final start time</label><input type="time" id="ad-finaltime" value="' + esc(c.finalStartTime) + '"></div>' +
      '<div><label>Period minutes</label><input type="number" id="ad-period" value="' + esc(c.finalPeriodMinutes) + '"></div></div>' +
      '<label>Donation page URL</label><input type="text" id="ad-donurl" value="' + esc(c.donationPageUrl) + '" placeholder="https://www.canadahelps.org/...">' +
      '<div class="row3">' +
      '<div><label>Registration</label><select id="ad-reg"><option value="true"' + (c.registrationOpen === 'true' ? ' selected' : '') + '>Open</option><option value="false"' + (c.registrationOpen !== 'true' ? ' selected' : '') + '>Closed</option></select></div>' +
      '<div><label>Logging</label><select id="ad-log"><option value="true"' + (c.loggingOpen === 'true' ? ' selected' : '') + '>Open</option><option value="false"' + (c.loggingOpen !== 'true' ? ' selected' : '') + '>Closed</option></select></div>' +
      '<div><label>Final portal</label><select id="ad-final"><option value="true"' + (c.finalPortalOpen === 'true' ? ' selected' : '') + '>Open</option><option value="false"' + (c.finalPortalOpen !== 'true' ? ' selected' : '') + '>Closed</option></select></div>' +
      '</div><div id="ad-notice"></div>' +
      '<button class="btn" id="ad-save">Save settings</button></div>';

    html += '<div class="card"><h2>Donations → points</h2>' +
      '<p class="muted">Enter each team\'s total dollars raised (from the CanadaHelps pages). Points update instantly: $' +
      esc(c.donationDollarsPerPoint) + ' = 1 point.</p>';
    s.teams.forEach(function (t, i) {
      html += '<div class="cat-row" style="grid-template-columns:1fr 110px 60px">' +
        '<div class="cat-name">' + esc(t.teamName) + '<span class="cat-rate">code ' + esc(t.teamCode) + ' · ' + t.total + ' pts</span></div>' +
        '<input type="number" inputmode="decimal" min="0" id="don-' + i + '" data-team="' + esc(t.teamId) + '" value="' + (t.donationDollars || 0) + '">' +
        '<button class="btn btn-inline" style="margin:0" data-donate="' + i + '">Save</button></div>';
    });
    html += '<div id="don-notice"></div></div>';

    html += '<div class="card"><h2>Final Challenge schedule</h2>' +
      '<p class="muted">Distributes all registered teams across the four stations: everyone runs in Period 1, then teams rotate through Plank, Wall Sit and Push-Ups in balanced groups.</p>' +
      '<div id="sched-notice"></div>' +
      '<button class="btn" id="ad-schedule">Generate / regenerate rotation</button></div>';

    html += '<button class="btn ghost" id="ad-exit">Exit admin</button>';
    $('more-body').innerHTML = html;

    $('ad-exit').addEventListener('click', function () { state.adminPin = ''; renderMore(); });

    $('ad-save').addEventListener('click', function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Saving…';
      apiPost({
        action: 'adminSetConfig', pin: state.adminPin, updates: {
          challengeName: $('ad-name').value,
          seasonLabel: $('ad-season').value,
          numWeeks: $('ad-weeks').value,
          startDate: $('ad-start').value,
          finalEventDate: $('ad-finaldate').value,
          finalStartTime: $('ad-finaltime').value,
          finalPeriodMinutes: $('ad-period').value,
          donationPageUrl: $('ad-donurl').value,
          registrationOpen: $('ad-reg').value,
          loggingOpen: $('ad-log').value,
          finalPortalOpen: $('ad-final').value
        }
      }).then(function (res) {
        btn.disabled = false; btn.textContent = 'Save settings';
        if (res.error) { notice($('ad-notice'), 'error', esc(res.error)); return; }
        notice($('ad-notice'), 'ok', 'Settings saved.');
        state.config = null; boot();
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Save settings';
        notice($('ad-notice'), 'error', 'Could not reach the server.');
      });
    });

    document.querySelectorAll('[data-donate]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = btn.dataset.donate;
        var input = $('don-' + i);
        btn.disabled = true;
        apiPost({ action: 'adminSetDonation', pin: state.adminPin, teamId: input.dataset.team, dollars: input.value })
          .then(function (res) {
            btn.disabled = false;
            if (res.error) { notice($('don-notice'), 'error', esc(res.error)); return; }
            notice($('don-notice'), 'ok', esc(res.teamName) + ': $' + res.dollars + ' saved.');
          }).catch(function () { btn.disabled = false; notice($('don-notice'), 'error', 'Could not reach the server.'); });
      });
    });

    $('ad-schedule').addEventListener('click', function () {
      var btn = this; btn.disabled = true; btn.textContent = 'Generating…';
      apiPost({ action: 'adminGenerateSchedule', pin: state.adminPin }).then(function (res) {
        btn.disabled = false; btn.textContent = 'Generate / regenerate rotation';
        if (res.error) { notice($('sched-notice'), 'error', esc(res.error)); return; }
        notice($('sched-notice'), 'ok', res.teamsScheduled + ' teams scheduled. It\'s live on the Final tab.');
      }).catch(function () {
        btn.disabled = false; btn.textContent = 'Generate / regenerate rotation';
        notice($('sched-notice'), 'error', 'Could not reach the server.');
      });
    });
  }

  // ------------------------------------------------------------------ go

  boot();
})();
