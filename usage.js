const usageDialog = document.querySelector('#usage-dialog'), usageForm = document.querySelector('#usage-form');
const usageError = document.querySelector('#usage-error'), usageBottle = document.querySelector('#usage-bottle');
let canRecordForOthers = false;
let usageOptions = [], optionsPage = 1, optionsRequest = 0, preferredBottle, usageKey, usagePayload;
let recentRequest = 0, historyRequest = 0, historyPage = 1, bottleHistoryRequest = 0, bottleHistoryPage = 1;
function updateUsageStock() {
  const bottle = usageOptions.find(row => row.id === usageBottle.value);
  document.querySelector('#usage-stock').textContent = bottle ? `当前余量：${bottle.remaining_quantity} ${bottle.unit} · ${bottle.location || '位置未填写'} · 有效期 ${bottle.expires_on || '未填写'}` : '请先选择可领单瓶。';
  if (bottle) {
    usageForm.elements.unit.querySelectorAll('option').forEach(option => { option.disabled = ['mL', 'L'].includes(option.value) !== ['mL', 'L'].includes(bottle.unit); });
    usageForm.elements.unit.value = bottle.unit;
    usageForm.elements.used_on.min = bottle.received_on;
  }
}
async function loadUsageOptions() {
  const request = ++optionsRequest;
  usageBottle.replaceChildren(); usageOptions = []; updateUsageStock();
  const message = document.querySelector('#usage-options-message'); message.textContent = '正在查询可领单瓶…';
  document.querySelector('#usage-options-retry').hidden = true;
  document.querySelector('#usage-options-prev').disabled = document.querySelector('#usage-options-next').disabled = true;
  document.querySelector('#usage-options-page').textContent = '';
  try {
    const [result, members] = await Promise.all([
      businessRequest(`/api/v1/bottles?${new URLSearchParams({ available: 'true', q: document.querySelector('#usage-bottle-search').value.trim(), page: optionsPage, page_size: 20 })}`),
      businessRequest('/api/v1/users'),
    ]);
    if (request !== optionsRequest) return;
    const selectedPerson = usageForm.elements.used_by.value;
    usageForm.elements.used_by.replaceChildren();
    members.items.forEach(user => { const option = textElement('option', user.display_name); option.value = user.id; usageForm.elements.used_by.append(option); });
    if (members.items.some(user => user.id === selectedPerson)) usageForm.elements.used_by.value = selectedPerson;
    else usageForm.elements.used_by.value = members.current_user_id;
    canRecordForOthers = members.can_record_for_others;
    usageForm.elements.used_by.disabled = !canRecordForOthers;
    usageOptions = result.items;
    let preferredUnavailable = false;
    if (preferredBottle && !usageOptions.some(row => row.id === preferredBottle)) {
      const { bottle } = await businessRequest(`/api/v1/bottles/${encodeURIComponent(preferredBottle)}`);
      if (request !== optionsRequest) return;
      if (bottle.lifecycle_status === 'in_stock' && bottle.expiry_status !== 'expired' && Number(bottle.remaining_quantity) > 0) usageOptions.unshift(bottle);
      else preferredUnavailable = true;
    }
    if (preferredUnavailable) { const placeholder = textElement('option', '原单瓶不可领，请重新选择'); placeholder.value = ''; placeholder.disabled = true; usageBottle.append(placeholder); }
    usageOptions.forEach(bottle => { const option = textElement('option', `${bottle.reagent_name} · ${bottle.bottle_code} · ${bottle.remaining_quantity} ${bottle.unit}`); option.value = bottle.id; usageBottle.append(option); });
    if (preferredBottle && usageOptions.some(row => row.id === preferredBottle)) usageBottle.value = preferredBottle;
    if (preferredUnavailable) usageBottle.value = '';
    updateUsageStock();
    message.textContent = preferredUnavailable ? '原单瓶已不可领，请重新选择。' : usageOptions.length ? '' : '没有可领单瓶，请联系管理员入库。';
    const pages = Math.max(1, Math.ceil(result.total / result.page_size));
    document.querySelector('#usage-options-page').textContent = `第 ${result.page} / ${pages} 页`;
    document.querySelector('#usage-options-prev').disabled = result.page <= 1;
    document.querySelector('#usage-options-next').disabled = result.page >= pages;
  } catch (error) {
    if (request !== optionsRequest) return;
    message.textContent = error.message; document.querySelector('#usage-options-retry').hidden = false;
  }
}
async function openUsage(id) {
  if (!await requireInformationWrite()) return;
  usageForm.reset(); usageForm.elements.used_by.value = ''; usageError.textContent = ''; preferredBottle = id || undefined; optionsPage = 1; usageKey = undefined; usagePayload = undefined;
  usageForm.elements.used_on.value = shanghaiDate(); usageForm.elements.used_on.max = shanghaiDate();
  if (!usageDialog.open) usageDialog.showModal();
  await loadUsageOptions();
}
document.querySelectorAll('[data-open-usage]').forEach(button => button.addEventListener('click', () => openUsage()));
document.querySelector('#bottle-open-usage').addEventListener('click', () => openUsage(currentBottleId));
document.querySelectorAll('[data-close-usage]').forEach(button => button.addEventListener('click', () => usageDialog.close()));
usageDialog.addEventListener('close', () => { optionsRequest++; });
usageDialog.addEventListener('cancel', event => { if (usageForm.querySelector('[type="submit"]').disabled) event.preventDefault(); });
usageBottle.addEventListener('change', () => { preferredBottle = usageBottle.value; updateUsageStock(); });
document.querySelector('#usage-bottle-search').addEventListener('input', () => { optionsPage = 1; preferredBottle = undefined; loadUsageOptions(); });
document.querySelector('#usage-options-prev').addEventListener('click', () => { optionsPage--; preferredBottle = undefined; loadUsageOptions(); });
document.querySelector('#usage-options-next').addEventListener('click', () => { optionsPage++; preferredBottle = undefined; loadUsageOptions(); });
document.querySelector('#usage-options-retry').addEventListener('click', loadUsageOptions);
usageForm.addEventListener('submit', async event => {
  event.preventDefault(); const button = usageForm.querySelector('[type="submit"]'); if (button.disabled) return;
  const fields = usageForm.elements;
  if (!usageBottle.value || !fields.used_by.value) { usageError.textContent = '请等待单瓶和成员加载后选择。'; return; }
  if (!fields.amount.value || !fields.amount.validity.valid || Number(fields.amount.value) <= 0) { usageError.textContent = '使用量须大于零且最多两位小数。'; fields.amount.focus(); return; }
  if (!fields.used_on.value || !fields.used_on.validity.valid || !fields.purpose.value.trim()) { usageError.textContent = '请填写有效使用日期和实验用途。'; return; }
  const data = { amount: fields.amount.value, unit: fields.unit.value, used_on: fields.used_on.value, used_by: fields.used_by.value, purpose: fields.purpose.value.trim() };
  const id = usageBottle.value, payload = JSON.stringify({ bottle_id: id, ...data });
  if (usagePayload !== payload) { usagePayload = payload; usageKey = crypto.randomUUID(); }
  const controls = [...usageForm.querySelectorAll('input, select, button')]; controls.forEach(control => { control.disabled = true; });
  button.textContent = '正在保存…'; usageError.textContent = '';
  try {
    const result = await businessRequest(`/api/v1/bottles/${id}/consumptions`, data, { 'Idempotency-Key': usageKey });
    usageDialog.close(); await loadCatalog(); await loadRecentUsage(); await loadDashboard();
    if (detailDialog.open) await openReagentDetail(detailId);
    if (bottleDetails.open) await openBottleDetail(currentBottleId);
    if (!document.querySelector('#page-history').hidden) await loadHistory();
    toast.querySelector('span').textContent = `领用已保存，当前余量 ${result.bottle.remaining_quantity} ${result.bottle.unit}`;
    toast.classList.add('is-visible'); window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  } catch (error) {
    if (error.status === 409) { preferredBottle = id; await loadUsageOptions(); await loadCatalog(); }
    usageError.textContent = error.message; usageError.focus();
  } finally { controls.forEach(control => { control.disabled = false; }); fields.used_by.disabled = !canRecordForOthers; button.textContent = '保存领用'; }
});
function renderMovement(movement, compact = false) {
  const row = textElement('article', '', compact ? 'usage-record history-record' : 'history-record');
  const heading = textElement('strong', `${movement.type === 'receipt' ? '入库' : '领用'} · ${movement.reagent_name} · ${movement.bottle_code}`);
  const quantity = textElement('p', `${movement.quantity_delta} ${movement.unit} · ${movement.before_quantity} → ${movement.after_quantity} ${movement.unit}`);
  const people = textElement('p', `使用人：${movement.used_by_name || '—'} · 操作者：${movement.recorded_by_name}`);
  const purpose = textElement('p', movement.purpose || '单瓶入库');
  const time = textElement('p', `业务日期 ${movement.used_on} · 登记时间 ${new Date(movement.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
  if (movement.requested_unit && movement.requested_unit !== movement.unit) quantity.append(textElement('span', `（请求 ${movement.requested_amount} ${movement.requested_unit}）`));
  row.append(heading, quantity, people, purpose, time); return row;
}
async function loadRecentUsage() {
  const request = ++recentRequest, records = document.querySelector('#usage-records'), message = document.querySelector('#usage-recent-message'), feedback = document.querySelector('#usage-feedback');
  feedback.hidden = false; feedback.dataset.error = 'false';
  records.replaceChildren(); message.textContent = '正在加载最近领用…'; document.querySelector('#usage-recent-retry').hidden = true;
  try {
    const result = await businessRequest('/api/v1/consumptions?page_size=5'); if (request !== recentRequest) return;
    message.textContent = ''; feedback.hidden = true; result.items.forEach(row => records.append(renderMovement(row, true)));
    if (!result.total) records.append(textElement('p', '尚无真实领用记录。', 'usage-empty'));
  } catch (error) { if (request !== recentRequest) return; feedback.hidden = false; feedback.dataset.error = 'true'; message.textContent = error.message; document.querySelector('#usage-recent-retry').hidden = false; }
}
document.querySelector('#usage-recent-retry').addEventListener('click', loadRecentUsage);
const historyForm = document.querySelector('#history-filter');
async function loadHistory() {
  const request = ++historyRequest, records = document.querySelector('#history-records'), message = document.querySelector('#history-message');
  const params = new URLSearchParams({ page: historyPage, page_size: 20 });
  for (const [key, value] of new FormData(historyForm)) if (value.trim()) params.set(key, value.trim());
  records.replaceChildren(); message.textContent = '正在加载完整历史…'; document.querySelector('#history-retry').hidden = true;
  document.querySelector('#history-prev').disabled = document.querySelector('#history-next').disabled = true; document.querySelector('#history-page-info').textContent = '';
  try {
    const result = await businessRequest(`/api/v1/movements?${params}`); if (request !== historyRequest) return;
    message.textContent = result.total ? '' : '没有匹配的库存流水。'; result.items.forEach(row => records.append(renderMovement(row)));
    const pages = Math.max(1, Math.ceil(result.total / result.page_size)); document.querySelector('#history-page-info').textContent = `第 ${result.page} / ${pages} 页 · ${result.total} 条`;
    document.querySelector('#history-prev').disabled = result.page <= 1; document.querySelector('#history-next').disabled = result.page >= pages;
  } catch (error) { if (request !== historyRequest) return; message.textContent = error.message; document.querySelector('#history-retry').hidden = false; }
}
historyForm.addEventListener('submit', event => { event.preventDefault(); historyPage = 1; loadHistory(); });
document.querySelector('#history-clear').addEventListener('click', () => { historyForm.reset(); historyPage = 1; loadHistory(); });
document.querySelector('#history-prev').addEventListener('click', () => { historyPage--; loadHistory(); });
document.querySelector('#history-next').addEventListener('click', () => { historyPage++; loadHistory(); });
document.querySelector('#history-retry').addEventListener('click', loadHistory);
function cancelBottleHistory() { bottleHistoryRequest++; bottleHistoryPage = 1; document.querySelector('#bottle-history').replaceChildren(); document.querySelector('#bottle-history-message').textContent = ''; document.querySelector('#bottle-history-page').textContent = ''; document.querySelector('#bottle-history-prev').disabled = document.querySelector('#bottle-history-next').disabled = true; }
async function loadBottleHistory(id, page = 1) {
  bottleHistoryPage = page; const request = ++bottleHistoryRequest;
  const records = document.querySelector('#bottle-history'), message = document.querySelector('#bottle-history-message'); records.replaceChildren(); message.textContent = '正在加载本瓶历史…';
  document.querySelector('#bottle-history-retry').hidden = true; document.querySelector('#bottle-history-prev').disabled = document.querySelector('#bottle-history-next').disabled = true;
  try {
    const result = await businessRequest(`/api/v1/bottles/${id}/movements?page=${page}&page_size=10`); if (request !== bottleHistoryRequest) return;
    message.textContent = ''; result.items.forEach(row => records.append(renderMovement(row)));
    const pages = Math.max(1, Math.ceil(result.total / result.page_size)); document.querySelector('#bottle-history-page').textContent = `第 ${result.page} / ${pages} 页 · ${result.total} 条`;
    document.querySelector('#bottle-history-prev').disabled = page <= 1; document.querySelector('#bottle-history-next').disabled = page >= pages;
  } catch (error) { if (request !== bottleHistoryRequest) return; message.textContent = error.message; document.querySelector('#bottle-history-retry').hidden = false; }
}
document.querySelector('#bottle-history-prev').addEventListener('click', () => loadBottleHistory(currentBottleId, bottleHistoryPage - 1));
document.querySelector('#bottle-history-next').addEventListener('click', () => loadBottleHistory(currentBottleId, bottleHistoryPage + 1));
document.querySelector('#bottle-history-retry').addEventListener('click', () => loadBottleHistory(currentBottleId, bottleHistoryPage));
loadRecentUsage();
