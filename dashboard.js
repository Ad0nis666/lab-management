let dashboardPage = 1, dashboardFilter = 'all', dashboardRequest = 0;
const dashboardMessage = document.querySelector('#dashboard-message');
const dashboardBody = document.querySelector('#inventory-body');
const dashboardRetry = document.querySelector('#dashboard-retry');
const dashboardPrevious = document.querySelector('#dashboard-prev');
const dashboardNext = document.querySelector('#dashboard-next');
const dashboardChips = [...document.querySelectorAll('[data-filter]')];
const dashboardMetrics = { stocked_reagent_count: '#metric-stocked', low_stock_count: '#metric-low', expiring_bottle_count: '#metric-expiry', expired_bottle_count: '#metric-expired' };
function clearDashboard() {
  dashboardBody.replaceChildren();
  for (const selector of Object.values(dashboardMetrics)) document.querySelector(selector).textContent = '—';
  dashboardChips.forEach(chip => { chip.querySelector('span').textContent = '—'; });
  document.querySelector('#dashboard-page').textContent = '';
  document.querySelector('.notification-dot').hidden = true;
  document.querySelector('.notification-button').setAttribute('aria-label', '查看库存提醒');
  dashboardPrevious.disabled = dashboardNext.disabled = true;
}
async function loadDashboard() {
  const request = ++dashboardRequest;
  clearDashboard(); dashboardMessage.dataset.error = 'false'; dashboardMessage.textContent = '正在加载真实库存提醒…'; dashboardRetry.hidden = true;
  dashboardBody.setAttribute('aria-busy', 'true');
  try {
    const data = await businessRequest(`/api/v1/dashboard?type=${dashboardFilter}&page=${dashboardPage}&page_size=12`);
    if (request !== dashboardRequest) return;
    if (dashboardPage > Math.max(1, Math.ceil(data.total / data.page_size))) {
      dashboardPage = Math.max(1, Math.ceil(data.total / data.page_size)); return loadDashboard();
    }
    for (const [key, selector] of Object.entries(dashboardMetrics)) document.querySelector(selector).textContent = data.metrics[key];
    dashboardChips.forEach(chip => { chip.querySelector('span').textContent = data.counts[chip.dataset.filter]; });
    document.querySelector('#metric-expiry-hint').textContent = data.reminder_settings.expiry_enabled ? `未来 ${data.expiry_days} 天内到期` : '临期提醒已关闭';
    document.querySelector('#metric-low-hint').textContent = data.reminder_settings.low_enabled ? '种低于安全库存' : '低库存提醒已关闭';
    const badge = document.querySelector('.notification-dot'); badge.textContent = data.counts.all; badge.hidden = data.counts.all === 0;
    document.querySelector('.notification-button').setAttribute('aria-label', `查看 ${data.counts.all} 条库存提醒`);
    for (const item of data.items) {
      const row = document.createElement('tr'); row.dataset.status = item.type;
      const name = document.createElement('td'); name.append(textElement('strong', item.instrument_name || item.reagent_name), textElement('small', item.instrument_code || item.bottle_code || `可领库存 · 阈值 ${item.threshold} ${item.unit}`));
      row.append(name, textElement('td', item.location), textElement('td', item.type === 'calibration' ? `校准 ${item.calibration_on}` : `${item.quantity} ${item.unit}`));
      const status = document.createElement('td');
      const label = item.type === 'calibration' ? (item.days_until_calibration < 0 ? `校准逾期 ${-item.days_until_calibration} 天` : item.days_until_calibration === 0 ? '今天需校准' : `${item.days_until_calibration} 天后校准`) : item.type === 'low' ? '库存不足' : item.type === 'expired' ? `已过期 ${-item.days_until_expiry} 天` : item.days_until_expiry === 0 ? '今天到期' : `${item.days_until_expiry} 天后到期`;
      status.append(textElement('span', label, `status ${['expiry', 'calibration'].includes(item.type) ? 'status-warning' : 'status-danger'}`));
      if (item.bottle_id && item.tags.includes('low')) status.append(textElement('small', '档案库存不足'));
      row.append(status);
      const action = document.createElement('td'), button = textElement('button', '详情', 'table-action');
      button.setAttribute('aria-label', `查看${item.instrument_code || item.bottle_code || item.reagent_name}详情`);
      button.addEventListener('click', () => item.instrument_id ? openCollectionDetail('instruments', item.instrument_id) : item.bottle_id ? openBottleDetail(item.bottle_id) : openReagentDetail(item.reagent_id));
      action.append(button); row.append(action); dashboardBody.append(row);
    }
    dashboardMessage.textContent = data.total ? `按北京时间 ${data.today} 计算；临期提前 ${data.expiry_days} 天${data.reminder_settings.expiry_enabled ? '' : '（已关闭）'}，校准提前 ${data.calibration_days} 天${data.reminder_settings.calibration_enabled ? '' : '（已关闭）'}；低库存按可领量比较。` : '当前筛选下暂无库存提醒。';
    document.querySelector('#dashboard-page').textContent = `第 ${data.page} / ${Math.max(1, Math.ceil(data.total / data.page_size))} 页 · ${data.total} 条`;
    dashboardPrevious.disabled = dashboardPage <= 1; dashboardNext.disabled = dashboardPage * data.page_size >= data.total;
  } catch (error) {
    if (request !== dashboardRequest) return;
    clearDashboard(); dashboardMessage.dataset.error = 'true'; dashboardMessage.textContent = `库存提醒加载失败：${error.message}`; dashboardRetry.hidden = false;
  } finally { if (request === dashboardRequest) dashboardBody.setAttribute('aria-busy', 'false'); }
}
dashboardChips.forEach(chip => chip.addEventListener('click', () => {
  dashboardFilter = chip.dataset.filter; dashboardPage = 1;
  dashboardChips.forEach(item => { const active = item === chip; item.classList.toggle('is-active', active); item.setAttribute('aria-pressed', String(active)); });
  loadDashboard();
}));
dashboardPrevious.addEventListener('click', () => { dashboardPage--; loadDashboard(); });
dashboardNext.addEventListener('click', () => { dashboardPage++; loadDashboard(); });
dashboardRetry.addEventListener('click', loadDashboard);
document.querySelector('.notification-button').addEventListener('click', () => {
  showPage('overview');
  dashboardChips.find(chip => chip.dataset.filter === 'all').click();
  document.querySelector('.inventory-panel').scrollIntoView({ behavior: reducedMotion.matches ? 'instant' : 'smooth', block: 'start' });
});
function refreshVisibleDashboard() { if (!document.hidden && !document.querySelector('#page-overview').hidden) loadDashboard(); }
window.addEventListener('focus', refreshVisibleDashboard);
document.addEventListener('visibilitychange', refreshVisibleDashboard);
window.setInterval(refreshVisibleDashboard, 60000);
loadDashboard();
