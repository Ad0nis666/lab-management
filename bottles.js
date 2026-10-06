const bottleDialog = document.querySelector('#bottle-dialog');
const bottleForm = document.querySelector('#bottle-form');
let receiptReagent, receiptKey, receiptPayload, bottlePage = 1, bottleListRequest = 0, profileForBottles;
let currentBottleId, bottleDetailRequest = 0;
function shanghaiDate() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function cancelBottleList() { bottleListRequest++; profileForBottles = undefined; }
function setDetailReagent(reagent) {
  profileForBottles = reagent; bottlePage = 1;
  document.querySelector('#detail-open-bottle').hidden = false;
}
document.querySelector('#detail-open-bottle').addEventListener('click', () => { if (profileForBottles) openBottleForm(profileForBottles); });
window.addEventListener('lab-session', () => { document.querySelector('#detail-open-bottle').hidden = !profileForBottles; });
async function openBottleForm(reagent) {
  if (!await requireInformationWrite()) return;
  receiptReagent = reagent; receiptKey = undefined; receiptPayload = undefined;
  bottleForm.reset(); document.querySelector('#bottle-error').textContent = '';
  document.querySelector('#bottle-reagent-name').textContent = `试剂：${reagent.name}`;
  bottleForm.elements.unit.querySelectorAll('option').forEach(option => {
    option.disabled = ['mL', 'L'].includes(option.value) !== ['mL', 'L'].includes(reagent.stock_unit);
  });
  bottleForm.elements.unit.value = reagent.stock_unit;
  bottleForm.elements.received_on.value = shanghaiDate();
  bottleForm.elements.received_on.max = shanghaiDate();
  bottleDialog.showModal();
}
document.querySelectorAll('[data-close-bottle]').forEach(button => button.addEventListener('click', () => bottleDialog.close()));
bottleDialog.addEventListener('cancel', event => { if (bottleForm.querySelector('[type="submit"]').disabled) event.preventDefault(); });
bottleForm.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = bottleForm.querySelector('[type="submit"]');
  if (submit.disabled) return;
  const data = Object.fromEntries(new FormData(bottleForm));
  const payload = JSON.stringify(data);
  if (payload !== receiptPayload) { receiptKey = crypto.randomUUID(); receiptPayload = payload; }
  const controls = [...bottleForm.querySelectorAll('input, select, button')];
  controls.forEach(control => { control.disabled = true; });
  submit.textContent = '正在保存…';
  const errorMessage = document.querySelector('#bottle-error'); errorMessage.textContent = '';
  try {
    const result = await businessRequest(`/api/v1/reagents/${receiptReagent.id}/bottles`, data, { 'Idempotency-Key': receiptKey });
    bottleDialog.close(); bottleForm.reset();
    await loadCatalog(); await loadDashboard();
    if (detailDialog.open && detailId === receiptReagent.id) await openReagentDetail(receiptReagent.id);
    toast.querySelector('span').textContent = `单瓶 ${result.bottle.bottle_code} 已入库`;
    toast.classList.add('is-visible'); window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  } catch (error) { errorMessage.textContent = error.message; errorMessage.focus(); }
  finally { controls.forEach(control => { control.disabled = false; }); submit.textContent = '保存入库'; }
});
async function loadBottleList() {
  if (!profileForBottles) return;
  const reagentId = profileForBottles.id, request = ++bottleListRequest;
  const list = document.querySelector('#bottle-list'), message = document.querySelector('#bottle-list-message');
  list.replaceChildren(); message.textContent = '正在加载单瓶库存…';
  document.querySelector('#bottle-list-retry').hidden = true;
  document.querySelector('#bottle-prev').disabled = document.querySelector('#bottle-next').disabled = true;
  document.querySelector('#bottle-page-info').textContent = '';
  try {
    const result = await businessRequest(`/api/v1/reagents/${reagentId}/bottles?${new URLSearchParams({ page: bottlePage, page_size: 5 })}`);
    if (request !== bottleListRequest) return;
    message.textContent = result.total ? '' : '暂无单瓶入库记录。';
    for (const bottle of result.items) {
      const row = textElement('article', '', 'bottle-row');
      const button = textElement('button', bottle.bottle_code, 'card-link'); button.type = 'button';
      button.addEventListener('click', () => openBottleDetail(bottle.id));
      row.append(button, textElement('p', `批次 ${bottle.batch_no || '未填写'} · ${bottle.remaining_quantity} ${bottle.unit}`), textElement('p', bottle.location || '位置未填写'), textElement('p', `有效期 ${bottle.expires_on || '未填写'} · ${bottle.lifecycle_status === 'depleted' ? '已用完' : bottle.expiry_status === 'unknown' ? '有效期未填写' : bottle.expiry_status === 'expired' ? '已过期，不计入可领' : '未过期'}`));
      if (bottle.lifecycle_status === 'in_stock' && bottle.expiry_status !== 'expired' && Number(bottle.remaining_quantity) > 0) {
        const use = textElement('button', '登记领用', 'card-link'); use.type = 'button'; use.dataset.writeAction = ''; use.addEventListener('click', () => openUsage(bottle.id)); row.append(use);
      }
      list.append(row);
    }
    const pages = Math.max(1, Math.ceil(result.total / result.page_size));
    document.querySelector('#bottle-page-info').textContent = `第 ${result.page} / ${pages} 页 · ${result.total} 瓶`;
    document.querySelector('#bottle-prev').disabled = result.page <= 1;
    document.querySelector('#bottle-next').disabled = result.page >= pages;
  } catch (error) {
    if (request !== bottleListRequest) return;
    message.textContent = error.message; document.querySelector('#bottle-list-retry').hidden = false;
  }
}
document.querySelector('#bottle-prev').addEventListener('click', () => { bottlePage--; loadBottleList(); });
document.querySelector('#bottle-next').addEventListener('click', () => { bottlePage++; loadBottleList(); });
document.querySelector('#bottle-list-retry').addEventListener('click', loadBottleList);
const bottleDetails = document.querySelector('#bottle-detail-dialog');
async function openBottleDetail(id) {
  currentBottleId = id; const request = ++bottleDetailRequest;
  const content = document.querySelector('#bottle-detail'), message = document.querySelector('#bottle-detail-message');
  content.replaceChildren(); message.textContent = '正在加载单瓶详情…';
  cancelBottleHistory();
  document.querySelector('#bottle-open-usage').hidden = true;
  document.querySelector('#bottle-detail-title').textContent = '单瓶详情';
  document.querySelector('#bottle-detail-retry').hidden = true;
  if (!bottleDetails.open) bottleDetails.showModal();
  try {
    const { bottle } = await businessRequest(`/api/v1/bottles/${encodeURIComponent(id)}`);
    if (request !== bottleDetailRequest) return;
    message.textContent = ''; document.querySelector('#bottle-detail-title').textContent = bottle.bottle_code;
    document.querySelector('#bottle-open-usage').hidden = bottle.lifecycle_status !== 'in_stock' || bottle.expiry_status === 'expired' || Number(bottle.remaining_quantity) <= 0;
    loadBottleHistory(id);
    for (const [label, value] of [['瓶号', bottle.bottle_code], ['批次', bottle.batch_no], ['初始量', `${bottle.initial_quantity} ${bottle.unit}`], ['剩余量', `${bottle.remaining_quantity} ${bottle.unit}`], ['存放位置', bottle.location], ['入库日期', bottle.received_on], ['有效期至', bottle.expires_on], ['到期状态', bottle.expiry_status === 'unknown' ? '未填写' : bottle.expiry_status === 'expired' ? '已过期' : '未过期'], ['生命周期', bottle.lifecycle_status === 'in_stock' ? '在库' : bottle.lifecycle_status], ['记录人 ID', bottle.created_by], ['创建时间', new Date(bottle.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })]]) {
      const row = document.createElement('div'); row.append(textElement('dt', label), textElement('dd', value || '未填写')); content.append(row);
    }
  } catch (error) {
    if (request !== bottleDetailRequest) return;
    message.textContent = error.message; document.querySelector('#bottle-detail-retry').hidden = false;
  }
}
bottleDetails.addEventListener('close', () => { bottleDetailRequest++; cancelBottleHistory(); });
document.querySelector('#bottle-detail-retry').addEventListener('click', () => openBottleDetail(currentBottleId));
