const navButtons = [...document.querySelectorAll("[data-page]")];
const pageViews = [...document.querySelectorAll(".page-view")];
const pageTitle = document.querySelector("#page-title");
const sidebar = document.querySelector("#sidebar");
const sidebarScrim = document.querySelector("#sidebar-scrim");
const menuButton = document.querySelector("#menu-button");
const sidebarClose = document.querySelector("#sidebar-close");
const dialog = document.querySelector("#reagent-dialog");
const reagentForm = document.querySelector("#reagent-form");
const toast = document.querySelector("#toast");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function closeSidebar() {
  sidebar.classList.remove("is-open");
  sidebarScrim.classList.remove("is-visible");
  menuButton.setAttribute("aria-expanded", "false");
}

function openSidebar() {
  sidebar.classList.add("is-open");
  sidebarScrim.classList.add("is-visible");
  menuButton.setAttribute("aria-expanded", "true");
}

// Animate readable blocks only as they enter; native wheel scrolling stays unchanged.
const flowAnimations = new Map();
const flowStyle = getComputedStyle(document.documentElement);
const flowTiming = { duration: parseFloat(flowStyle.getPropertyValue("--dur-flow")), easing: flowStyle.getPropertyValue("--ease-flow").trim() };
const flowDistance = parseFloat(flowStyle.getPropertyValue("--motion-distance"));
function animateFlow(element, direction = 1) {
  if (reducedMotion.matches) return;
  flowAnimations.get(element)?.cancel();
  const animation = element.animate([
    { opacity: 0.35, transform: `translateY(${direction * flowDistance}px)` },
    { opacity: 1, transform: "translateY(0)" },
  ], flowTiming);
  flowAnimations.set(element, animation);
  // A suspended browser animation must never leave the content translucent.
  const deadline = window.setTimeout(() => animation.cancel(), flowTiming.duration + 100);
  const clear = () => {
    window.clearTimeout(deadline);
    if (flowAnimations.get(element) === animation) flowAnimations.delete(element);
  };
  animation.onfinish = clear;
  animation.oncancel = clear;
}
function cancelFlow() {
  flowAnimations.forEach(animation => animation.cancel());
  flowAnimations.clear();
}
const flowObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    const view = entry.target.closest(".page-view");
    if (entry.isIntersecting && !view.hidden && !flowAnimations.has(view)) {
      animateFlow(entry.target, entry.boundingClientRect.top < 0 ? -1 : 1);
    }
  });
}, { threshold: 0, rootMargin: "-100px 0px -24px 0px" });
document.querySelectorAll(".reveal-section, .usage-panel, .catalog-grid, .instrument-grid, .sample-list, .settings-grid, .toolbar-panel").forEach(element => flowObserver.observe(element));
reducedMotion.addEventListener("change", () => { if (reducedMotion.matches) cancelFlow(); });
animateFlow(document.querySelector(".page-view.is-active"));

function showPage(pageName, refreshCatalog = true) {
  const nextPage = document.querySelector(`#page-${pageName}`);
  if (!nextPage) return;
  if (!nextPage.hidden) { closeSidebar(); return; }
  cancelFlow();

  pageViews.forEach((view) => {
    const active = view === nextPage;
    view.hidden = !active;
    view.classList.toggle("is-active", active);
  });

  navButtons.forEach((button) => {
    const active = button.dataset.page === pageName;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });

  if (pageName === "reagents" && refreshCatalog) loadCatalog();
  if (["instruments", "samples"].includes(pageName)) loadCollection(pageName);
  if (pageName === "overview") loadEquipmentSummary();
  if (pageName === "settings") showSettingsHome();
  if (pageName === "history") loadHistory();
  if (pageName === "overview") { loadRecentUsage(); loadDashboard(); }
  pageTitle.textContent = nextPage.dataset.title;
  document.title = `${nextPage.dataset.title} · 燕园实验室`;
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "instant" : "smooth" });
  animateFlow(nextPage);
  closeSidebar();
}

navButtons.forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll("[data-go-page]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.goPage)));
menuButton.addEventListener("click", openSidebar);
sidebarClose.addEventListener("click", closeSidebar);
sidebarScrim.addEventListener("click", closeSidebar);

document.querySelectorAll("[data-open-dialog]").forEach((button) => {
  button.addEventListener("click", () => { document.querySelector("#reagent-error").textContent = ""; dialog.showModal(); });
});

dialog.addEventListener("click", (event) => {
  if (event.target === dialog && !reagentForm.querySelector('[type="submit"]').disabled) dialog.close();
});
dialog.addEventListener('cancel', event => {
  if (reagentForm.querySelector('[type="submit"]').disabled) event.preventDefault();
});

const reagentSearch = document.querySelector("#reagent-search");
const reagentEmpty = document.querySelector("#reagent-empty");
reagentSearch.addEventListener("input", () => { catalogPage = 1; loadCatalog(); });

const globalSearch = document.querySelector("#global-search");
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    globalSearch.parentElement.classList.add("is-open");
    globalSearch.focus();
  }
  if (event.key === "Escape") {
    closeSidebar();
    globalSearch.parentElement.classList.remove("is-open");
  }
});

globalSearch.addEventListener("input", () => {
  if (globalSearch.value.trim()) showPage("reagents", false);
  reagentSearch.value = globalSearch.value;
  reagentSearch.dispatchEvent(new Event("input"));
});

document.querySelector("#today-date").textContent = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric", weekday: "long" }).format(new Date());

// Persistent reagent profiles and stock summaries.
let sessionUser;
let catalogPage = 1, catalogRequest = 0, detailRequest = 0, detailId;
const catalog = document.querySelector('#reagent-catalog');
const listMessage = document.querySelector('#reagent-list-message');
const previousPage = document.querySelector('#reagent-prev');
const nextPage = document.querySelector('#reagent-next');
async function businessRequest(url, body, headers = {}, method) {
  if (body !== undefined && !await requireInformationWrite()) throw new Error(permissionMessage);
  const response = await fetch(url, {
    method: method || (body === undefined ? 'GET' : 'POST'), credentials: 'same-origin', cache: 'no-store',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => { throw new Error('无法连接服务，请重试。'); });
  const result = await response.json().catch(() => { throw new Error('服务返回异常，请重试。'); });
  if (response.status === 401) { window.location.replace('./login.html'); throw new Error('登录已失效。'); }
  if (!response.ok) { if (response.status === 403 && result.error?.code === 'FORBIDDEN') showPermissionDenied(); const error = new Error(result.error?.message || '操作失败，请重试。'); error.status = response.status; error.code = result.error?.code; throw error; }
  return result;
}
function reagentRequest(endpoint = '', body) { return businessRequest(`/api/v1/reagents${endpoint}`, body); }
function textElement(tag, text, className) {
  const element = document.createElement(tag); element.textContent = text;
  if (className) element.className = className;
  return element;
}
async function loadCatalog() {
  const request = ++catalogRequest;
  listMessage.textContent = '正在加载试剂档案…';
  catalog.replaceChildren(); reagentEmpty.hidden = true;
  document.querySelector('#reagent-retry').hidden = true;
  previousPage.disabled = nextPage.disabled = true;
  document.querySelector('#reagent-page-info').textContent = '';
  document.querySelector('#reagent-total').textContent = '正在加载档案…';
  try {
    const result = await reagentRequest(`?${new URLSearchParams({ q: reagentSearch.value.trim(), page: catalogPage, page_size: 12 })}`);
    if (request !== catalogRequest) return;
    listMessage.textContent = '';
    document.querySelector('#reagent-total').textContent = `真实档案 · ${result.total} 种试剂`;
    result.items.forEach(reagent => {
      const card = textElement('article', '', 'catalog-card');
      card.append(textElement('h3', reagent.name), textElement('p', `CAS ${reagent.cas || '未填写'} · ${reagent.grade || '未填写规格'}`));
      const dl = document.createElement('dl');
      for (const [label, value] of [['供应商', reagent.supplier || '未填写'], ['货号', reagent.catalog_no || '未填写'], ['分类', reagent.category || '未填写'], ['低库存阈值', `${reagent.low_stock_threshold} ${reagent.stock_unit}`]]) {
        const row = document.createElement('div'); row.append(textElement('dt', label), textElement('dd', value)); dl.append(row);
      }
      if (reagent.stock_summary) {
        const stock = reagent.stock_summary;
        const row = document.createElement('div'); row.append(textElement('dt', '在库 / 可领'), textElement('dd', `${stock.bottle_count} 瓶 / ${stock.available_quantity} ${stock.unit}`)); dl.append(row);
      }
      const button = textElement('button', '查看详情', 'card-link');
      button.addEventListener('click', () => openReagentDetail(reagent.id));
      const receipt = textElement('button', '登记单瓶入库', 'card-link');
      receipt.type = 'button'; receipt.dataset.openBottle = reagent.id; receipt.dataset.writeAction = '';
      receipt.addEventListener('click', () => openBottleForm(reagent));
      card.append(dl, button, receipt); catalog.append(card);
    });
    reagentEmpty.hidden = result.total > 0;
    reagentEmpty.textContent = reagentSearch.value.trim() ? '没有找到匹配的试剂。' : '暂无试剂档案。管理员可登记第一份档案。';
    const pages = Math.max(1, Math.ceil(result.total / result.page_size));
    document.querySelector('#reagent-page-info').textContent = `第 ${result.page} / ${pages} 页`;
    previousPage.disabled = result.page <= 1; nextPage.disabled = result.page >= pages;
  } catch (error) {
    if (request !== catalogRequest) return;
    listMessage.textContent = error.message;
    document.querySelector('#reagent-total').textContent = '档案加载失败';
    document.querySelector('#reagent-retry').hidden = false;
  }
}
previousPage.addEventListener('click', () => { catalogPage--; loadCatalog(); });
nextPage.addEventListener('click', () => { catalogPage++; loadCatalog(); });
document.querySelector('#reagent-retry').addEventListener('click', loadCatalog);
const detailDialog = document.querySelector('#reagent-detail-dialog');
async function openReagentDetail(id) {
  detailId = id;
  const request = ++detailRequest;
  const content = document.querySelector('#reagent-detail');
  const message = document.querySelector('#reagent-detail-message');
  content.replaceChildren(); message.textContent = '正在加载详情…';
  document.querySelector('#bottle-list').replaceChildren();
  document.querySelector('#bottle-list-message').textContent = '';
  document.querySelector('#detail-open-bottle').hidden = true;
  cancelBottleList();
  document.querySelector('#reagent-detail-title').textContent = '试剂档案';
  document.querySelector('#reagent-detail-retry').hidden = true;
  if (!detailDialog.open) detailDialog.showModal();
  try {
    const { reagent } = await reagentRequest(`/${encodeURIComponent(id)}`);
    if (request !== detailRequest) return;
    message.textContent = ''; document.querySelector('#reagent-detail-title').textContent = reagent.name;
    setDetailReagent(reagent);
    loadBottleList();
    for (const [label, key] of [['档案编号', 'id'], ['名称', 'name'], ['CAS 号', 'cas'], ['纯度 / 规格', 'grade'], ['供应商', 'supplier'], ['货号', 'catalog_no'], ['分类', 'category'], ['危险性标签', 'hazard_tags'], ['计量单位', 'stock_unit'], ['低库存阈值', 'low_stock_threshold'], ['创建时间', 'created_at'], ['更新时间', 'updated_at']]) {
      const row = document.createElement('div');
      const value = key.endsWith('_at') ? new Date(reagent[key]).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : reagent[key];
      row.append(textElement('dt', label), textElement('dd', value || '未填写')); content.append(row);
    }
    if (reagent.stock_summary) {
      const stock = reagent.stock_summary;
      const row = document.createElement('div'); row.append(textElement('dt', '在库 / 可领'), textElement('dd', `${stock.bottle_count} 瓶 / ${stock.available_quantity} ${stock.unit}`)); content.append(row);
    }
  } catch (error) {
    if (request !== detailRequest) return;
    message.textContent = error.message; document.querySelector('#reagent-detail-retry').hidden = false;
  }
}
detailDialog.addEventListener('close', () => { detailRequest++; cancelBottleList(); });
document.querySelector('#reagent-detail-retry').addEventListener('click', () => openReagentDetail(detailId));
document.querySelectorAll('[data-close-reagent]').forEach(button => button.addEventListener('click', () => dialog.close()));
reagentForm.addEventListener('submit', async event => {
  event.preventDefault();
  const button = reagentForm.querySelector('[type="submit"]');
  if (button.disabled) return;
  const errorMessage = document.querySelector('#reagent-error');
  const data = Object.fromEntries(new FormData(reagentForm));
  const controls = [...reagentForm.querySelectorAll('input, select, button')];
  controls.forEach(control => { control.disabled = true; });
  errorMessage.textContent = ''; button.textContent = '正在保存…';
  try {
    const { reagent } = await reagentRequest('', data);
    dialog.close(); reagentForm.reset();
    reagentSearch.value = ''; globalSearch.value = ''; catalogPage = 1;
    showPage('reagents', false); await loadCatalog(); await loadDashboard();
    toast.querySelector('span').textContent = `${reagent.name}已登记`;
    toast.classList.add('is-visible');
    window.setTimeout(() => toast.classList.remove('is-visible'), 2600);
  } catch (error) { errorMessage.textContent = error.message; errorMessage.focus(); }
  finally { controls.forEach(control => { control.disabled = false; }); button.textContent = '保存试剂'; }
});
window.addEventListener('lab-session', event => {
  sessionUser = event.detail;
});
loadCatalog();
