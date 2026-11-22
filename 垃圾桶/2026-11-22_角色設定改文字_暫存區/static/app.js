const api = async (url, options = {}) => {
  const response = await fetch(url, { headers: { "Content-Type": "application/json", ...(options.headers || {}) }, ...options });
  if (!response.ok) { const detail = await response.json().catch(() => ({})); throw new Error(detail.detail || "操作失敗，請再試一次。"); }
  return response.headers.get("content-type")?.includes("application/json") ? response.json() : response;
};
const $ = (selector) => document.querySelector(selector);
let current = null, characters = [], selectedRelationshipId = null, presets = [], draft = null, characterDirty = false, chatTurns = [], pendingChat = null, modelStatus = { provider: "disabled", ready: false };
const toast = (message, error = false) => { const el = $("#toast"); el.textContent = message; el.style.background = error ? "#904645" : "#213b3d"; el.classList.add("show"); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => el.classList.remove("show"), 2700); };
const clone = (value) => JSON.parse(JSON.stringify(value));
const parseObject = (text, label) => { try { const value = JSON.parse(text || "{}"); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; } catch { throw new Error(`${label} 必須是有效的 JSON 物件。`); } };
const numberOr = (value, fallback) => value === "" ? fallback : Number(value);

async function refreshList() { characters = await api("/api/characters"); renderList(); }
function renderList() { const container = $("#character-list"); container.innerHTML = ""; characters.forEach(item => { const button = document.createElement("button"); button.className = `character-item ${current?.character_id === item.id ? "active" : ""}`; button.innerHTML = `<strong>${escapeHtml(item.name)}</strong><small>最後修改 ${new Date(item.updated_at).toLocaleString("zh-TW")}</small>`; button.onclick = () => loadCharacter(item.id); container.append(button); }); }
async function loadCharacter(id) { if (characterDirty && current?.character_id !== id && !confirm("角色頁有還沒儲存的修改，確定要離開嗎？")) return; current = await api(`/api/characters/${id}`); buildDraft(); selectedRelationshipId = current.relationships.find(item => item?.relationship_id)?.relationship_id || null; pendingChat = null; await refreshChatTurns(); $("#empty-state").hidden = true; $("#editor").hidden = false; render(); }
function escapeHtml(value) { return String(value ?? "").replace(/[&<>"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[char])); }
function render() { if (!current) return; $("#character-title").textContent = current.profile.name || "未命名角色"; $("#save-status").textContent = `已儲存至本機 SQLite · ${new Date(current.metadata.updated_at).toLocaleString("zh-TW")}`; if (!characterDirty) renderCharacterForm(); renderMemorySettings(); renderState(); renderRelationships(); renderChat(); renderObserver(); $("#json-preview").textContent = JSON.stringify(current, null, 2); renderList(); }
function setFormValue(form, name, value) { form.elements[name].value = value ?? ""; }
// 角色頁：基本資料＋模組文字框。改到一半的內容放在 draft，按「儲存角色」才整份存回去。
function buildDraft() {
  draft = { modules: [] }; const used = new Set();
  presets.forEach(preset => {
    const matches = current.modules.filter(module => module.type === preset.type);
    if (matches.length) matches.forEach(module => { draft.modules.push(clone(module)); used.add(module.module_id); });
    else draft.modules.push({ type: preset.type, name: preset.name, enabled: true, text: "", data: {}, notes: "", placeholder: true });
  });
  current.modules.filter(module => !used.has(module.module_id)).forEach(module => draft.modules.push(clone(module)));
  setDirty(false);
}
function setDirty(value) { characterDirty = value; $("#character-dirty").textContent = value ? "有還沒儲存的修改" : ""; }
function renderCharacterForm() {
  const form = $("#character-form"), p = current.profile;
  setFormValue(form,"name",p.name); setFormValue(form,"aliases",(p.aliases || []).join(", "));
  ["age","gender","pronouns","occupation","background","appearance","current_situation"].forEach(key => setFormValue(form,key,p[key]));
  setFormValue(form,"other_information",JSON.stringify(p.other_information || {},null,2));
  renderModuleCards();
}
function renderModuleCards() {
  const cards = $("#module-cards"); cards.innerHTML = "";
  draft.modules.forEach((module, index) => {
    const preset = presets.find(item => item.type === module.type);
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
    if (!preset) { const remove = document.createElement("button"); remove.type = "button"; remove.className = "delete-module"; remove.textContent = "刪除"; remove.onclick = () => { if ((module.text || "").trim() && !confirm(`確定要刪除「${module.name}」嗎？按「儲存角色」之後才會真的刪掉。`)) return; draft.modules.splice(index, 1); setDirty(true); renderModuleCards(); }; head.append(remove); }
    const guide = document.createElement("p"); guide.className = "module-guide"; guide.textContent = preset?.guide || "這個模組想寫什麼都可以。";
    const text = document.createElement("textarea"); text.rows = module.type === "free" ? 6 : 3; text.value = module.text || ""; text.setAttribute("aria-label", module.name);
    text.oninput = () => { module.text = text.value; };
    card.append(head, guide, text);
    if (module.data && Object.keys(module.data).length) { const legacy = document.createElement("p"); legacy.className = "module-legacy"; legacy.textContent = "這個模組還有舊格式的內容，原封不動保留著，可以在「進階 → 完整資料」看到。"; card.append(legacy); }
    cards.append(card);
  });
}
function addCustomModule() { const name = prompt("新模組要叫什麼名字？", "自訂模組"); if (name === null) return; draft.modules.push({ type: "custom", name: name.trim() || "自訂模組", enabled: true, text: "", data: {}, notes: "" }); setDirty(true); renderModuleCards(); $("#module-cards").lastElementChild?.querySelector("textarea")?.focus(); }
async function saveCharacter(event) {
  event.preventDefault();
  try {
    const form = $("#character-form");
    const profile = { ...current.profile, name: form.name.value.trim() || "未命名角色", aliases: form.aliases.value.split(",").map(x => x.trim()).filter(Boolean), age: form.age.value.trim() || null, gender: form.gender.value.trim() || null, pronouns: form.pronouns.value.trim() || null, occupation: form.occupation.value.trim(), background: form.background.value, appearance: form.appearance.value, current_situation: form.current_situation.value, other_information: parseObject(form.other_information.value, "其他設定") };
    // 沒寫東西的預設格子不存；有寫的才變成正式模組。
    const modules = draft.modules.filter(module => !(module.placeholder && !(module.text || "").trim())).map(({ placeholder, ...module }) => ({ ...module, name: (module.name || "").trim() || "未命名模組" }));
    current = await api(`/api/characters/${current.character_id}`, { method: "PUT", body: JSON.stringify({ ...current, profile, modules }) });
    buildDraft(); await refreshList(); render(); toast("角色已儲存");
  } catch (error) { toast(error.message, true); }
}
function renderMemorySettings() { const limits = $("#memory-settings-form"), settings = current.memory_settings || {}; ["core","important","ordinary"].forEach(tier => { setFormValue(limits,`${tier}_max_items`,settings[tier]?.max_items); setFormValue(limits,`${tier}_max_chars`,settings[tier]?.max_chars); }); }
function renderState() { const form = $("#state-form"), s = current.state; setFormValue(form,"valence",s.mood?.valence); setFormValue(form,"arousal",s.mood?.arousal); ["security","anxiety","loneliness","emotional_stability"].forEach(key => setFormValue(form,key,s.psychological?.[key])); setFormValue(form,"emotions",JSON.stringify(s.emotions || {},null,2)); setFormValue(form,"custom_metrics",JSON.stringify(s.custom_metrics || {},null,2)); }
function renderRelationships() { const list = $("#relationship-list"); list.innerHTML = ""; const relationships = current.relationships.filter(item => item?.relationship_id); relationships.forEach(relationship => { const button = document.createElement("button"); button.className = relationship.relationship_id === selectedRelationshipId ? "active" : ""; const dimensions = relationship.dimensions || {}; button.innerHTML = `<strong>${escapeHtml(relationship.target_name)}</strong><small>信任 ${escapeHtml(dimensions.trust ?? "—")} · 親密 ${escapeHtml(dimensions.intimacy ?? "—")}</small>`; button.onclick = () => { selectedRelationshipId = relationship.relationship_id; renderRelationships(); }; list.append(button); }); const relationship = relationships.find(item => item.relationship_id === selectedRelationshipId); const editor = $("#relationship-editor"); if (!relationship) { editor.className = "module-editor empty-module"; editor.textContent = current.relationships.length ? "舊格式關係資料保留在完整資料中；請新增一筆關係以使用正式維度。" : "選取左側關係，開始編輯它的維度。"; return; } const d = relationship.dimensions; editor.className = "module-editor"; editor.innerHTML = `<form id="relationship-editor-form" class="module-editor-form"><div class="module-top"><label class="field">對象名稱<input name="target_name" value="${escapeHtml(relationship.target_name)}" /></label><label class="field">對象類型<input name="target_type" value="${escapeHtml(relationship.target_type)}" /></label></div><div class="form-grid metrics"><label class="field">信任<input name="trust" type="number" min="0" max="100" value="${escapeHtml(d.trust)}" /></label><label class="field">親密<input name="intimacy" type="number" min="0" max="100" value="${escapeHtml(d.intimacy)}" /></label><label class="field">安全感<input name="safety" type="number" min="0" max="100" value="${escapeHtml(d.safety)}" /></label><label class="field">依賴<input name="dependence" type="number" min="0" max="100" value="${escapeHtml(d.dependence)}" /></label><label class="field">戒心<input name="wariness" type="number" min="0" max="100" value="${escapeHtml(d.wariness)}" /></label></div><label class="field">備註<textarea name="notes" rows="4">${escapeHtml(relationship.notes || "")}</textarea></label><div class="module-actions"><button type="button" id="remove-relationship" class="delete-module">刪除關係</button><button class="primary">儲存關係</button></div></form>`; $("#relationship-editor-form").onsubmit = saveRelationship; $("#remove-relationship").onclick = removeRelationship; }
async function addRelationship() { const targetName = prompt("這段關係的對象是誰？", "未命名對象"); if (targetName === null) return; try { current = await api(`/api/characters/${current.character_id}/relationships`, { method:"POST", body:JSON.stringify({target_name:targetName}) }); selectedRelationshipId = current.relationships.at(-1)?.relationship_id || null; await refreshList(); render(); toast("關係已新增"); } catch (error) { toast(error.message, true); } }
async function saveRelationship(event) { event.preventDefault(); try { const form = event.currentTarget; const number = name => Number(form.elements[name].value); const relationship = { target_name:form.target_name.value.trim(), target_type:form.target_type.value.trim(), dimensions:{trust:number("trust"),intimacy:number("intimacy"),safety:number("safety"),dependence:number("dependence"),wariness:number("wariness")}, notes:form.notes.value }; await persist(`/api/characters/${current.character_id}/relationships/${selectedRelationshipId}`, {method:"PUT",body:JSON.stringify(relationship)}, "關係已儲存"); } catch (error) { toast(error.message, true); } }
async function removeRelationship() { if (!confirm("確定要刪除這段關係嗎？此操作無法復原。")) return; const relationshipId = selectedRelationshipId; selectedRelationshipId = null; await persist(`/api/characters/${current.character_id}/relationships/${relationshipId}`, {method:"DELETE"}, "關係已刪除"); if (!selectedRelationshipId) selectedRelationshipId = current.relationships.find(item => item?.relationship_id)?.relationship_id || null; renderRelationships(); }
async function persist(url, options, message) { try { current = await api(url, options); await refreshList(); render(); toast(message); } catch (error) { toast(error.message, true); } }
async function saveMemorySettings(event) { event.preventDefault(); try { const form = event.currentTarget; const number = (name) => Number(form.elements[name].value); const settings = { core:{max_items:number("core_max_items"),max_chars:number("core_max_chars")}, important:{max_items:number("important_max_items"),max_chars:number("important_max_chars")}, ordinary:{max_items:number("ordinary_max_items"),max_chars:number("ordinary_max_chars")} }; await persist(`/api/characters/${current.character_id}/memory-settings`, { method:"PATCH", body:JSON.stringify(settings) }, "記憶容量已儲存；既有記憶沒有被修改"); } catch (error) { toast(error.message, true); } }
async function saveState(event) { event.preventDefault(); try { const form = event.currentTarget; const state = { mood:{valence:numberOr(form.valence.value,0), arousal:numberOr(form.arousal.value,30)}, psychological:{security:numberOr(form.security.value,50), anxiety:numberOr(form.anxiety.value,30), loneliness:numberOr(form.loneliness.value,30), emotional_stability:numberOr(form.emotional_stability.value,50)}, emotions:parseObject(form.emotions.value,"目前情緒"), custom_metrics:parseObject(form.custom_metrics.value,"自訂指標") }; await persist(`/api/characters/${current.character_id}/state`, {method:"PATCH",body:JSON.stringify(state)}, "心理狀態已儲存"); } catch (error) { toast(error.message, true); } }
async function createCharacter() { const name = prompt("這名角色叫什麼名字？", "未命名角色"); if (name === null) return; try { const created = await api("/api/characters", {method:"POST",body:JSON.stringify({name})}); await refreshList(); await loadCharacter(created.character_id); toast("角色已建立"); } catch (error) { toast(error.message,true); } }
async function importFile(event) { const file = event.target.files[0]; if (!file) return; try { const data = JSON.parse(await file.text()); const imported = await api("/api/characters/import", {method:"POST",body:JSON.stringify(data)}); await refreshList(); await loadCharacter(imported.character_id); toast("角色 JSON 已匯入"); } catch (error) { toast(error instanceof SyntaxError ? "檔案不是有效的 JSON。" : error.message,true); } finally { event.target.value = ""; } }
function exportCurrent() { if (!current) return; const blob = new Blob([JSON.stringify(current,null,2)],{type:"application/json"}); const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href=url; link.download=`${current.profile.name || "character"}.json`; link.click(); URL.revokeObjectURL(url); }
async function deleteCharacter() { if (!current || !confirm(`確定要刪除「${current.profile.name}」嗎？此操作無法復原。`)) return; try { await api(`/api/characters/${current.character_id}`,{method:"DELETE"}); current=null; setDirty(false); await refreshList(); $("#editor").hidden=true; $("#empty-state").hidden=false; toast("角色已刪除"); } catch(error) { toast(error.message,true); } }
function showTab(name) { document.querySelectorAll(".tab").forEach(x=>x.classList.toggle("active",x.dataset.tab===name)); document.querySelectorAll(".tab-panel").forEach(x => { x.hidden = x.id !== `panel-${name}`; }); }
async function start() { try { presets = await api("/api/module-presets"); await refreshList(); if(characters[0]) await loadCharacter(characters[0].id); } catch(error) { toast(`無法連線：${error.message}`,true); } }
$("#new-character").onclick=createCharacter; document.querySelector("[data-new]").onclick=createCharacter; $("#save-character").onclick=()=>$("#character-form").requestSubmit(); $("#character-form").onsubmit=saveCharacter; $("#character-form").oninput=()=>setDirty(true); $("#add-custom-module").onclick=addCustomModule; window.addEventListener("beforeunload", event => { if (characterDirty) event.preventDefault(); }); $("#memory-settings-form").onsubmit=saveMemorySettings; $("#save-state").onclick=()=>$("#state-form").requestSubmit(); $("#state-form").onsubmit=saveState; $("#add-relationship").onclick=addRelationship; $("#import-file").onchange=importFile; $("#export-button").onclick=exportCurrent; $("#delete-character").onclick=deleteCharacter; $("#copy-json").onclick=async()=>{ await navigator.clipboard.writeText(JSON.stringify(current,null,2)); toast("完整 JSON 已複製"); }; document.querySelectorAll(".tab").forEach(button=>button.onclick=()=>showTab(button.dataset.tab)); start();

function renderObserver() {
  if (!current) return;
  const state = $("#observer-state"); state.innerHTML = "";
  const metrics = [
    ["情緒效價", current.state.mood?.valence], ["喚起程度", current.state.mood?.arousal],
    ["安全感", current.state.psychological?.security], ["焦慮", current.state.psychological?.anxiety],
    ["孤獨感", current.state.psychological?.loneliness], ["情緒穩定度", current.state.psychological?.emotional_stability],
  ];
  metrics.forEach(([label, value]) => { const card = document.createElement("div"); card.className = "observer-metric"; const title = document.createElement("small"); title.textContent = label; const number = document.createElement("strong"); number.textContent = value ?? "—"; card.append(title, number); state.append(card); });
  const memories = Array.isArray(current.memories) ? current.memories : []; $("#observer-memory-count").textContent = memories.length;
  const container = $("#observer-memories"); container.innerHTML = "";
  if (!memories.length) { const empty = document.createElement("p"); empty.className = "observer-empty"; empty.textContent = "尚未確認保存任何記憶。"; container.append(empty); }
  else {
    const groups = [["core", "核心記憶"], ["important", "重要記憶"], ["ordinary", "普通記憶"], ["other", "未分類／舊格式記憶"]];
    groups.forEach(([kind, label]) => { const items = memories.filter(item => kind === "other" ? !["core","important","ordinary"].includes(item?.importance) : item?.importance === kind); if (!items.length) return; const section = document.createElement("section"); section.className = "memory-group"; const heading = document.createElement("h4"); const limits = current.memory_settings?.[kind]; heading.textContent = limits ? `${label} · ${items.length} / ${limits.max_items} 筆 · 每筆 ${limits.max_chars} 字元` : `${label} · ${items.length}`; section.append(heading); items.forEach(item => { const card = document.createElement("article"); card.className = "observer-memory"; const summary = document.createElement("strong"); summary.textContent = typeof item?.summary === "string" ? item.summary : JSON.stringify(item); card.append(summary); if (item?.reason) { const reason = document.createElement("p"); reason.textContent = item.reason; card.append(reason); } section.append(card); }); container.append(section); });
  }
  const relationships = Array.isArray(current.relationships) ? current.relationships : [], formalRelationships = relationships.filter(item => item?.relationship_id && item?.dimensions);
  $("#observer-relationships").textContent = formalRelationships.length ? `目前有 ${formalRelationships.length} 筆正式關係資料。` : "尚未建立正式關係資料；可到「關係」分頁新增。";
  const relationshipList = $("#observer-relationship-list"); relationshipList.innerHTML = "";
  formalRelationships.forEach(relationship => { const card = document.createElement("article"); card.className = "observer-relationship"; const name = document.createElement("strong"); name.textContent = relationship.target_name; const dimensions = document.createElement("p"); dimensions.textContent = `信任 ${relationship.dimensions.trust} · 親密 ${relationship.dimensions.intimacy} · 安全感 ${relationship.dimensions.safety} · 依賴 ${relationship.dimensions.dependence} · 戒心 ${relationship.dimensions.wariness}`; card.append(name, dimensions); relationshipList.append(card); });
}
async function refreshChatTurns() { if (current) chatTurns = await api(`/api/characters/${current.character_id}/chat-turns`); else chatTurns = []; }
async function refreshModelStatus() { try { modelStatus = await api("/api/model-status"); } catch { modelStatus = { provider:"unknown", ready:false, message:"無法讀取模型狀態" }; } renderChat(); }
function formatStateProposal(proposal) { if (!proposal) return "沒有提出心理狀態變化。"; return `${proposal.summary}\n${JSON.stringify(proposal.state_patch, null, 2)}`; }
function renderChat() {
  if (!current) return;
  const history = $("#chat-history");
  history.innerHTML = "";
  if (!chatTurns.length) { const empty = document.createElement("p"); empty.className = "chat-empty"; empty.textContent = "尚未有已確認保存的互動。"; history.append(empty); }
  chatTurns.forEach(turn => {
    const item = document.createElement("article"); item.className = "chat-turn";
    const user = document.createElement("p"); user.className = "chat-user"; user.textContent = `你：${turn.user_message}`;
    const reply = document.createElement("p"); reply.className = "chat-character"; reply.textContent = `${current.profile.name}：${turn.character_reply}`;
    item.append(user, reply);
    if (turn.state_proposal) { const state = document.createElement("details"); state.className = "chat-turn-state"; state.innerHTML = "<summary>已確認的心理狀態提案</summary>"; const content = document.createElement("pre"); content.textContent = formatStateProposal(turn.state_proposal); state.append(content); item.append(state); }
    if (turn.memory_candidates?.length) { const memories = document.createElement("details"); memories.className = "chat-turn-state"; memories.innerHTML = `<summary>已保存 ${turn.memory_candidates.length} 筆記憶</summary>`; const content = document.createElement("pre"); content.textContent = turn.memory_candidates.map(item => `[${item.importance}] ${item.summary}\n${item.reason}`).join("\n\n"); memories.append(content); item.append(memories); }
    history.append(item);
  });
  const manual = $("#chat-mode").value === "manual";
  $("#manual-chat-workflow").hidden = !manual;
  $("#chat-generate").textContent = manual ? "產生手動提示詞" : "產生自動回覆預覽";
  $("#model-status").textContent = manual ? "手動模式：不連網" : (modelStatus.ready ? `自動模式：${modelStatus.provider}` : `自動模式不可用：${modelStatus.message || "尚未啟用"}`);
  $("#model-status").classList.toggle("ready", manual || modelStatus.ready);
  $("#chat-preview").hidden = !pendingChat;
  if (pendingChat) { $("#chat-preview-reply").textContent = pendingChat.response.reply; $("#chat-preview-state").textContent = formatStateProposal(pendingChat.response.state_proposal); renderMemoryCandidates(); }
}
function chatMessageOrThrow() { const message = $("#chat-message").value.trim(); if (!message) throw new Error("請先輸入想對角色說的話。"); return message; }
function memoryCandidateKey(item) { return `${item.summary}\u0000${item.importance}\u0000${item.reason}`; }
function renderMemoryCandidates() { const container = $("#chat-preview-memories"); container.innerHTML = ""; const candidates = pendingChat?.response.memory_candidates || []; if (!candidates.length) { container.textContent = "本次沒有記憶候選項。"; return; } const heading = document.createElement("p"); heading.className = "memory-heading"; heading.textContent = "記憶候選項（預設不保存；勾選後才會寫入角色資料）"; container.append(heading); candidates.forEach(candidate => { const label = document.createElement("label"); label.className = "memory-candidate"; const input = document.createElement("input"); input.type = "checkbox"; input.checked = pendingChat.selectedMemoryKeys.includes(memoryCandidateKey(candidate)); input.onchange = () => { const key = memoryCandidateKey(candidate); pendingChat.selectedMemoryKeys = input.checked ? [...pendingChat.selectedMemoryKeys, key] : pendingChat.selectedMemoryKeys.filter(item => item !== key); }; const text = document.createElement("span"); text.textContent = `[${candidate.importance}] ${candidate.summary} — ${candidate.reason}`; label.append(input, text); container.append(label); }); }
function selectedMemoryCandidates() { const selected = new Set(pendingChat?.selectedMemoryKeys || []); return (pendingChat?.response.memory_candidates || []).filter(candidate => selected.has(memoryCandidateKey(candidate))); }
function showChatPreview(userMessage, response) { pendingChat = { userMessage, response, selectedMemoryKeys: [] }; renderChat(); }
async function generateChat(event) {
  event.preventDefault();
  try {
    const userMessage = chatMessageOrThrow(); const manual = $("#chat-mode").value === "manual";
    if (manual) { const result = await api(`/api/characters/${current.character_id}/manual-chat-prompt`, { method:"POST", body:JSON.stringify({user_message:userMessage}) }); $("#manual-chat-prompt").value = result.prompt; $("#manual-chat-response").focus(); toast("完整提示詞已產生；可複製到網頁 AI。 "); }
    else { if (!modelStatus.ready) throw new Error("自動模式尚未啟用；請改用手動模式，或先在本機設定模型。"); const response = await api(`/api/characters/${current.character_id}/chat-proposal`, { method:"POST", body:JSON.stringify({user_message:userMessage}) }); showChatPreview(userMessage, response); toast("已取得回覆預覽；確認後才會保存。"); }
  } catch (error) { toast(error.message, true); }
}
async function parseManualChatResponse() { try { const userMessage = chatMessageOrThrow(); const responseText = $("#manual-chat-response").value; const response = await api(`/api/characters/${current.character_id}/parse-chat-response`, { method:"POST", body:JSON.stringify({response_text:responseText}) }); showChatPreview(userMessage, response); toast("貼回內容已通過驗證；確認後才會保存。"); } catch (error) { toast(error.message, true); } }
async function copyChatPrompt() { try { const prompt = $("#manual-chat-prompt").value; if (!prompt) throw new Error("請先產生提示詞。"); await navigator.clipboard.writeText(prompt); toast("提示詞已複製"); } catch (error) { toast(error.message, true); } }
async function applyPendingChat() { if (!pendingChat) return; try { current = await api(`/api/characters/${current.character_id}/apply-chat-turn`, { method:"POST", body:JSON.stringify({user_message:pendingChat.userMessage,response:pendingChat.response,selected_memory_candidates:selectedMemoryCandidates()}) }); pendingChat = null; $("#chat-message").value = ""; $("#manual-chat-prompt").value = ""; $("#manual-chat-response").value = ""; await refreshList(); await refreshChatTurns(); render(); toast("回合已保存至本機 SQLite"); } catch (error) { toast(error.message, true); } }
function discardPendingChat() { pendingChat = null; renderChat(); toast("尚未保存的預覽已捨棄"); }
$("#chat-form").onsubmit = generateChat; $("#chat-mode").onchange = renderChat; $("#copy-chat-prompt").onclick = copyChatPrompt; $("#parse-chat-response").onclick = parseManualChatResponse; $("#apply-chat-turn").onclick = applyPendingChat; $("#discard-chat-preview").onclick = discardPendingChat; refreshModelStatus();
