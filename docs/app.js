// EmoCara 網頁版畫面。資料整理和驗證在 core.js，存取在 store.js，Gemini 在 ai.js。
const Core = window.EmoCore, Store = window.EmoStore, AI = window.EmoAI;
const $ = (selector) => document.querySelector(selector);
let current = null, characters = [], selectedRelationshipId = null, draft = null, characterDirty = false, chatTurns = [], pendingChat = null;
const presets = Object.entries(Core.PRESET_MODULES).filter(([type]) => type !== "custom").map(([type, name]) => ({ type, name, guide: Core.MODULE_GUIDES[type] || "" }));
const clone = Core.clone;

const toast = (message, error = false) => { const el = $("#toast"); el.textContent = message; el.style.background = error ? "#904645" : "#213b3d"; el.classList.add("show"); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => el.classList.remove("show"), 3200); };
const parseObject = (text, label) => { try { const value = JSON.parse(text || "{}"); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; } catch { throw new Error(`${label} 必須是有效的 JSON 物件。`); } };
const numberOr = (value, fallback) => value === "" ? fallback : Number(value);
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char])); }
function setFormValue(form, name, value) { form.elements[name].value = value ?? ""; }
const formatTime = (value) => value ? new Date(value).toLocaleString("zh-TW") : "";

// ---------- 角色清單 ----------
function refreshList() { characters = Store.listCharacters(); renderList(); }
function renderList() {
  const container = $("#character-list"); container.innerHTML = "";
  characters.forEach((item) => {
    const button = document.createElement("button");
    button.className = `character-item ${current?.character_id === item.id ? "active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(item.name)}</strong><small>最後修改 ${escapeHtml(formatTime(item.updated_at))}</small>`;
    button.onclick = () => loadCharacter(item.id);
    container.append(button);
  });
}
function loadCharacter(id) {
  if (characterDirty && current?.character_id !== id && !confirm("角色頁有還沒儲存的修改，確定要離開嗎？")) return;
  const doc = Store.getCharacter(id);
  if (!doc) { toast("找不到這名角色。", true); refreshList(); return; }
  try { current = Core.normalize(doc); } catch (error) { toast(`這名角色的資料有問題：${error.message}`, true); return; }
  buildDraft();
  selectedRelationshipId = current.relationships.find((item) => item?.relationship_id)?.relationship_id || null;
  resetPendingChat(); viewingChatId = null; refreshChatTurns();
  $("#empty-state").hidden = true; $("#editor").hidden = false; render();
}
function render() {
  if (!current) return;
  $("#character-title").textContent = current.profile.name || "未命名角色";
  $("#save-status").textContent = `已存在這台裝置 · ${formatTime(current.metadata.updated_at)}`;
  if (!characterDirty) renderCharacterForm();
  renderMemorySettings(); renderState(); renderRelationships(); renderChat(); renderObserver(); renderProposals();
  $("#json-preview").textContent = JSON.stringify(current, null, 2);
  renderList();
}
// 改角色資料的共同入口：先整理、驗證，通過才存。
function persist(change, message) {
  try {
    const updated = Core.normalize(change(clone(current)));
    current = Store.saveCharacter(updated);
    refreshList(); render(); if (message) toast(message);
    return true;
  } catch (error) { toast(error.message, true); return false; }
}

// ---------- 角色頁：基本資料＋模組文字框 ----------
// 改到一半的內容放在 draft，按「儲存角色」才整份存回去。
function buildDraft() {
  draft = { modules: [] }; const used = new Set();
  presets.forEach((preset) => {
    const matches = current.modules.filter((module) => module.type === preset.type);
    if (matches.length) matches.forEach((module) => { draft.modules.push(clone(module)); used.add(module.module_id); });
    else draft.modules.push({ type: preset.type, name: preset.name, enabled: true, text: "", data: {}, notes: "", placeholder: true });
  });
  current.modules.filter((module) => !used.has(module.module_id)).forEach((module) => draft.modules.push(clone(module)));
  setDirty(false);
}
function setDirty(value) { characterDirty = value; $("#character-dirty").textContent = value ? "有還沒儲存的修改" : ""; }
function renderCharacterForm() {
  const form = $("#character-form"), p = current.profile;
  setFormValue(form, "name", p.name); setFormValue(form, "aliases", (p.aliases || []).join(", "));
  ["age", "gender", "pronouns", "occupation", "background", "appearance", "current_situation"].forEach((key) => setFormValue(form, key, p[key]));
  setFormValue(form, "other_information", JSON.stringify(p.other_information || {}, null, 2));
  renderModuleCards();
}
function renderModuleCards() {
  const cards = $("#module-cards"); cards.innerHTML = "";
  draft.modules.forEach((module, index) => {
    const preset = presets.find((item) => item.type === module.type);
    const card = document.createElement("article"); card.className = `module-card ${module.enabled ? "" : "off"}`;
    const head = document.createElement("div"); head.className = "module-card-head";
    let title;
    if (preset) { title = document.createElement("strong"); title.textContent = module.name; }
    else { title = document.createElement("input"); title.className = "module-name-input"; title.value = module.name; title.setAttribute("aria-label", "模組名稱"); title.oninput = () => { module.name = title.value; }; }
    const toggle = document.createElement("label"); toggle.className = "toggle";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = module.enabled;
    checkbox.onchange = () => { module.enabled = checkbox.checked; card.classList.toggle("off", !checkbox.checked); };
    toggle.append(checkbox, document.createTextNode(" 開著"));
    head.append(title, toggle);
    if (!preset) {
      const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-module"; remove.textContent = "刪除";
      remove.onclick = () => { if ((module.text || "").trim() && !confirm(`確定要刪除「${module.name}」嗎？按「儲存角色」之後才會真的刪掉。`)) return; draft.modules.splice(index, 1); setDirty(true); renderModuleCards(); };
      head.append(remove);
    }
    const guide = document.createElement("p"); guide.className = "module-guide"; guide.textContent = preset?.guide || Core.MODULE_GUIDES.custom;
    const text = document.createElement("textarea"); text.rows = module.type === "free" ? 6 : 3; text.value = module.text || ""; text.setAttribute("aria-label", module.name);
    text.oninput = () => { module.text = text.value; };
    card.append(head, guide, text);
    if (module.data && Object.keys(module.data).length) { const legacy = document.createElement("p"); legacy.className = "module-legacy"; legacy.textContent = "這個模組還有舊格式的內容，原封不動保留著，可以在「進階 → 完整資料」看到。"; card.append(legacy); }
    cards.append(card);
  });
}
function addCustomModule() {
  const name = prompt("新模組要叫什麼名字？", "自訂模組"); if (name === null) return;
  draft.modules.push({ type: "custom", name: name.trim() || "自訂模組", enabled: true, text: "", data: {}, notes: "" });
  setDirty(true); renderModuleCards(); $("#module-cards").lastElementChild?.querySelector("textarea")?.focus();
}
function saveCharacter(event) {
  event.preventDefault();
  try {
    const form = $("#character-form");
    const profile = { ...current.profile, name: form.name.value.trim() || "未命名角色", aliases: form.aliases.value.split(",").map((x) => x.trim()).filter(Boolean), age: form.age.value.trim() || null, gender: form.gender.value.trim() || null, pronouns: form.pronouns.value.trim() || null, occupation: form.occupation.value.trim(), background: form.background.value, appearance: form.appearance.value, current_situation: form.current_situation.value, other_information: parseObject(form.other_information.value, "其他設定") };
    // 沒寫東西的預設格子不存；有寫的才變成正式模組。
    const modules = draft.modules.filter((module) => !(module.placeholder && !(module.text || "").trim())).map(({ placeholder, ...module }) => ({ ...module, name: (module.name || "").trim() || "未命名模組" }));
    const wasDirty = characterDirty; setDirty(false);
    if (persist((doc) => ({ ...doc, profile, modules }), "角色已儲存")) { buildDraft(); renderCharacterForm(); }
    else setDirty(wasDirty);
  } catch (error) { toast(error.message, true); }
}

// ---------- 進階：數值、關係、記憶容量 ----------
function renderMemorySettings() { const limits = $("#memory-settings-form"), settings = current.memory_settings || {}; ["core", "important", "ordinary"].forEach((tier) => { setFormValue(limits, `${tier}_max_items`, settings[tier]?.max_items); setFormValue(limits, `${tier}_max_chars`, settings[tier]?.max_chars); }); }
function renderState() { const form = $("#state-form"), s = current.state; setFormValue(form, "valence", s.mood?.valence); setFormValue(form, "arousal", s.mood?.arousal); ["security", "anxiety", "loneliness", "emotional_stability"].forEach((key) => setFormValue(form, key, s.psychological?.[key])); setFormValue(form, "emotions", JSON.stringify(s.emotions || {}, null, 2)); setFormValue(form, "custom_metrics", JSON.stringify(s.custom_metrics || {}, null, 2)); }
function saveState(event) {
  event.preventDefault();
  try {
    const form = event.currentTarget;
    const state = { mood: { valence: numberOr(form.valence.value, 0), arousal: numberOr(form.arousal.value, 30) }, psychological: { security: numberOr(form.security.value, 50), anxiety: numberOr(form.anxiety.value, 30), loneliness: numberOr(form.loneliness.value, 30), emotional_stability: numberOr(form.emotional_stability.value, 50) }, emotions: parseObject(form.emotions.value, "目前情緒"), custom_metrics: parseObject(form.custom_metrics.value, "自訂指標") };
    persist((doc) => { Object.assign(doc.state, state); return doc; }, "心理數值已儲存");
  } catch (error) { toast(error.message, true); }
}
function saveMemorySettings(event) {
  event.preventDefault();
  const form = event.currentTarget; const number = (name) => Number(form.elements[name].value);
  const settings = { core: { max_items: number("core_max_items"), max_chars: number("core_max_chars") }, important: { max_items: number("important_max_items"), max_chars: number("important_max_chars") }, ordinary: { max_items: number("ordinary_max_items"), max_chars: number("ordinary_max_chars") } };
  persist((doc) => ({ ...doc, memory_settings: settings }), "記憶容量已儲存；既有記憶沒有被修改");
}
function renderRelationships() {
  const list = $("#relationship-list"); list.innerHTML = "";
  const relationships = current.relationships.filter((item) => item?.relationship_id);
  relationships.forEach((relationship) => {
    const button = document.createElement("button"); button.type = "button"; button.className = relationship.relationship_id === selectedRelationshipId ? "active" : "";
    const d = relationship.dimensions || {};
    button.innerHTML = `<strong>${escapeHtml(relationship.target_name)}</strong><small>信任 ${escapeHtml(d.trust ?? "—")} · 親密 ${escapeHtml(d.intimacy ?? "—")}</small>`;
    button.onclick = () => { selectedRelationshipId = relationship.relationship_id; renderRelationships(); };
    list.append(button);
  });
  const relationship = relationships.find((item) => item.relationship_id === selectedRelationshipId);
  const editor = $("#relationship-editor");
  if (!relationship) { editor.className = "module-editor empty-module"; editor.textContent = current.relationships.length ? "舊格式關係資料保留在完整資料中；請新增一筆關係以使用正式維度。" : "選取左側關係，開始編輯它的維度。"; return; }
  const d = relationship.dimensions; editor.className = "module-editor";
  editor.innerHTML = `<form id="relationship-editor-form" class="module-editor-form"><div class="module-top"><label class="field">對象名稱<input name="target_name" value="${escapeHtml(relationship.target_name)}" /></label><label class="field">對象類型<input name="target_type" value="${escapeHtml(relationship.target_type)}" /></label></div><div class="form-grid metrics"><label class="field">信任<input name="trust" type="number" min="0" max="100" value="${escapeHtml(d.trust)}" /></label><label class="field">親密<input name="intimacy" type="number" min="0" max="100" value="${escapeHtml(d.intimacy)}" /></label><label class="field">安全感<input name="safety" type="number" min="0" max="100" value="${escapeHtml(d.safety)}" /></label><label class="field">依賴<input name="dependence" type="number" min="0" max="100" value="${escapeHtml(d.dependence)}" /></label><label class="field">戒心<input name="wariness" type="number" min="0" max="100" value="${escapeHtml(d.wariness)}" /></label></div><label class="field">備註<textarea name="notes" rows="4">${escapeHtml(relationship.notes || "")}</textarea></label><div class="module-actions"><button type="button" id="remove-relationship" class="delete-module">刪除關係</button><button class="primary">儲存關係</button></div></form>`;
  $("#relationship-editor-form").onsubmit = saveRelationship; $("#remove-relationship").onclick = removeRelationship;
}
function addRelationship() {
  const targetName = prompt("這段關係的對象是誰？", "未命名對象"); if (targetName === null) return;
  const relationship = Core.newRelationship(targetName);
  if (persist((doc) => { doc.relationships.push(relationship); return doc; }, "關係已新增")) { selectedRelationshipId = relationship.relationship_id; renderRelationships(); }
}
function saveRelationship(event) {
  event.preventDefault();
  try {
    const form = event.currentTarget; const number = (name) => Number(form.elements[name].value);
    const validated = Core.validateRelationship({ target_name: form.target_name.value.trim(), target_type: form.target_type.value.trim(), dimensions: { trust: number("trust"), intimacy: number("intimacy"), safety: number("safety"), dependence: number("dependence"), wariness: number("wariness") }, notes: form.notes.value }, selectedRelationshipId);
    persist((doc) => { doc.relationships = doc.relationships.map((item) => item?.relationship_id === selectedRelationshipId ? { ...validated, created_at: item.created_at || validated.updated_at } : item); return doc; }, "關係已儲存");
  } catch (error) { toast(error.message, true); }
}
function removeRelationship() {
  if (!confirm("確定要刪除這段關係嗎？此操作無法復原。")) return;
  const id = selectedRelationshipId;
  if (persist((doc) => { doc.relationships = doc.relationships.filter((item) => item?.relationship_id !== id); return doc; }, "關係已刪除")) {
    selectedRelationshipId = current.relationships.find((item) => item?.relationship_id)?.relationship_id || null; renderRelationships();
  }
}

// ---------- 建立、刪除、匯入、匯出 ----------
function createCharacter() {
  if (characterDirty && !confirm("角色頁有還沒儲存的修改，確定要離開嗎？")) return;
  const name = prompt("這名角色叫什麼名字？", "未命名角色"); if (name === null) return;
  try { const created = Store.saveCharacter(Core.newCharacter(name)); setDirty(false); refreshList(); loadCharacter(created.character_id); showTab("character"); toast("角色已建立"); }
  catch (error) { toast(error.message, true); }
}
function deleteCharacter() {
  if (!current || !confirm(`確定要刪除「${current.profile.name}」嗎？角色和所有對話都會刪掉，無法復原。\n\n如果還想留著，可以先按「匯出備份」。`)) return;
  Store.deleteCharacter(current.character_id); current = null; setDirty(false); refreshList();
  $("#editor").hidden = true; $("#empty-state").hidden = false; toast("角色已刪除");
}
// 匯出的檔案 = 角色資料＋對話紀錄，帶到別台裝置匯入就能接著玩。
function exportCurrent() {
  if (!current) return;
  if (characterDirty && !confirm("角色頁有還沒儲存的修改，匯出的檔案不會包含它們。要繼續匯出嗎？")) return;
  const payload = { ...clone(current), chat_turns: Store.allTurns(current.character_id) };
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = `${current.profile.name || "character"}_${stamp}.json`; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("已匯出。到另一台裝置按「匯入角色」選這個檔案就能接著玩。");
}
async function importFile(event) {
  const file = event.target.files[0]; if (!file) return;
  try {
    const text = await file.text();
    // 不是 { 開頭的就當作角卡（純文字）。
    if (!text.trim().startsWith("{")) { importCardText(text); return; }
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("檔案內容不是角色資料。");
    const turns = Array.isArray(data.chat_turns) ? data.chat_turns : null; delete data.chat_turns;
    let imported = Core.normalize(data);
    const existing = Store.getCharacter(imported.character_id);
    if (existing) {
      const fileTime = imported.metadata.updated_at, hereTime = existing.metadata?.updated_at;
      const older = fileTime && hereTime && fileTime < hereTime;
      const message = `這台裝置已經有「${existing.profile?.name || "這名角色"}」了。\n\n檔案裡的版本：${formatTime(fileTime)}\n這台裝置的版本：${formatTime(hereTime)}\n` + (older ? "\n注意：檔案裡的版本比較舊！\n" : "") + "\n按「確定」：用檔案蓋掉這台裝置上的版本。\n按「取消」：另外存成一個新角色，兩份都留著。";
      if (!confirm(message)) imported = Core.normalize(imported, { generateId: true });
    }
    imported.metadata.import_source = "json_import";
    Store.saveCharacter(imported, { keepTime: true });
    if (turns) Store.replaceTurns(imported.character_id, turns);
    else if (!existing || existing.character_id !== imported.character_id) Store.replaceTurns(imported.character_id, []);
    setDirty(false); refreshList(); loadCharacter(imported.character_id); toast("角色已匯入");
  } catch (error) { toast(error instanceof SyntaxError ? "檔案不是有效的 JSON。" : error.message, true); }
  finally { event.target.value = ""; }
}

// ---------- 角卡：空白格式（複製、下載），填好的貼回來或用檔案匯入，一律變新角色 ----------
function openCardDialog() {
  const template = Core.cardTemplate(); $("#card-template").value = template; $("#card-paste").value = "";
  $("#card-dialog").showModal();
  copyText(template, "空白角卡已經複製好了", "瀏覽器不讓網頁直接複製，請在上面的框裡全選後複製，或按「下載成檔案」。");
}
function downloadCard() {
  const blob = new Blob([Core.cardTemplate()], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = "EmoCara角卡.txt"; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function importCardText(text) {
  if (characterDirty && !confirm("角色頁有還沒儲存的修改，確定要離開嗎？")) return false;
  const created = Store.saveCharacter(Core.parseCard(text)); Store.replaceTurns(created.character_id, []);
  setDirty(false); refreshList(); loadCharacter(created.character_id); showTab("character");
  toast(`「${created.profile.name}」匯入好了，是一個新角色`);
  return true;
}
function importCardFromDialog() {
  try { if (importCardText($("#card-paste").value)) $("#card-dialog").close(); }
  catch (error) { toast(error.message, true); }
}

// ---------- 設定（Gemini 鑰匙只存在這台裝置） ----------
function openSettings() { const s = Store.getSettings(), form = $("#settings-form"); form.gemini_api_key.value = s.gemini_api_key || ""; form.gemini_model.value = s.gemini_model || ""; form.phone_zoom.value = s.phone_zoom === "page" ? "page" : "fullscreen"; $("#settings-dialog").showModal(); }
function saveSettings(event) {
  if (event.submitter?.value === "cancel") return;
  const form = $("#settings-form");
  try { Store.saveSettings({ ...Store.getSettings(), gemini_api_key: form.gemini_api_key.value.trim(), gemini_model: form.gemini_model.value.trim(), phone_zoom: form.phone_zoom.value }); renderChat(); toast("設定已存在這台裝置"); }
  catch (error) { toast(error.message, true); }
}

// ---------- 觀察者 ----------
function renderObserver() {
  if (!current) return;
  const allTurns = Store.allTurns(current.character_id), summary = Core.chatSummary(allTurns, viewedChatId());
  const carried = !summary && !viewingOldChat() ? Core.summaryForPrompt(current, allTurns) : null;
  $("#observer-summary").textContent = summary || (carried ? `（這段聊天還沒有自己的摘要，他帶著上一段聊天結束時記得的經過）\n${carried.text}` : "還沒有摘要。聊幾句之後，AI 會開始寫他記得的最近經過。");
  $("#observer-summary").classList.toggle("observer-empty", !summary);
  // 他現在：最新的心情和對你的感覺（用文字）。
  const latest = [...allTurns].reverse().find((turn) => turn.mood_now || turn.feeling_toward_user);
  const now = $("#observer-now"); now.innerHTML = "";
  const feeling = Core.latestFeeling(allTurns);
  if (!latest && !feeling) now.append(el("p", "observer-empty", "還沒有紀錄。聊幾句之後，這裡會寫他現在的心情，和他對你的感覺。"));
  else {
    if (latest?.mood_now) now.append(el("p", "now-line", `心情：${latest.mood_now}`));
    if (feeling) now.append(el("p", "now-line", `對你的感覺：${feeling}`));
  }
  $("#observer-now-time").textContent = latest ? `${formatTime(latest.created_at)} 那句之後` : "";
  const timeline = $("#observer-inner"); timeline.innerHTML = "";
  if (!chatTurns.length) timeline.append(el("p", "observer-empty", "還沒有對話。"));
  [...chatTurns].reverse().forEach((turn) => {
    const card = el("article", "observer-thought");
    card.append(el("small", "", formatTime(turn.created_at)));
    card.append(el("p", "thought-said", `你：${turn.user_message}`));
    if (turn.scene) card.append(el("p", "thought-scene", `畫面：${turn.scene}`));
    card.append(el("p", "thought-said", `他說：${turn.character_reply}`));
    card.append(el("p", "thought-inner", turn.inner_thought === undefined ? "（這句沒有記錄內心）" : (turn.inner_thought ? `心裡：${turn.inner_thought}` : "心裡：沒有特別的想法")));
    const mood = turn.mood_now || turn.state_proposal?.summary;
    if (mood) card.append(el("p", "thought-mood", `心情：${mood}`));
    if (turn.feeling_toward_user) card.append(el("p", "thought-mood", `對你的感覺：${turn.feeling_toward_user}`));
    timeline.append(card);
  });
  const state = $("#observer-state"); state.innerHTML = "";
  const metrics = [["情緒效價", current.state.mood?.valence], ["喚起程度", current.state.mood?.arousal], ["安全感", current.state.psychological?.security], ["焦慮", current.state.psychological?.anxiety], ["孤獨感", current.state.psychological?.loneliness], ["情緒穩定度", current.state.psychological?.emotional_stability]];
  metrics.forEach(([label, value]) => { const card = document.createElement("div"); card.className = "observer-metric"; const title = document.createElement("small"); title.textContent = label; const number = document.createElement("strong"); number.textContent = value ?? "—"; card.append(title, number); state.append(card); });
  const memories = Array.isArray(current.memories) ? current.memories : []; $("#observer-memory-count").textContent = memories.length;
  const container = $("#observer-memories"); container.innerHTML = "";
  if (!memories.length) { const empty = document.createElement("p"); empty.className = "observer-empty"; empty.textContent = "尚未確認保存任何記憶。"; container.append(empty); }
  else {
    [["core", "核心記憶"], ["important", "重要記憶"], ["ordinary", "普通記憶"], ["other", "未分類／舊格式記憶"]].forEach(([kind, label]) => {
      const items = memories.filter((item) => kind === "other" ? !Core.MEMORY_IMPORTANCE.includes(item?.importance) : item?.importance === kind); if (!items.length) return;
      const section = document.createElement("section"); section.className = "memory-group";
      const heading = document.createElement("h4"); const limits = current.memory_settings?.[kind];
      heading.textContent = limits ? `${label} · ${items.length} / ${limits.max_items} 筆 · 每筆 ${limits.max_chars} 字元` : `${label} · ${items.length}`; section.append(heading);
      items.forEach((item) => { const card = document.createElement("article"); card.className = "observer-memory"; const summary = document.createElement("strong"); summary.textContent = typeof item?.summary === "string" ? item.summary : JSON.stringify(item); card.append(summary); if (item?.reason) { const reason = document.createElement("p"); reason.textContent = item.reason; card.append(reason); } section.append(card); });
      container.append(section);
    });
  }
  const formal = (current.relationships || []).filter((item) => item?.relationship_id && item?.dimensions);
  $("#observer-relationships").textContent = formal.length ? `目前有 ${formal.length} 筆正式關係資料。` : "尚未建立正式關係資料；可到「角色 → 進階」新增。";
  const list = $("#observer-relationship-list"); list.innerHTML = "";
  formal.forEach((relationship) => { const card = document.createElement("article"); card.className = "observer-relationship"; const name = document.createElement("strong"); name.textContent = relationship.target_name; const d = relationship.dimensions; const p = document.createElement("p"); p.textContent = `信任 ${d.trust} · 親密 ${d.intimacy} · 安全感 ${d.safety} · 依賴 ${d.dependence} · 戒心 ${d.wariness}`; card.append(name, p); list.append(card); });
}

// ---------- 聊天 ----------
// 一句話的流程：送出 → 等回覆（pendingMessage）→ 回覆通過檢查就直接存；反悔用最新那句的「取消」。
let pendingMessage = null, waitingReply = false, waitingNote = "", geminiFailure = null, scrollChatToEnd = true, viewingChatId = null, openRewind = null;
function viewedChatId() { return viewingChatId || Core.currentChatId(current); }
function viewingOldChat() { return Boolean(current && viewingChatId && viewingChatId !== Core.currentChatId(current)); }
function refreshChatTurns() { chatTurns = current ? Core.turnsInChat(Store.allTurns(current.character_id), viewedChatId()).slice(-30) : []; }
// 泡泡上的時間：今天只寫幾點，今年寫月日，更早的寫年。
function shortTime(iso) {
  const d = new Date(iso); if (!iso || Number.isNaN(d.getTime())) return "";
  const now = new Date(), hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  return d.getFullYear() === now.getFullYear() ? `${d.getMonth() + 1}/${d.getDate()} ${hm}` : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
function resetPendingChat() { geminiFailure = null; waitingNote = ""; openPeeks.delete("pending"); openRewind = null; openCancel = null; pendingChat = null; pendingMessage = null; waitingReply = false; }
function geminiSettings() { const s = Store.getSettings(); return { apiKey: s.gemini_api_key || "", model: s.gemini_model || AI.DEFAULT_GEMINI_MODEL }; }
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function bubble(side, text, extraClass = "") { const row = el("div", `chat-row ${side} ${extraClass}`.trim()); row.append(el("div", "chat-bubble", text)); return row; }
// 偷看：他說的話底下藏著心裡的話、心情、想記住的事，點了才展開。
const openPeeks = new Set();
// 偷看只看心裡話；心情、記憶放在觀察者分頁，免得出戲。
function peekToggle(key) {
  const button = el("button", "peek-button", openPeeks.has(key) ? "收起" : "偷看"); button.type = "button";
  button.onclick = () => { openPeeks.has(key) ? openPeeks.delete(key) : openPeeks.add(key); const history = $("#chat-history"), top = history.scrollTop; scrollChatToEnd = false; renderChat(); history.scrollTop = top; };
  return button;
}
function innerLines(inner) {
  const box = el("div", "chat-peek-body");
  box.append(el("p", "chat-inner", inner === undefined ? "這句沒有記錄內心。" : (inner ? inner : "心裡沒有特別的想法。")));
  return box;
}
let openCancel = null;
function savedTurnPeek(turn, latest) {
  const key = turn.id || turn.created_at, wrap = el("div", "chat-peek");
  const bar = el("div", "chat-under"); bar.append(el("span", "chat-time", shortTime(turn.created_at)), peekToggle(key));
  wrap.append(bar);
  if (openPeeks.has(key)) wrap.append(innerLines(turn.inner_thought));
  return wrap;
}
function renderChat() {
  if (!current) return;
  const name = current.profile.name || "他";
  $("#chat-title").textContent = `跟 ${name} 聊天`;
  const history = $("#chat-history"); history.innerHTML = "";
  if (!chatTurns.length && (!pendingMessage || viewingOldChat())) history.append(el("p", "chat-empty", `還沒有對話。在下面打字，跟 ${name} 說說話吧。`));
  const allTurns = Store.allTurns(current.character_id);
  chatTurns.forEach((turn) => {
    const mine = bubble("me", turn.user_message, "tappable"); mine.firstChild.title = "點一下：從這句重來";
    mine.firstChild.onclick = () => tapMyBubble(turn, allTurns);
    if (openRewind === turn.id) { const again = el("button", "rewind-button", "↺ 從這句重來"); again.type = "button"; again.onclick = () => rewindFrom(turn.id); mine.append(again); }
    history.append(mine);
    const latest = !viewingOldChat() && !pendingMessage && turn === chatTurns[chatTurns.length - 1];
    if (turn.scene) history.append(el("p", "chat-scene", turn.scene));
    const row = bubble("them", turn.character_reply, latest ? "latest" : "");
    // 他最新那句：跟你的泡泡一樣，點一下才出現「取消這句」。
    if (latest) {
      row.firstChild.title = "點一下：取消這句";
      row.firstChild.onclick = () => { openCancel = openCancel === turn.id ? null : turn.id; openRewind = null; keepScrollRender(); };
      if (openCancel === turn.id) { const cancel = el("button", "rewind-button", "✕ 取消這句"); cancel.type = "button"; cancel.onclick = () => rewindFrom(turn.id, { quiet: true }); row.append(cancel); }
    }
    row.append(savedTurnPeek(turn, latest));
    history.append(row);
  });
  const old = viewingOldChat();
  if (pendingMessage && !old) history.append(bubble("me", pendingMessage, "pending"));
  if (waitingReply && !old) history.append(bubble("them", waitingNote || "……", "typing"));
  if (geminiFailure && pendingMessage && !old) {
    const box = el("div", "gemini-failed"); box.append(el("p", "", geminiFailure));
    const actions = el("div", "chat-confirm-actions");
    const cancel = el("button", "secondary small-button", "取消這句"); cancel.type = "button"; cancel.onclick = discardPendingChat;
    const manualButton = el("button", "primary small-button", "改用手動"); manualButton.type = "button"; manualButton.onclick = switchToManual;
    actions.append(cancel, manualButton); box.append(actions); history.append(box);
  }
  if (scrollChatToEnd) history.scrollTop = history.scrollHeight;
  scrollChatToEnd = true;
  const manual = $("#chat-mode").value === "manual", ready = Boolean(geminiSettings().apiKey);
  $("#manual-chat-workflow").hidden = old || !(manual && pendingMessage && !pendingChat);
  $("#chat-form").hidden = old; $(".chat-mode-row").hidden = old; $("#old-chat-banner").hidden = !old;
  $("#real-time-toggle").checked = current.chat_settings?.real_time === true;
  $("#proposal-toggle").checked = current.chat_settings?.proposals !== false;
  $("#video-toggle").checked = current.chat_settings?.video !== false;
  renderChatSelect();
  $("#model-status").textContent = manual ? "手動模式：不連網" : (ready ? "自動模式：Gemini" : "還沒在「設定」填 Gemini 鑰匙");
  $("#model-status").classList.toggle("ready", manual || ready);
  $("#chat-generate").disabled = waitingReply;
}
function chatPrompt(userMessage, manual = false) {
  const all = Store.allTurns(current.character_id);
  return Core.buildChatPrompt(current, Core.turnsInChat(all, Core.currentChatId(current)).slice(-12), userMessage, { summary: Core.summaryForPrompt(current, all), manual, feeling: Core.latestFeeling(all) });
}
// Gemini 失敗時：剛剛那句直接換成手動流程，不用重打。
function fillManualPrompt() { $("#paste-help").hidden = true; $("#manual-chat-prompt").value = chatPrompt(pendingMessage, true); $("#manual-chat-response").value = ""; }
function switchToManual() {
  if (!pendingMessage) return;
  $("#chat-mode").value = "manual"; geminiFailure = null; fillManualPrompt(); renderChat();
  toast("換成手動了：按「複製提示詞」，貼給網頁上的 AI。");
}
function changeChatMode() {
  if ($("#chat-mode").value === "manual" && pendingMessage && !pendingChat && !waitingReply) { geminiFailure = null; fillManualPrompt(); }
  renderChat();
}
function renderChatSelect() {
  const select = $("#chat-select"), chats = current.chats || [];
  select.hidden = chats.length < 2; select.innerHTML = "";
  chats.forEach((chat, index) => {
    const option = el("option", "", index === chats.length - 1 ? "目前的聊天" : `舊聊天 ${index + 1}（${shortTime(chat.started_at)} 開始）`);
    option.value = chat.chat_id; select.append(option);
  });
  select.value = viewedChatId();
}
function switchChat() { const value = $("#chat-select").value; viewingChatId = value === Core.currentChatId(current) ? null : value; openRewind = null; refreshChatTurns(); renderChat(); renderObserver(); }

// ---------- 回溯：從這句重來 ----------
function tapMyBubble(turn, allTurns) {
  if (viewingOldChat()) { toast("舊的聊天只能看，不能從這句重來。", true); return; }
  if (!Core.rewindKind(current, allTurns, turn.id)) { toast(`只有最近 ${Core.REWIND_LIMIT} 句能從那句重來，這句太早了。`, true); return; }
  openRewind = openRewind === turn.id ? null : turn.id; openCancel = null;
  keepScrollRender();
}
function keepScrollRender() { const history = $("#chat-history"), top = history.scrollTop; scrollChatToEnd = false; renderChat(); history.scrollTop = top; }
// quiet：最新那句的「取消」，只退一句時跳短一點的警告。
function rewindFrom(turnId, { quiet = false } = {}) {
  try {
    const result = Core.rewind(current, Store.allTurns(current.character_id), turnId);
    const lines = [`從「${result.message.slice(0, 30)}${result.message.length > 30 ? "……" : ""}」這句重來？`, "",
      `・這句和後面的對話（共 ${result.removed} 句）會消失，找不回來。`];
    if (result.kind === "full") lines.push("・他的心情、記住的事、心裡的話，會退回你講這句之前。");
    else lines.push("・注意：這句是更新前的舊對話，沒有存當時他的樣子。對話會消失，但他現在的心情和記住的事退不回去，會維持現在的樣子。");
    lines.push("・你這句話會放回輸入框，可以改一改重講。");
    if (result.removedProposals) lines.push(`・這幾句帶出、你還沒處理的 ${result.removedProposals} 筆設定提議會一起拿掉（已經同意的不會退回去）。`);
    if (pendingMessage) lines.push("・還在等回覆的那句也會一起丟掉。");
    lines.push("", "確定要重來嗎？");
    const short = quiet && result.kind === "full" && result.removed === 1 && !pendingMessage;
    const proposalLine = result.removedProposals ? `\n・這句帶出的 ${result.removedProposals} 筆設定提議會一起拿掉。` : "";
    const warning = short ? `取消這句？\n\n・他這句回覆會消失，找不回來。\n・他的心情、記住的事、心裡話、摘要，會退回你講這句之前。${proposalLine}\n・你的話會放回輸入框。\n\n確定要取消嗎？` : lines.join("\n");
    if (!confirm(warning)) return;
    current = Store.saveTurnsAndCharacter(Core.normalize(result.character), result.turns);
    resetPendingChat(); $("#manual-chat-prompt").value = ""; $("#manual-chat-response").value = "";
    $("#chat-message").value = result.message; growComposer();
    refreshChatTurns(); refreshList(); render(); toast(short ? "這句取消了，你的話放回輸入框" : "已經回到那句之前");
  } catch (error) { toast(error.message, true); }
}

// ---------- 現實時間開關 ----------
function relativeTime(iso) {
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 60) return `${Math.max(minutes, 1)} 分鐘前`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)} 小時前`;
  return `${Math.round(minutes / 60 / 24)} 天前`;
}
function toggleRealTime() {
  const box = $("#real-time-toggle");
  if (!box.checked) {
    if (!confirm("關掉現實時間？\n\n・他會不再知道現在幾點、隔了多久，之後的對話時間不流動。\n・泡泡上的時間照樣會記錄，給你看。\n\n確定要關掉嗎？")) { box.checked = true; return; }
    persist((doc) => ({ ...doc, chat_settings: { ...doc.chat_settings, real_time: false } }), "現實時間關掉了");
    return;
  }
  const last = Core.turnsInChat(Store.allTurns(current.character_id), Core.currentChatId(current)).slice(-1)[0];
  if (!last) { persist((doc) => ({ ...doc, chat_settings: { ...doc.chat_settings, real_time: true, time_since: null } }), "現實時間打開了：他會知道現在幾點"); return; }
  box.checked = false;
  $("#time-dialog-text").textContent = `上一句是 ${Core.describeTime(last.created_at)} 講的（${relativeTime(last.created_at)}）。對他來說，上一句要算什麼時候？`;
  $("#time-dialog-real").textContent = `他會知道上一句是 ${relativeTime(last.created_at)}，可能會對隔了多久有反應。`;
  const dialog = $("#time-dialog"); dialog.returnValue = "cancel";
  dialog.onclose = () => {
    if (dialog.returnValue === "now") persist((doc) => ({ ...doc, chat_settings: { ...doc.chat_settings, real_time: true, time_since: Core.timestamp() } }), "現實時間打開了：之前的對話算剛剛");
    else if (dialog.returnValue === "real") persist((doc) => ({ ...doc, chat_settings: { ...doc.chat_settings, real_time: true, time_since: null } }), "現實時間打開了：照真實時間");
  };
  dialog.showModal();
}

// ---------- 開新聊天 ----------
function openNewChat() {
  const name = current.profile.name || "他";
  $("#new-chat-keep-text").textContent = `同一個 ${name}，記得以前的事，換個場景重新開始。現在這段聊天會變成舊聊天：還看得到，但不能接著聊，也不能再從裡面的句子重來。`;
  $("#new-chat-fresh-text").textContent = `複製一個新的「${name}（新的開始）」：個性設定一樣，記憶清空、心情回到初始，完全不認識你。原本的 ${name} 和聊天紀錄都不會動。`;
  const dialog = $("#new-chat-dialog"); dialog.returnValue = "cancel";
  dialog.onclose = () => {
    const choice = dialog.returnValue; if (choice !== "keep" && choice !== "fresh") return;
    if (pendingMessage && !confirm("還沒確認的那句會丟掉，確定要開新聊天嗎？")) return;
    try {
      if (choice === "keep") {
        const updated = Core.normalize(Core.startNewChat(current));
        current = Store.saveTurnsAndCharacter(updated, Core.trimSnapshots(Store.allTurns(current.character_id), Core.currentChatId(updated)));
        resetPendingChat(); viewingChatId = null; $("#chat-message").value = "";
        refreshChatTurns(); refreshList(); render(); toast("開了新的聊天，他還記得以前的事");
      } else {
        const copy = Store.saveCharacter(Core.freshCopy(current)); Store.replaceTurns(copy.character_id, []);
        resetPendingChat(); $("#chat-message").value = ""; refreshList(); loadCharacter(copy.character_id); showTab("chat");
        toast(`開了「${copy.profile.name}」，他不認識你`);
      }
    } catch (error) { toast(error.message, true); }
  };
  dialog.showModal();
}
// 這句不算：把剛剛打的字放回輸入框，方便改一改重送。
function giveBackMessage() { const box = $("#chat-message"); if (pendingMessage && !box.value.trim()) { box.value = pendingMessage; growComposer(); } }
async function generateChat(event) {
  event.preventDefault();
  if (waitingReply) return;
  if (pendingMessage) { toast("上一句還在等回覆：先貼上回覆，或按「取消這句」。", true); return; }
  try {
    const userMessage = Core.validateUserMessage($("#chat-message").value); const manual = $("#chat-mode").value === "manual";
    const settings = geminiSettings();
    if (!manual && !settings.apiKey) throw new Error("還沒填 Gemini 鑰匙。請按左邊的「設定」填好，或改用手動複製貼上。");
    const prompt = chatPrompt(userMessage, manual);
    pendingMessage = userMessage; $("#chat-message").value = ""; growComposer();
    if (manual) { $("#paste-help").hidden = true; $("#manual-chat-prompt").value = prompt; $("#manual-chat-response").value = ""; renderChat(); return; }
    waitingReply = true; waitingNote = ""; geminiFailure = null; renderChat();
    try {
      const text = await AI.askGeminiWithRetry(prompt, settings, { onRetry: (attempt) => { waitingNote = `Gemini 塞車中，等一下再試（第 ${attempt} 次）……`; renderChat(); } });
      let response;
      try { response = Core.validateChatResponse(Core.parseJsonObjectText(text)); }
      catch (error) { throw new Error(`Gemini 的回覆沒通過檢查：${error.message}`); }
      waitingReply = false; waitingNote = ""; saveReply(userMessage, response);
    } catch (error) { waitingReply = false; waitingNote = ""; geminiFailure = `${error.message}\n要換成手動複製貼上嗎？剛剛那句不用重打。`; renderChat(); }
  } catch (error) { toast(error.message, true); }
}
function showPasteHelp(message, openFallback = true) { const help = $("#paste-help"); help.textContent = message; help.hidden = false; if (openFallback) $(".manual-fallback").open = true; }
// 按一下就讀剪貼簿（瀏覽器規定一定要按，網頁不能自己偷讀）。讀不到就打開下面的框框讓你自己貼。
async function pasteChatResponse() {
  if (!pendingMessage) { toast("先在下面打字送出。", true); return; }
  let text = ""; const help = $("#paste-help"); help.hidden = true;
  if (!navigator.clipboard?.readText) { showPasteHelp("這個瀏覽器不支援一鍵貼上（可能版本太舊，或網頁不是從 https 網址打開）。請點下面「改成自己貼」。"); return; }
  // 按下去馬上給反應；瀏覽器可能在等你按「允許」或「貼上」，太久沒回應就提示去哪裡看。
  const button = $("#paste-chat-response"); button.disabled = true; button.textContent = "讀取剪貼簿中……";
  const slow = setTimeout(() => { showPasteHelp("瀏覽器在等你回答：看看網址列附近有沒有跳出「允許讀取剪貼簿」的詢問，或按鈕旁邊有沒有一個小小的「貼上」，點它就好。都沒看到的話，請點下面「改成自己貼」。", false); button.disabled = false; button.textContent = "從剪貼簿貼上"; }, 2500);
  try { text = await navigator.clipboard.readText(); }
  catch {
    clearTimeout(slow); button.disabled = false; button.textContent = "從剪貼簿貼上";
    let denied = false; try { denied = (await navigator.permissions?.query({ name: "clipboard-read" }))?.state === "denied"; } catch { /* 有些瀏覽器不能查 */ }
    showPasteHelp(denied ? "剪貼簿被封鎖了（可能之前跳詢問時按到「封鎖」）。解法：點網址列最左邊的小圖示 →「網站設定」或「權限」→ 剪貼簿改成「允許」，重新整理再按一次。這次先點下面「改成自己貼」。" : "瀏覽器沒讓網頁讀剪貼簿。如果有跳出詢問，請按「允許」再按一次；沒跳的話，請點下面「改成自己貼」。");
    return;
  }
  clearTimeout(slow); button.disabled = false; button.textContent = "從剪貼簿貼上"; help.hidden = true;
  if (!text.trim()) { toast("剪貼簿是空的，先去複製 AI 的回覆。", true); return; }
  $("#manual-chat-response").value = text; parseManualChatResponse();
}
function parseManualChatResponse() {
  try {
    if (!pendingMessage) throw new Error("先在下面打字送出。");
    let response;
    try { response = Core.validateChatResponse(Core.parseJsonObjectText($("#manual-chat-response").value)); }
    catch (error) { throw new Error(`貼回的內容沒通過檢查：${error.message}`); }
    saveReply(pendingMessage, response);
  } catch (error) { toast(error.message, true); }
}
async function copyText(text, message, failMessage = "瀏覽器不讓網頁直接複製，請按「看提示詞內容」手動全選後複製。") {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast(failMessage, true); }
}
function copyChatPrompt() { const prompt = $("#manual-chat-prompt").value; if (!prompt) { toast("請先送出一句話。", true); return; } copyText(prompt, "提示詞已複製"); }
function toggleChatPrompt() { const box = $("#manual-chat-prompt"); box.hidden = !box.hidden; $("#show-chat-prompt").textContent = box.hidden ? "看提示詞內容" : "收起提示詞"; }
// 他回完直接存（已經通過 core.js 檢查）。想記住的事放得下的都存，滿了那層就不存。
function saveReply(userMessage, rawResponse) {
  try {
    const message = Core.validateUserMessage(userMessage), clean = Core.validateChatResponse(rawResponse);
    const { kept, skipped } = Core.fittingMemories(current, clean.memory_candidates); // 一模一樣的舊記憶已經有了就不存，也不提醒
    const { updated, response, selected } = Core.applyChatResponse(current, clean, kept);
    const chatId = Core.currentChatId(current), before = Core.snapshotOf(current), turnId = Core.newTurnId();
    // 設定提議開著才收；放進角色頁的待處理清單，同意了才會改設定。
    const videoOn = current.chat_settings?.video !== false;
    const proposalsOn = current.chat_settings?.proposals !== false, waitingBefore = Core.activeProposals(current).length;
    const withProposals = proposalsOn ? Core.addProposals(updated, response.profile_proposals, turnId).updated : updated;
    // AI 這次沒寫摘要的話，沿用這段聊天上一份。
    const recentSummary = response.recent_summary || Core.chatSummary(Store.allTurns(current.character_id), chatId) || undefined;
    current = Store.saveTurn(withProposals, { id: turnId, contract_version: Core.CHAT_CONTRACT_VERSION, chat_id: chatId, user_message: message, character_reply: response.reply, inner_thought: response.inner_thought, recent_summary: recentSummary, state_proposal: response.state_proposal, memory_candidates: selected, before, ...(videoOn && response.scene ? { scene: response.scene } : {}), ...(response.mood_now ? { mood_now: response.mood_now } : {}), ...(response.feeling_toward_user ? { feeling_toward_user: response.feeling_toward_user } : {}) });
    Store.replaceTurns(current.character_id, Core.trimSnapshots(Store.allTurns(current.character_id), chatId));
    resetPendingChat(); $("#manual-chat-prompt").value = ""; $("#manual-chat-response").value = "";
    refreshChatTurns(); refreshList(); render(); $("#chat-message").focus();
    if (skipped.length) toast(`記憶滿了，有 ${skipped.length} 件想記住的事沒存（可以到「角色 → 進階」調大記憶容量）。`);
    const waiting = Core.activeProposals(current).length;
    if (!skipped.length && waiting >= Core.PROPOSAL_REMINDER && waitingBefore < Core.PROPOSAL_REMINDER) toast(`AI 提議的設定變化積了 ${waiting} 筆，有空到「角色」分頁看看。`);
    return true;
  } catch (error) { toast(error.message, true); return false; }
}
function discardPendingChat() { giveBackMessage(); resetPendingChat(); $("#manual-chat-prompt").value = ""; $("#manual-chat-response").value = ""; renderChat(); toast("這句不算，剛剛打的字放回輸入框了"); }
// 輸入框跟著字數長高，最多長到大約六行。
function growComposer() { const box = $("#chat-message"); box.style.height = "auto"; box.style.height = `${Math.min(box.scrollHeight, 160)}px`; }
// 手機、平板（用手指點、沒有滑鼠）：Enter 是換行，用「送出」按鈕送。電腦：Enter 送出，Shift＋Enter 換行。
const touchOnly = window.matchMedia?.("(hover: none) and (pointer: coarse)").matches === true;
function composerKeydown(event) {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.keyCode === 229) return; // 229＝中文輸入法還在選字
  if (touchOnly && !event.ctrlKey && !event.metaKey) return;
  event.preventDefault(); $("#chat-form").requestSubmit();
}

// ---------- 設定提議 ----------
function toggleProposals() {
  const on = $("#proposal-toggle").checked;
  persist((doc) => ({ ...doc, chat_settings: { ...doc.chat_settings, proposals: on } }), on ? "設定提議打開了：聊天裡他變了，AI 會提議改設定" : "設定提議關掉了：AI 不會再提議（已經有的提議還留在角色頁）");
}
function toggleVideo() {
  const on = $("#video-toggle").checked;
  persist((doc) => ({ ...doc, chat_settings: { ...doc.chat_settings, video: on } }), on ? "視訊模式打開了：他回話時會多一段畫面描述" : "視訊模式關掉了：之前的描述還留著");
}
// ---------- 深淺色（記在這台裝置，預設深色） ----------
function applyTheme() {
  const settings = Store.getSettings(), theme = settings.theme === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  applyHue(settings.hue, theme);
  $("#theme-toggle").textContent = theme === "dark" ? "☀ 換成淺色" : "☾ 換成深色";
}
// ---------- 主題色（色相環，只換色相；記在這台裝置。沒選過＝原本的青綠色） ----------
// 套色的函式在 index.html 開頭（打開網頁時先套上，免得閃一下），這裡共用。
const DEFAULT_HUE = 176;
function applyHue(hue, theme = document.documentElement.dataset.theme) { window.EmoApplyHue(hue, theme); }
function currentHue() { const hue = Store.getSettings().hue; return Number.isFinite(hue) ? hue : DEFAULT_HUE; }
function placeHueKnob(hue) {
  const ring = $("#hue-ring"), radius = ring.clientWidth / 2 - 17, angle = (hue * Math.PI) / 180;
  $("#hue-knob").style.transform = `translate(${Math.sin(angle) * radius}px, ${-Math.cos(angle) * radius}px)`;
  $("#hue-knob").style.background = `hsl(${hue} 45% 45%)`;
  ring.setAttribute("aria-valuenow", String(Math.round(hue)));
}
function setHue(hue) {
  hue = Math.round(((hue % 360) + 360) % 360);
  try { Store.saveSettings({ ...Store.getSettings(), hue }); } catch (error) { toast(error.message, true); }
  applyHue(hue); placeHueKnob(hue);
}
function openHueDialog() { $("#hue-dialog").showModal(); placeHueKnob(currentHue()); }
function hueFromPointer(event) {
  const rect = $("#hue-ring").getBoundingClientRect();
  const dx = event.clientX - (rect.left + rect.width / 2), dy = event.clientY - (rect.top + rect.height / 2);
  setHue((Math.atan2(dx, -dy) * 180) / Math.PI);
}
function setupHueRing() {
  const ring = $("#hue-ring"); let dragging = false;
  ring.addEventListener("pointerdown", (event) => { dragging = true; ring.setPointerCapture(event.pointerId); hueFromPointer(event); });
  ring.addEventListener("pointermove", (event) => { if (dragging) hueFromPointer(event); });
  ring.addEventListener("pointerup", () => { dragging = false; });
  ring.addEventListener("keydown", (event) => { const step = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[event.key]; if (step) { event.preventDefault(); setHue(currentHue() + step); } });
  $("#hue-reset").onclick = () => { try { const { hue, ...rest } = Store.getSettings(); Store.saveSettings(rest); } catch (error) { toast(error.message, true); } applyHue(null); placeHueKnob(DEFAULT_HUE); };
  $("#hue-open").onclick = openHueDialog;
}
function toggleTheme() {
  try { const s = Store.getSettings(); Store.saveSettings({ ...s, theme: s.theme === "light" ? "dark" : "light" }); applyTheme(); }
  catch (error) { toast(error.message, true); }
}
function renderProposals() {
  const items = Core.activeProposals(current), box = $("#proposal-box"), list = $("#proposal-list");
  const many = items.length >= Core.PROPOSAL_REMINDER;
  box.hidden = !items.length; box.classList.toggle("many", many);
  $("#proposal-summary").textContent = `AI 提議的設定變化（${items.length} 筆）${many ? "：積很多了，有空看看" : ""}`;
  const tab = document.querySelector('.tab[data-tab="character"]'); tab.textContent = "角色";
  if (many) tab.append(el("span", "tab-badge", String(items.length)));
  list.innerHTML = "";
  items.forEach((item) => {
    const card = el("article", "proposal-card");
    card.append(el("strong", "", item.label), el("small", "", `${formatTime(item.created_at)} · ${item.reason}`));
    card.append(el("p", "proposal-now", `現在：${item.current_text.trim() || "（空的）"}`));
    const next = el("p", "proposal-new", `提議改成：${item.new_text}`); card.append(next);
    const editor = el("textarea"); editor.rows = 4; editor.value = item.new_text; editor.hidden = true; editor.setAttribute("aria-label", `${item.label}要改成的文字`); card.append(editor);
    if (item.older.length) {
      const older = el("details", "proposal-older"); older.append(el("summary", "", `這欄之前還提過 ${item.older.length} 次（被這筆取代了）`));
      item.older.forEach((old) => older.append(el("p", "", `${formatTime(old.created_at)}：${old.new_text}`)));
      card.append(older);
    }
    const actions = el("div", "proposal-actions");
    const reject = el("button", "secondary small-button", "不要"); reject.type = "button"; reject.onclick = () => resolveProposalUI(item, false);
    const edit = el("button", "secondary small-button", "修一下"); edit.type = "button";
    const accept = el("button", "primary small-button", "同意"); accept.type = "button"; accept.onclick = () => resolveProposalUI(item, true, editor.hidden ? undefined : editor.value);
    edit.onclick = () => { editor.hidden = false; next.hidden = true; edit.hidden = true; accept.textContent = "用改過的同意"; editor.focus(); };
    actions.append(reject, edit, accept); card.append(actions);
    list.append(card);
  });
}
function resolveProposalUI(item, accept, text) {
  if (characterDirty) { toast("角色頁有還沒儲存的修改，先按「儲存角色」，再處理提議。", true); return; }
  if (!accept && !confirm(`不要這個提議？\n\n「${item.label}」這筆提議會從清單拿掉${item.older.length ? `（連同之前的 ${item.older.length} 筆）` : ""}，找不回來。設定不會改。\n\n確定不要嗎？`)) return;
  if (persist((doc) => Core.resolveProposal(doc, item.proposal_id, { accept, text }), accept ? `${item.label}改好了` : "這筆提議拿掉了")) { buildDraft(); renderCharacterForm(); }
}

// ---------- 聊天室放大（網頁裡鋪滿畫面） ----------
// 放大時那一欄的寬度（記在這台裝置）。按－／＋每次 80，最窄 480、最寬 1600。
const CHAT_WIDTH = { min: 480, max: 1600, step: 80, start: 820 };
function savedChatWidth() { const saved = Store.getSettings().chat_width; return Number.isFinite(saved) ? saved : CHAT_WIDTH.start; }
function applyChatWidth(width) {
  document.documentElement.style.setProperty("--chat-width", `${width}px`);
  $("#chat-narrower").disabled = width <= CHAT_WIDTH.min; $("#chat-wider").disabled = width >= CHAT_WIDTH.max;
}
function changeChatWidth(direction) {
  const width = Math.min(CHAT_WIDTH.max, Math.max(CHAT_WIDTH.min, savedChatWidth() + direction * CHAT_WIDTH.step));
  applyChatWidth(width);
  try { Store.saveSettings({ ...Store.getSettings(), chat_width: width }); } catch { /* 存不了也照樣能調 */ }
}
// 手機、平板按放大：預設順便進真的全螢幕（設定可以改成只在網頁裡放大）。iPhone 不支援就只在網頁裡放大。
function wantsFullscreen() {
  if (!touchOnly || typeof document.documentElement.requestFullscreen !== "function") return false;
  try { return Store.getSettings().phone_zoom !== "page"; } catch { return true; }
}
let zoomFullscreen = false;
document.addEventListener("fullscreenchange", () => {
  // 用返回手勢退出全螢幕時，聊天室也一起縮回來。
  if (!document.fullscreenElement && zoomFullscreen) { zoomFullscreen = false; if (document.body.classList.contains("chat-zoomed")) setChatZoom(false); }
});
// 手機鍵盤彈出來時，畫面實際看得到的高度會變小；放大的聊天室跟著縮，輸入框才不會被鍵盤蓋住。
function syncVisibleArea() {
  const view = window.visualViewport; if (!view) return;
  const root = document.documentElement.style;
  root.setProperty("--app-height", `${Math.round(view.height)}px`); root.setProperty("--app-top", `${Math.round(view.offsetTop)}px`);
  if (document.body.classList.contains("chat-zoomed") && document.activeElement === $("#chat-message")) { const history = $("#chat-history"); history.scrollTop = history.scrollHeight; }
}
if (window.visualViewport) { window.visualViewport.addEventListener("resize", syncVisibleArea); window.visualViewport.addEventListener("scroll", syncVisibleArea); syncVisibleArea(); }
function setChatZoom(on) {
  if (on && !document.body.classList.contains("chat-zoomed") && wantsFullscreen() && !document.fullscreenElement) {
    document.documentElement.requestFullscreen().then(() => { zoomFullscreen = true; }).catch(() => { /* 進不了全螢幕就只在網頁裡放大 */ });
  }
  if (!on && zoomFullscreen && document.fullscreenElement) { zoomFullscreen = false; document.exitFullscreen().catch(() => {}); }
  document.body.classList.toggle("chat-zoomed", on);
  $("#chat-width-box").hidden = !on;
  if (on) applyChatWidth(savedChatWidth());
  const button = $("#chat-zoom"); button.textContent = on ? "縮小" : "放大"; button.title = on ? "回到原本的大小（也可以按 Esc）" : "聊天室鋪滿整個畫面";
  const history = $("#chat-history"); history.scrollTop = history.scrollHeight;
}

// ---------- 分頁與啟動 ----------
function showTab(name) { if (name !== "chat") setChatZoom(false); document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name)); document.querySelectorAll(".tab-panel").forEach((x) => { x.hidden = x.id !== `panel-${name}`; }); if (name === "chat") { const history = $("#chat-history"); history.scrollTop = history.scrollHeight; } }
function start() {
  try { applyTheme(); } catch { /* 存不了設定也照樣能玩 */ }
  setupHueRing(); $("#chat-narrower").onclick = () => changeChatWidth(-1); $("#chat-wider").onclick = () => changeChatWidth(1);
  $("#card-open").onclick = openCardDialog; $("#card-copy").onclick = () => copyText($("#card-template").value, "空白角卡已經複製好了", "瀏覽器不讓網頁直接複製，請在上面的框裡全選後複製，或按「下載成檔案」。");
  $("#card-download").onclick = downloadCard; $("#card-import").onclick = importCardFromDialog;
  try { refreshList(); if (characters[0]) { loadCharacter(characters[0].id); showTab("chat"); } }
  catch (error) { toast(error.message, true); }
}
$("#new-character").onclick = createCharacter; document.querySelector("[data-new]").onclick = createCharacter;
$("#save-character").onclick = () => $("#character-form").requestSubmit(); $("#character-form").onsubmit = saveCharacter; $("#character-form").oninput = () => setDirty(true);
$("#add-custom-module").onclick = addCustomModule;
$("#memory-settings-form").onsubmit = saveMemorySettings; $("#save-state").onclick = () => $("#state-form").requestSubmit(); $("#state-form").onsubmit = saveState;
$("#add-relationship").onclick = addRelationship; $("#import-file").onchange = importFile; $("#export-button").onclick = exportCurrent; $("#delete-character").onclick = deleteCharacter;
$("#copy-json").onclick = () => copyText(JSON.stringify(current, null, 2), "完整 JSON 已複製");
$("#open-settings").onclick = openSettings; $("#settings-form").onsubmit = saveSettings;
$("#chat-form").onsubmit = generateChat; $("#chat-mode").onchange = changeChatMode; $("#copy-chat-prompt").onclick = copyChatPrompt; $("#show-chat-prompt").onclick = toggleChatPrompt; $("#parse-chat-response").onclick = parseManualChatResponse; $("#paste-chat-response").onclick = pasteChatResponse; $("#cancel-manual-chat").onclick = discardPendingChat;
$("#real-time-toggle").onchange = toggleRealTime; $("#proposal-toggle").onchange = toggleProposals; $("#video-toggle").onchange = toggleVideo; $("#theme-toggle").onclick = toggleTheme; $("#chat-zoom").onclick = () => setChatZoom(!document.body.classList.contains("chat-zoomed"));
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && document.body.classList.contains("chat-zoomed") && !document.querySelector("dialog[open]")) setChatZoom(false); }); $("#new-chat").onclick = openNewChat; $("#chat-select").onchange = switchChat;
$("#back-to-current-chat").onclick = () => { $("#chat-select").value = Core.currentChatId(current); switchChat(); };
$("#chat-message").onkeydown = composerKeydown; $("#chat-message").oninput = growComposer;
document.querySelectorAll(".tab").forEach((button) => { button.onclick = () => showTab(button.dataset.tab); });
// 展開折起來的區塊時，如果展開的內容跑到畫面外面（例如在頁尾），就捲過去讓它看得到。
document.addEventListener("toggle", (event) => {
  const box = event.target;
  if (!(box instanceof HTMLDetailsElement) || !box.open) return;
  requestAnimationFrame(() => {
    const rect = box.getBoundingClientRect();
    if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
    box.scrollIntoView({ behavior: "smooth", block: rect.height > window.innerHeight ? "start" : "nearest" });
  });
}, true);
window.addEventListener("beforeunload", (event) => { if (characterDirty) event.preventDefault(); });
start();
