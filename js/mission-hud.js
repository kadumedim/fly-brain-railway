/* mission-hud.js
 *
 * Sidebar HUD: mission checklist, live log, viewer count, Railway dashboard
 * links, and the admin panel (start / SWAT teardown / reset) behind the
 * password prompt. Spectators can never trigger mutations -- the server
 * rejects POSTs without the right x-fly-admin header.
 */
(function () {
	'use strict';

	var checklistEl = document.getElementById('checklist');
	var logEl = document.getElementById('missionLog');
	var missionStateEl = document.getElementById('missionState');
	var viewerEl = document.getElementById('viewerCount');
	var connEl = document.getElementById('connBadge');
	var scaleEl = document.getElementById('scaleIndicator');
	var linksEl = document.getElementById('hudLinks');
	var celebrationEl = document.getElementById('celebration');

	var adminBtn = document.getElementById('adminBtn');
	var adminPanel = document.getElementById('adminPanel');
	var adminPassword = document.getElementById('adminPassword');
	var startBtn = document.getElementById('startBtn');
	var swatBtn = document.getElementById('swatBtn');
	var resetBtn = document.getElementById('resetBtn');
	var adminMsg = document.getElementById('adminMsg');

	var statsEl = document.getElementById('missionStats');

	function fmtMs(ms) {
		var s = Math.round(ms / 1000);
		return Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's';
	}

	function renderStats() {
		var m = STREAM.mission;
		if (!m) return;
		var st = m.stats || {};
		var html = '';
		var running = m.mission === 'RUNNING' || m.mission === 'ARMED';
		if (running && m.startedAt) {
			html += '<span>⏱ <b>' + fmtMs(Math.max(0, Date.now() - m.startedAt)) + '</b></span>';
		}
		if (st.lastMs != null) html += '<span>last <b>' + fmtMs(st.lastMs) + '</b></span>';
		if (st.bestMs != null) html += '<span class="best">best <b>' + fmtMs(st.bestMs) + '</b></span>';
		if (st.runs > 0) html += '<span>runs <b>' + st.runs + '</b></span>';
		if (m.autoLoop) html += '<span>∞ auto-loop</span>';
		statsEl.innerHTML = html;
	}
	setInterval(renderStats, 1000);

	function esc(s) {
		var d = document.createElement('span');
		d.textContent = s;
		return d.innerHTML;
	}

	function renderChecklist() {
		var m = STREAM.mission;
		if (!m) return;
		var html = '';
		for (var i = 0; i < m.steps.length; i++) {
			var s = m.steps[i];
			html += '<li class="' + s.state + '"><span class="dot"></span>' +
				esc(s.title) +
				(s.retries > 0 && s.state !== 'DONE' ? '<span class="retries">retry ' + s.retries + '/3</span>' : '') +
				'</li>';
		}
		checklistEl.innerHTML = html;
		missionStateEl.textContent = m.mission;
		missionStateEl.className = 'mission-state ' + m.mission;
	}

	function renderLinks() {
		var m = STREAM.mission;
		if (!m) return;
		var html = '';
		if (m.projectUrl) {
			html += '<a href="' + esc(m.projectUrl) + '" target="_blank" rel="noopener">↗ verify on Railway dashboard (public project)</a>';
		}
		if (m.webDomain) {
			html += '<a href="https://' + esc(m.webDomain) + '" target="_blank" rel="noopener">↗ live web service: ' + esc(m.webDomain) + '</a>';
		}
		linksEl.innerHTML = html;
	}

	// Each SSE 'log' delta is appended directly (never diffed against the
	// client-side ring buffer, whose capped length made the old index-based
	// renderer freeze forever once it filled).
	function appendLogLine(entry) {
		var div = document.createElement('div');
		div.className = 'line';
		var t = new Date(entry.ts);
		div.innerHTML = '<time>' + t.toTimeString().slice(0, 8) + '</time>' + esc(entry.line);
		logEl.appendChild(div);
		while (logEl.children.length > 200) logEl.removeChild(logEl.firstChild);
		logEl.scrollTop = logEl.scrollHeight;
	}

	function rebuildLog() {
		var m = STREAM.mission;
		if (!m) return;
		logEl.innerHTML = '';
		for (var i = 0; i < m.log.length; i++) appendLogLine(m.log[i]);
	}

	function confetti() {
		var emojis = ['🎉', '🪰', '🟩', '✨', '🚂', '💚'];
		for (var i = 0; i < 60; i++) {
			var span = document.createElement('span');
			span.textContent = emojis[Math.floor(Math.random() * emojis.length)];
			span.style.left = (Math.random() * 100) + '%';
			span.style.animationDuration = (2.5 + Math.random() * 3) + 's';
			span.style.animationDelay = (Math.random() * 1.5) + 's';
			celebrationEl.appendChild(span);
		}
		celebrationEl.classList.remove('hidden');
		setTimeout(function () {
			celebrationEl.innerHTML = '';
			celebrationEl.classList.add('hidden');
		}, 8000);
	}

	/* ---- stream events ---- */

	STREAM.on('init', function (snap) {
		scaleEl.textContent = snap.brain.neuronCount.toLocaleString() + ' neurons / ' +
			snap.brain.edgeCount.toLocaleString() + ' connections — FlyWire FAFB v783' +
			(snap.config.dryRun ? ' · DRY RUN' : '');
		connEl.textContent = 'live';
		connEl.className = 'conn-badge on';
		renderChecklist();
		renderLinks();
		rebuildLog();
		renderStats();
	});

	STREAM.on('connection', function (up) {
		connEl.textContent = up ? 'live' : 'reconnecting…';
		connEl.className = 'conn-badge ' + (up ? 'on' : 'off');
	});

	STREAM.on('viewers', function (count) {
		viewerEl.textContent = '👁 ' + count;
	});

	STREAM.on('mission', function (evt) {
		switch (evt.kind) {
		case 'log': appendLogLine(evt); break;
		case 'step':
		case 'mission-state': renderChecklist(); break;
		case 'project':
		case 'domain': renderLinks(); break;
		case 'celebration': confetti(); renderLinks(); break;
		}
	});

	/* ---- admin panel ---- */

	adminPassword.value = localStorage.getItem('fly-admin-pw') || '';

	adminBtn.addEventListener('click', function () {
		adminPanel.classList.toggle('hidden');
	});

	function post(path, body) {
		localStorage.setItem('fly-admin-pw', adminPassword.value);
		return fetch(path, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'x-fly-admin': adminPassword.value,
			},
			body: JSON.stringify(body || {}),
		}).then(function (res) { return res.json(); }).then(function (r) {
			adminMsg.textContent = r.ok ? '✓ ok' : '✗ ' + (r.error || 'failed');
			return r;
		}).catch(function (err) {
			adminMsg.textContent = '✗ ' + err.message;
		});
	}

	// Two-click confirmation (no blocking dialogs)
	function armButton(btn, armedLabel, action) {
		var normalLabel = btn.textContent;
		var armed = false, timer = null;
		btn.addEventListener('click', function () {
			if (!armed) {
				armed = true;
				btn.textContent = typeof armedLabel === 'function' ? armedLabel() : armedLabel;
				timer = setTimeout(function () {
					armed = false;
					btn.textContent = normalLabel;
				}, 4000);
				return;
			}
			clearTimeout(timer);
			armed = false;
			btn.textContent = normalLabel;
			action();
		});
	}

	armButton(startBtn,
		function () {
			return STREAM.config.dryRun ? 'Confirm start? (dry run)' : '⚠ REALLY create REAL Railway services?';
		},
		function () { post('/api/mission/start', { confirm: true }); });

	armButton(swatBtn, '⚠ REALLY delete the spawned services?', function () {
		post('/api/mission/teardown');
	});

	resetBtn.addEventListener('click', function () {
		post('/api/mission/reset');
	});

	/* ---- "what's real?" disclosure modal ---- */

	var realBtn = document.getElementById('realBtn');
	var realModal = document.getElementById('realModal');
	var realClose = document.getElementById('realClose');

	realBtn.addEventListener('click', function () {
		realModal.classList.remove('hidden');
	});
	realClose.addEventListener('click', function () {
		realModal.classList.add('hidden');
	});
	realModal.addEventListener('click', function (e) {
		if (e.target === realModal) realModal.classList.add('hidden');
	});
	document.addEventListener('keydown', function (e) {
		if (e.key === 'Escape') realModal.classList.add('hidden');
	});
})();
