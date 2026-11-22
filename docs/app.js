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
  pendingChat = null; refreshChatTurns();
  $("#empty-state").hidden = true; $("#editor").hidden = false; render();
}
function render() {
  if (!current) return;
  $("#character-title").textContent = current.profile.name || "未命名角色";
  $("#save-status").textContent = `已存在這台裝置 · ${formatTime(current.metadata.updated_at)}`;
  if (!characterDirty) renderCharacterForm();
  renderMemorySettings(); renderState(); renderRelationships(); renderChat(); renderObserver();
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
    const data = JSON.parse(await file.text());
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

// ---------- 設定（Gemini 鑰匙只存在這台裝置） ----------
function openSettings() { const s = Store.getSettings(), form = $("#settings-form"); form.gemini_api_key.value = s.gemini_api_key || ""; form.gemini_model.value = s.gemini_model || ""; $("#settings-dialog").showModal(); }
function saveSettings(event) {
  if (event.submitter?.value === "cancel") return;
  const form = $("#settings-form");
  try { Store.saveSettings({ ...Store.getSettings(), gemini_api_key: form.gemini_api_key.value.trim(), gemini_model: form.gemini_model.value.trim() }); renderChat(); toast("設定已存在這台裝置"); }
  catch (error) { toast(error.message, true); }
}

// ---------- 觀察者 ----------
function renderObserver() {
  if (!current) return;
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
function refreshChatTurns() { chatTurns = current ? Store.listTurns(current.character_id, 30) : []; }
function geminiSettings() { const s = Store.getSettings(); return { apiKey: s.gemini_api_key || "", model: s.gemini_model || AI.DEFAULT_GEMINI_MODEL }; }
function formatStateProposal(proposal) { if (!proposal) return "沒有提出心理狀態變化。"; return `${proposal.summary}\n${JSON.stringify(proposal.state_patch, null, 2)}`; }
function renderChat() {
  if (!current) return;
  const history = $("#chat-history"); history.innerHTML = "";
  if (!chatTurns.length) { const empty = document.createElement("p"); empty.className = "chat-empty"; empty.textContent = "尚未有已確認保存的互動。"; history.append(empty); }
  chatTurns.forEach((turn) => {
    const item = document.createElement("article"); item.className = "chat-turn";
    const user = document.createElement("p"); user.className = "chat-user"; user.textContent = `你：${turn.user_message}`;
    const reply = document.createElement("p"); reply.className = "chat-character"; reply.textContent = `${current.profile.name}：${turn.character_reply}`;
    item.append(user, reply);
    if (turn.state_proposal) { const state = document.createElement("details"); state.className = "chat-turn-state"; state.innerHTML = "<summary>已確認的心理狀態提案</summary>"; const content = document.createElement("pre"); content.textContent = formatStateProposal(turn.state_proposal); state.append(content); item.append(state); }
    if (turn.memory_candidates?.length) { const memories = document.createElement("details"); memories.className = "chat-turn-state"; memories.innerHTML = `<summary>已保存 ${turn.memory_candidates.length} 筆記憶</summary>`; const content = document.createElement("pre"); content.textContent = turn.memory_candidates.map((m) => `[${m.importance}] ${m.summary}\n${m.reason}`).join("\n\n"); memories.append(content); item.append(memories); }
    history.append(item);
  });
  const manual = $("#chat-mode").value === "manual", ready = Boolean(geminiSettings().apiKey);
  $("#manual-chat-workflow").hidden = !manual;
  $("#chat-generate").textContent = manual ? "產生手動提示詞" : "送出給 Gemini";
  $("#model-status").textContent = manual ? "手動模式：不連網" : (ready ? "自動模式：Gemini" : "自動模式不能用：還沒在「設定」填 Gemini 鑰匙");
  $("#model-status").classList.toggle("ready", manual || ready);
  $("#chat-preview").hidden = !pendingChat;
  if (pendingChat) { $("#chat-preview-reply").textContent = pendingChat.response.reply; $("#chat-preview-state").textContent = formatStateProposal(pendingChat.response.state_proposal); renderMemoryCandidates(); }
}
function chatMessageOrThrow() { return Core.validateUserMessage($("#chat-message").value); }
function chatPrompt(userMessage) { return Core.buildChatPrompt(current, Store.listTurns(current.character_id, 12), userMessage); }
function renderMemoryCandidates() {
  const container = $("#chat-preview-memories"); container.innerHTML = "";
  const candidates = pendingChat?.response.memory_candidates || [];
  if (!candidates.length) { container.textContent = "本次沒有記憶候選項。"; return; }
  const heading = document.createElement("p"); heading.className = "memory-heading"; heading.textContent = "記憶候選項（預設不保存；勾選後才會寫入角色資料）"; container.append(heading);
  candidates.forEach((candidate) => {
    const label = document.createElement("label"); label.className = "memory-candidate";
    const input = document.createElement("input"); input.type = "checkbox"; const key = Core.memoryKey(candidate);
    input.checked = pendingChat.selectedMemoryKeys.includes(key);
    input.onchange = () => { pendingChat.selectedMemoryKeys = input.checked ? [...pendingChat.selectedMemoryKeys, key] : pendingChat.selectedMemoryKeys.filter((item) => item !== key); };
    const text = document.createElement("span"); text.textContent = `[${candidate.importance}] ${candidate.summary} — ${candidate.reason}`;
    label.append(input, text); container.append(label);
  });
}
function selectedMemoryCandidates() { const selected = new Set(pendingChat?.selectedMemoryKeys || []); return (pendingChat?.response.memory_candidates || []).filter((candidate) => selected.has(Core.memoryKey(candidate))); }
function showChatPreview(userMessage, response) { pendingChat = { userMessage, response, selectedMemoryKeys: [] }; renderChat(); $("#chat-preview").scrollIntoView({ behavior: "smooth", block: "nearest" }); }
async function generateChat(event) {
  event.preventDefault();
  const button = $("#chat-generate");
  try {
    const userMessage = chatMessageOrThrow(); const manual = $("#chat-mode").value === "manual";
    if (manual) { $("#manual-chat-prompt").value = chatPrompt(userMessage); toast("完整提示詞已產生；可以複製到網頁 AI。"); return; }
    const settings = geminiSettings();
    if (!settings.apiKey) throw new Error("還沒填 Gemini 鑰匙。請按左邊的「設定」填好，或改用手動模式。");
    button.disabled = true; button.textContent = "等 Gemini 回覆中……";
    const text = await AI.askGemini(chatPrompt(userMessage), settings);
    let response;
    try { response = Core.validateChatResponse(Core.parseJsonObjectText(text)); }
    catch (error) { throw new Error(`Gemini 的回覆沒通過檢查：${error.message}`); }
    showChatPreview(userMessage, response); toast("已取得回覆；確認後才會保存。");
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; renderChat(); }
}
function parseManualChatResponse() {
  try {
    const userMessage = chatMessageOrThrow();
    let response;
    try { response = Core.validateChatResponse(Core.parseJsonObjectText($("#manual-chat-response").value)); }
    catch (error) { throw new Error(`貼回的內容沒通過檢查：${error.message}`); }
    showChatPreview(userMessage, response); toast("貼回內容已通過檢查；確認後才會保存。");
  } catch (error) { toast(error.message, true); }
}
async function copyText(text, message) {
  try { await navigator.clipboard.writeText(text); toast(message); }
  catch { toast("瀏覽器不讓網頁直接複製，請手動全選後複製。", true); }
}
function copyChatPrompt() { const prompt = $("#manual-chat-prompt").value; if (!prompt) { toast("請先產生提示詞。", true); return; } copyText(prompt, "提示詞已複製"); }
function applyPendingChat() {
  if (!pendingChat) return;
  try {
    const userMessage = Core.validateUserMessage(pendingChat.userMessage);
    const { updated, response, selected } = Core.applyChatResponse(current, pendingChat.response, selectedMemoryCandidates());
    current = Store.saveTurn(updated, { contract_version: Core.CHAT_CONTRACT_VERSION, user_message: userMessage, character_reply: response.reply, state_proposal: response.state_proposal, memory_candidates: selected });
    pendingChat = null; $("#chat-message").value = ""; $("#manual-chat-prompt").value = ""; $("#manual-chat-response").value = "";
    refreshChatTurns(); refreshList(); render(); toast("這一回合已保存");
  } catch (error) { toast(error.message, true); }
}
function discardPendingChat() { pendingChat = null; renderChat(); toast("還沒保存的回覆已捨棄"); }

// ---------- 分頁與啟動 ----------
function showTab(name) { document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name)); document.querySelectorAll(".tab-panel").forEach((x) => { x.hidden = x.id !== `panel-${name}`; }); }
function start() {
  try { refreshList(); if (characters[0]) loadCharacter(characters[0].id); }
  catch (error) { toast(error.message, true); }
}
$("#new-character").onclick = createCharacter; document.querySelector("[data-new]").onclick = createCharacter;
$("#save-character").onclick = () => $("#character-form").requestSubmit(); $("#character-form").onsubmit = saveCharacter; $("#character-form").oninput = () => setDirty(true);
$("#add-custom-module").onclick = addCustomModule;
$("#memory-settings-form").onsubmit = saveMemorySettings; $("#save-state").onclick = () => $("#state-form").requestSubmit(); $("#state-form").onsubmit = saveState;
$("#add-relationship").onclick = addRelationship; $("#import-file").onchange = importFile; $("#export-button").onclick = exportCurrent; $("#delete-character").onclick = deleteCharacter;
$("#copy-json").onclick = () => copyText(JSON.stringify(current, null, 2), "完整 JSON 已複製");
$("#open-settings").onclick = openSettings; $("#settings-form").onsubmit = saveSettings;
$("#chat-form").onsubmit = generateChat; $("#chat-mode").onchange = renderChat; $("#copy-chat-prompt").onclick = copyChatPrompt; $("#parse-chat-response").onclick = parseManualChatResponse; $("#apply-chat-turn").onclick = applyPendingChat; $("#discard-chat-preview").onclick = discardPendingChat;
document.querySelectorAll(".tab").forEach((button) => { button.onclick = () => showTab(button.dataset.tab); });
window.addEventListener("beforeunload", (event) => { if (characterDirty) event.preventDefault(); });
start();
