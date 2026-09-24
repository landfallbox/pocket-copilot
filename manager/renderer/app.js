  const $ = (id) => document.getElementById(id);

    function toast(msg, ms = 2500) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => t.classList.remove('show'), ms);
  }

  function setDot(el, cls) { el.className = 'dot' + (cls ? ' ' + cls : ''); }
  function setTile(id, text, cls) {
    const el = $(id);
    el.textContent = text;
    el.className = 't-val' + (cls ? ' ' + cls : '');
  }
  function fmtUptime(sec) {
    if (sec == null) return '-';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  // ---- 标签页切换（当前页记到 localStorage） ----
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $('page-status').hidden = name !== 'status';
    $('page-settings').hidden = name !== 'settings';
    try { localStorage.setItem('tab', name); } catch (e) {}
  }
  document.querySelectorAll('.tab').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
  let _tab = 'status';
  try { _tab = localStorage.getItem('tab') || 'status'; } catch (e) {}
  showTab(_tab);

  // ---- 环境变量 ----
  // 预填以注册表（HKCU\Environment）为准——那才是 VS Code 实际读取的值；未设置则留空
  async function loadEnv() {
    const v = await window.api.getEnv();
    $('envPort').value = v.port || '';
    $('envHost').value = v.host || '';
    $('envToken').value = v.token || '';
  }
  $('btnGenToken').onclick = () => {
    const t = crypto.getRandomValues(new Uint8Array(32));
    $('envToken').value = Array.from(t, (b) => b.toString(16).padStart(2, '0')).join('');
  };
  $('btnSaveEnv').onclick = async () => {
    const port = $('envPort').value.trim(), host = $('envHost').value.trim(), token = $('envToken').value.trim();
    if (!port || !host || !token) { toast('请先填写完整的 port / host / token（token 可点"生成"）', 4000); return; }
    const r = await window.api.saveEnv({ port, host, token });
    if (r.ok) { $('envBanner').classList.add('show'); toast('环境变量已保存'); }
    else toast('保存失败：' + (r.error || r.stderr || ''), 5000);
  };
  $('btnRestartLater').onclick = () => $('envBanner').classList.remove('show');
  $('btnRestartNow').onclick = async () => {
    if (!confirm('将结束所有 VS Code 窗口（含未保存内容风险）并重新打开，确定？')) return;
    $('btnVsRestart').disabled = true;
    const r = await window.api.vscodeRestart();
    $('btnVsRestart').disabled = false;
    if (r.relaunched?.ok) toast('VS Code 已重新拉起');
    else toast('重启失败：' + (r.relaunched?.error || r.detail || ''), 5000);
  };
  $('btnVsRestart').onclick = async () => {
    if (!confirm('将结束所有 VS Code 窗口并重新打开本工作区，确定？')) return;
    $('btnVsRestart').disabled = true;
    const r = await window.api.vscodeRestart();
    $('btnVsRestart').disabled = false;
    if (r.relaunched?.ok) toast('VS Code 已重新拉起');
    else toast('重启失败：' + (r.relaunched?.error || r.detail || ''), 5000);
  };

  // ---- daemon / 隧道 ----
  $('btnDaemonStart').onclick = async () => {
    const r = await window.api.daemonStart();
    toast(r.already ? 'daemon 已在运行' : 'daemon 启动中…');
  };
  $('btnDaemonStop').onclick = async () => {
    const r = await window.api.daemonStop();
    toast(r.detail === 'not-listening' ? 'daemon 未在运行' : 'daemon 已停止');
  };
  $('btnTunnelStart').onclick = async () => {
    const r = await window.api.tunnelStart();
    toast(r.already ? '隧道已在运行' : '隧道启动中…');
  };
  $('btnTunnelStop').onclick = async () => {
    const r = await window.api.tunnelStop();
    toast(r.detail ? `已停止：${r.detail}` : '隧道已停止');
  };
  $('btnDaemonLog').onclick = () => window.api.openLog('daemon');
  $('btnTunnelLog').onclick = () => window.api.openLog('tunnel');

  // ---- 启动与自启 设置 ----
  async function loadSettings() {
    const s = await window.api.getSettings();
    $('chkAppAutoStart').checked = !!s.appAutoStart;
    $('chkAutoDaemon').checked = !!s.autoStartDaemon;
    $('chkAutoTunnel').checked = !!s.autoStartTunnel;
  }
  async function saveSetting(key, el, onMsg, offMsg) {
    const r = await window.api.setSettings({ [key]: el.checked });
    if (!r.ok) { el.checked = !el.checked; toast('设置失败：' + (r.error || ''), 4000); return; }
    el.checked = !!r[key];
    toast(el.checked ? onMsg : offMsg);
  }
  $('chkAppAutoStart').onchange = () => saveSetting('appAutoStart', $('chkAppAutoStart'), '已开启开机自启', '已关闭开机自启');
  $('chkAutoDaemon').onchange = () => saveSetting('autoStartDaemon', $('chkAutoDaemon'), '下次启动应用时将自动开启 Daemon', '下次启动应用时不再自动开启 Daemon');
  $('chkAutoTunnel').onchange = () => saveSetting('autoStartTunnel', $('chkAutoTunnel'), '下次启动应用时将自动开启公网隧道', '下次启动应用时不再自动开启公网隧道');

  // ---- 状态渲染 ----
  function renderStatus(s) {
    $('updatedAt').textContent = '更新于 ' + new Date(s.at).toLocaleTimeString('zh-CN');
    const d = s.daemon;

    setDot($('vsDot'), d.ahpConnected ? 'on' : 'off');
    window.api.vscodeRunning().then((on) => {
      const ahp = d.ahpConnected ? 'ok' : 'warn';
      $('vsState').textContent = on ? '运行中' : '未运行';
      $('vsState').dataset.tone = on ? ahp : 'off';
      setDot($('vsDot'), on ? ahp : 'off');
      setTile('tileVs', on ? (d.ahpConnected ? '运行中' : 'AHP 未连') : '未运行', on ? ahp : 'off');
    });
    $('ahpPort').textContent = d.agentHostPort;
    $('ahpConnected').textContent = d.ahpConnected ? '是' : '否';
    $('ahpConnected').dataset.tone = d.ahpConnected ? 'ok' : 'off';

    setDot($('daemonDot'), d.running ? 'on' : 'off');
    $('daemonState').textContent = d.running ? `运行中${d.managed ? '（本应用管理）' : ''}` : '停止';
    $('daemonState').dataset.tone = d.running ? 'ok' : 'off';
    $('daemonPid').textContent = d.running ? `${d.pid} / ${fmtUptime(d.uptimeSec)}` : '-';
    setTile('tileDaemon', d.running ? `运行中 · ${d.pid}` : '停止', d.running ? 'ok' : 'off');

    setDot($('tunnelDot'), s.tunnel.running ? (s.tunnel.publicUp ? 'on' : 'warn') : 'off');
    $('tunnelState').textContent = s.tunnel.running ? `监听中${s.tunnel.managed ? '（本应用管理）' : ''}` : '未监听';
    $('tunnelState').dataset.tone = s.tunnel.running ? (s.tunnel.publicUp ? 'ok' : 'warn') : 'off';
    $('publicState').textContent = s.tunnel.publicUp ? '可达' : '不可达';
    $('publicState').dataset.tone = s.tunnel.publicUp ? 'ok' : 'off';
    $('publicUrl').textContent = s.tunnel.publicUrl;
    setTile('tileTunnel', s.tunnel.running ? (s.tunnel.publicUp ? '监听中' : '公网不可达') : '未监听',
      s.tunnel.running ? (s.tunnel.publicUp ? 'ok' : 'warn') : 'off');

    setDot($('phoneDot'), d.phones.length > 0 ? 'on' : 'off');
    setTile('tilePhone', d.phones.length ? `${d.phones.length} 台在线` : '未连接', d.phones.length ? 'ok' : 'off');
    const phonesEl = $('phonesArea');
    phonesEl.className = d.phones.length ? '' : 'empty';
    phonesEl.innerHTML = d.phones.length
      ? d.phones.map((p) =>
          `<div class="phone-chip"><span class="p-name">${esc(p.name || '未命名')}</span>` +
          `<span class="p-meta">${p.connectedAt ? '连接于 ' + new Date(p.connectedAt).toLocaleString('zh-CN') : ''}</span>` +
          `<span class="p-alive ${p.alive ? 'ok' : 'bad'}">${p.alive ? '心跳正常' : '心跳超时'}</span></div>`
        ).join('')
      : '暂无手机连接';

    const sessionsEl = $('sessionsArea');
    sessionsEl.className = d.sessions.length ? '' : 'empty';
    sessionsEl.innerHTML = d.sessions.length
      ? '<div class="sessions-scroll"><table><thead><tr><th>会话标题</th><th>状态</th><th>焦点</th></tr></thead><tbody>' +
        d.sessions.map((x) =>
          `<tr><td>${esc(x.title || x.id)}</td><td>${esc(x.status || '-')}</td><td>${d.focusSessionId === x.id ? '●' : ''}</td></tr>`
        ).join('') + '</tbody></table></div>'
      : '暂无会话（AHP 未连接时为空）';
  }

  window.api.onStatus(renderStatus);

  (async function init() {
    await loadEnv();
    await loadSettings();
    const s = await window.api.statusNow();
    renderStatus(s);
  })();
