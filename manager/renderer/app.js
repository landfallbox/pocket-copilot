  const $ = (id) => document.getElementById(id);

    function toast(msg, ms = 2500) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.style.display = 'none'), ms);
  }

  function setDot(el, cls) { el.className = 'dot' + (cls ? ' ' + cls : ''); }
  function fmtUptime(sec) {
    if (sec == null) return '-';
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

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

  $('chkAutoStart').onchange = async () => {
    const r = await window.api.setAutoStart($('chkAutoStart').checked);
    if (!r.ok && $('chkAutoStart').checked) { $('chkAutoStart').checked = false; toast('设置自启失败', 4000); }
    else toast($('chkAutoStart').checked ? '已开启开机自启' : '已关闭开机自启');
  };

  // ---- 状态渲染 ----
  function renderStatus(s) {
    $('updatedAt').textContent = '更新于 ' + new Date(s.at).toLocaleTimeString('zh-CN');
    const d = s.daemon;

    setDot($('vsDot'), d.ahpConnected ? 'on' : 'off');
    window.api.vscodeRunning().then((on) => {
      $('vsState').textContent = on ? '运行中' : '未运行';
      setDot($('vsDot'), on ? (d.ahpConnected ? 'on' : 'warn') : 'off');
    });
    $('ahpPort').textContent = d.agentHostPort;
    $('ahpConnected').textContent = d.ahpConnected ? '是' : '否';

    setDot($('daemonDot'), d.running ? 'on' : 'off');
    $('daemonState').textContent = d.running ? `运行中${d.managed ? '（本应用管理）' : ''}` : '停止';
    $('daemonPid').textContent = d.running ? `${d.pid} / ${fmtUptime(d.uptimeSec)}` : '-';

    setDot($('tunnelDot'), s.tunnel.running ? (s.tunnel.publicUp ? 'on' : 'warn') : 'off');
    $('tunnelState').textContent = s.tunnel.running ? `监听中${s.tunnel.managed ? '（本应用管理）' : ''}` : '未监听';
    $('publicState').textContent = s.tunnel.publicUp ? '可达' : '不可达';
    $('publicUrl').textContent = s.tunnel.publicUrl;

    setDot($('phoneDot'), d.phones.length > 0 ? 'on' : 'off');
    $('phonesArea').innerHTML = d.phones.length
      ? '<table><tr><th>设备名</th><th>连接时间</th><th>心跳</th></tr>' +
        d.phones.map((p) => `<tr><td>${esc(p.name || '-')}</td><td>${esc(p.connectedAt ? new Date(p.connectedAt).toLocaleString('zh-CN') : '-')}</td><td>${p.alive ? '正常' : '超时'}</td></tr>`).join('') +
        '</table>'
      : '<div class="empty">暂无手机连接</div>';

    $('sessionsArea').innerHTML = d.sessions.length
      ? '<table><tr><th>会话</th><th>状态</th><th>焦点</th></tr>' +
        d.sessions.map((x) =>
          `<tr><td>${esc(x.title || x.id)}</td><td>${esc(x.status || '-')}</td><td>${d.focusSessionId === x.id ? '●' : ''}</td></tr>`
        ).join('') + '</table>'
      : '<div class="empty">暂无会话（AHP 未连接时为空）</div>';
  }

  window.api.onStatus(renderStatus);

  (async function init() {
    await loadEnv();
    const s = await window.api.statusNow();
    renderStatus(s);
    const auto = await window.api.getAutoStart();
    $('chkAutoStart').checked = !!auto;
  })();
