// EmoCara 核心：資料整理、驗證、提示詞。
// 由原本 Python 的 app/schemas.py、interactions.py、state_proposals.py、relationships.py、model_interface.py 改寫。
// 規則不變：AI 只能「提案」，這裡驗證過、使用者按確認之後，才會存進角色資料。
(function (root) {
  "use strict";

  const SCHEMA_VERSION = "0.1";
  const CHAT_CONTRACT_VERSION = "chat_turn/v0.2";
  const MAX_MESSAGE_LENGTH = 4000;
  const MAX_REPLY_LENGTH = 6000;
  const MAX_MEMORY_CANDIDATES = 3;
  const MAX_MEMORY_TEXT_LENGTH = 1000;

  const DEFAULT_PROFILE = {
    name: "未命名角色", aliases: [], age: null, gender: null,
    pronouns: null, background: "", appearance: "", occupation: "",
    current_situation: "", other_information: {},
  };
  const DEFAULT_STATE = {
    mood: { valence: 0, arousal: 30 }, emotions: {},
    psychological: { security: 50, anxiety: 30, loneliness: 30, emotional_stability: 50 },
    custom_metrics: {}, last_updated: null,
  };
  const PRESET_MODULES = {
    free: "自由描述",
    personality: "人格特質", values: "價值觀", attachment: "依附與親密關係",
    trauma: "創傷與負面經歷", coping: "防衛與應對機制",
    communication: "溝通方式", goals: "需求與目標", boundaries: "個人界線",
    custom: "自訂模組",
  };
  // 角色頁每個模組上方的引導問題；只是提示，不會送給 AI。
  const MODULE_GUIDES = {
    free: "想到什麼就寫什麼。不知道該放哪一格的，也可以寫在這裡。",
    personality: "他平常是個什麼樣的人？",
    values: "他覺得什麼最重要？什麼事他看不起？",
    attachment: "他靠近別人的時候是什麼樣子？",
    trauma: "有什麼過去，到現在還影響著他？",
    coping: "難受的時候，他會怎麼處理？",
    communication: "他說話是什麼樣子？直接、繞圈、還是愛開玩笑？",
    goals: "他現在想要什麼？缺什麼？",
    boundaries: "什麼事他絕對不讓人碰？",
    custom: "這個模組想寫什麼都可以。",
  };
  const MEMORY_IMPORTANCE = ["ordinary", "important", "core"];
  const DEFAULT_MEMORY_SETTINGS = {
    core: { max_items: 5, max_chars: 200 },
    important: { max_items: 15, max_chars: 120 },
    ordinary: { max_items: 30, max_chars: 60 },
  };
  const RELATIONSHIP_DIMENSIONS = ["trust", "intimacy", "safety", "dependence", "wariness"];

  // ---------- 小工具 ----------
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const timestamp = () => new Date().toISOString();
  const hexId = () => {
    if (root.crypto && typeof root.crypto.randomUUID === "function") return root.crypto.randomUUID().replace(/-/g, "");
    let out = ""; for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16); return out;
  };
  const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const objectOr = (value, fallback) => (isObject(value) ? value : clone(fallback));
  const isFiniteNumber = (value) => typeof value === "number" && Number.isFinite(value);
  const sameKeys = (obj, keys) => { const a = Object.keys(obj).sort(), b = [...keys].sort(); return a.length === b.length && a.every((k, i) => k === b[i]); };

  // ---------- 建立新資料 ----------
  function newCharacter(name = "未命名角色") {
    const profile = clone(DEFAULT_PROFILE);
    profile.name = String(name || "").trim() || "未命名角色";
    const now = timestamp();
    return {
      schema_version: SCHEMA_VERSION,
      character_id: `character_${hexId()}`,
      profile,
      modules: [],
      state: clone(DEFAULT_STATE),
      memories: [],
      memory_settings: clone(DEFAULT_MEMORY_SETTINGS),
      relationships: [],
      metadata: { created_at: now, updated_at: now, tags: [], import_source: null },
    };
  }

  function newModule(type, name) {
    const chosen = String(type || "").trim() || "custom";
    return {
      module_id: `module_${hexId()}`, type: chosen,
      name: String(name || PRESET_MODULES[chosen] || chosen).trim(),
      enabled: true, text: "", data: {}, notes: "",
    };
  }

  function newMemory(summary, importance, reason, source = "chat") {
    return {
      memory_id: `memory_${hexId()}`, summary, importance, reason, source,
      created_at: timestamp(), last_recalled_at: null, status: "active", tags: [],
    };
  }

  function newRelationship(targetName = "未命名對象") {
    const now = timestamp();
    const dimensions = {}; RELATIONSHIP_DIMENSIONS.forEach((key) => { dimensions[key] = 50; });
    return {
      relationship_id: `relationship_${hexId()}`,
      target_name: String(targetName || "").trim() || "未命名對象",
      target_type: "person", dimensions, notes: "", created_at: now, updated_at: now,
    };
  }

  // ---------- 整理角色資料（讀進來、存檔前都會跑） ----------
  function normalizeMemorySettings(value) {
    const raw = objectOr(value, DEFAULT_MEMORY_SETTINGS);
    const clean = {};
    for (const [importance, defaults] of Object.entries(DEFAULT_MEMORY_SETTINGS)) {
      const tier = objectOr(raw[importance], defaults);
      clean[importance] = {};
      for (const [key, fallback] of Object.entries(defaults)) {
        const item = key in tier ? tier[key] : fallback;
        if (!Number.isInteger(item)) throw new Error(`memory_settings.${importance}.${key} 必須是整數。`);
        const [lower, upper] = key === "max_items" ? [1, 500] : [40, 5000];
        if (item < lower || item > upper) throw new Error(`memory_settings.${importance}.${key} 必須介於 ${lower} 到 ${upper}。`);
        clean[importance][key] = item;
      }
    }
    return clean;
  }

  function normalize(document, { generateId = false } = {}) {
    if (!isObject(document)) throw new Error("角色資料必須是一個 JSON 物件。");
    const result = clone(document);
    result.schema_version = String(result.schema_version || SCHEMA_VERSION);
    if (generateId || typeof result.character_id !== "string" || !result.character_id.trim()) result.character_id = `character_${hexId()}`;

    const profile = objectOr(result.profile, DEFAULT_PROFILE);
    for (const [key, value] of Object.entries(DEFAULT_PROFILE)) if (!(key in profile)) profile[key] = clone(value);
    if (!Array.isArray(profile.aliases)) profile.aliases = [];
    if (!isObject(profile.other_information)) profile.other_information = {};
    profile.name = String(profile.name || "未命名角色");
    result.profile = profile;

    const state = objectOr(result.state, DEFAULT_STATE);
    for (const [key, value] of Object.entries(DEFAULT_STATE)) if (!(key in state)) state[key] = clone(value);
    state.mood = objectOr(state.mood, DEFAULT_STATE.mood);
    state.psychological = objectOr(state.psychological, DEFAULT_STATE.psychological);
    state.emotions = objectOr(state.emotions, {});
    state.custom_metrics = objectOr(state.custom_metrics, {});
    const clampNumber = (value, fallback, lower, upper) => {
      const number = value === undefined || value === null ? fallback : Number(value);
      if (typeof value === "boolean" || !Number.isFinite(number)) throw new Error("預設心理指標必須是數字。");
      return Math.max(lower, Math.min(upper, number));
    };
    state.mood.valence = clampNumber(state.mood.valence, 0, -100, 100);
    state.mood.arousal = clampNumber(state.mood.arousal, 30, 0, 100);
    for (const key of Object.keys(DEFAULT_STATE.psychological)) {
      state.psychological[key] = clampNumber(state.psychological[key], DEFAULT_STATE.psychological[key], 0, 100);
    }
    result.state = state;

    const modules = result.modules === undefined ? [] : result.modules;
    if (!Array.isArray(modules)) throw new Error("modules 必須是陣列。");
    result.modules = modules.map((module) => {
      if (!isObject(module)) throw new Error("每個模組必須是 JSON 物件。");
      const clean = clone(module);
      if (!("module_id" in clean)) clean.module_id = `module_${hexId()}`;
      if (!("type" in clean)) clean.type = "custom";
      if (!("name" in clean)) clean.name = PRESET_MODULES[String(clean.type)] || String(clean.type);
      if (!("enabled" in clean)) clean.enabled = true;
      if (!("data" in clean)) clean.data = {};
      if (!("notes" in clean)) clean.notes = "";
      if (!isObject(clean.data)) throw new Error("module.data 必須是 JSON 物件。");
      clean.enabled = Boolean(clean.enabled);
      // text 是模組的主要內容（用講的）；data 保留給舊格式的 JSON 內容，不會被刪除。
      clean.text = typeof clean.text === "string" ? clean.text : "";
      return clean;
    });
    result.memories = Array.isArray(result.memories) ? result.memories : [];
    result.memory_settings = normalizeMemorySettings(result.memory_settings);
    result.relationships = Array.isArray(result.relationships) ? result.relationships : [];
    const metadata = objectOr(result.metadata, {});
    if (!("created_at" in metadata)) metadata.created_at = timestamp();
    if (!("updated_at" in metadata)) metadata.updated_at = timestamp();
    result.metadata = metadata;
    return result;
  }

  // ---------- 心理數值提案 ----------
  function checkNumber(value, label, lower, upper) {
    if (!isFiniteNumber(value)) throw new Error(`${label} 必須是有限數字。`);
    if ((lower !== undefined && value < lower) || (upper !== undefined && value > upper)) throw new Error(`${label} 必須介於 ${lower} 到 ${upper}。`);
    return value;
  }
  function numericMapping(value, label, lower, upper) {
    if (!isObject(value)) throw new Error(`${label} 必須是 JSON 物件。`);
    const clean = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key.trim()) throw new Error(`${label} 的名稱必須是非空白文字。`);
      clean[key] = checkNumber(item, `${label}.${key}`, lower, upper);
    }
    return clean;
  }

  function validateStateProposal(proposal) {
    if (!isObject(proposal)) throw new Error("模型提案必須是 JSON 物件。");
    if (!sameKeys(proposal, ["summary", "state_patch"])) throw new Error("模型提案只能包含 summary 與 state_patch。");
    const summary = proposal.summary;
    if (typeof summary !== "string" || !summary.trim() || summary.length > 1000) throw new Error("模型提案的 summary 必須是 1 至 1000 字元的文字。");
    const patch = proposal.state_patch;
    if (!isObject(patch) || !Object.keys(patch).length) throw new Error("state_patch 必須是非空的 JSON 物件。");
    const allowed = ["mood", "psychological", "emotions", "custom_metrics"];
    const unknown = Object.keys(patch).filter((key) => !allowed.includes(key)).sort();
    if (unknown.length) throw new Error(`state_patch 含有不允許的欄位：${unknown.join(", ")}。`);
    const clean = {};
    if ("mood" in patch) {
      const mood = numericMapping(patch.mood, "mood");
      if (Object.keys(mood).some((key) => !["valence", "arousal"].includes(key))) throw new Error("mood 只能包含 valence 與 arousal。");
      clean.mood = {};
      for (const [key, value] of Object.entries(mood)) clean.mood[key] = checkNumber(value, `mood.${key}`, key === "valence" ? -100 : 0, 100);
    }
    if ("psychological" in patch) {
      const psychological = numericMapping(patch.psychological, "psychological", 0, 100);
      if (Object.keys(psychological).some((key) => !(key in DEFAULT_STATE.psychological))) throw new Error("psychological 含有不允許的指標。");
      clean.psychological = psychological;
    }
    if ("emotions" in patch) clean.emotions = numericMapping(patch.emotions, "emotions", 0, 100);
    if ("custom_metrics" in patch) clean.custom_metrics = numericMapping(patch.custom_metrics, "custom_metrics");
    if (!Object.values(clean).some((section) => Object.keys(section).length)) throw new Error("state_patch 至少要包含一項數值變化。");
    return { summary: summary.trim(), state_patch: clean };
  }

  function applyStateProposal(character, proposal) {
    const clean = validateStateProposal(proposal);
    const updated = clone(character);
    for (const [section, values] of Object.entries(clean.state_patch)) Object.assign(updated.state[section], values);
    updated.state.last_updated = timestamp();
    return normalize(updated);
  }

  // ---------- 聊天回合 ----------
  function validateUserMessage(message) {
    if (typeof message !== "string") throw new Error("訊息必須是文字。");
    const clean = message.trim();
    if (!clean) throw new Error("訊息不能是空白。");
    if (clean.length > MAX_MESSAGE_LENGTH) throw new Error(`訊息不可超過 ${MAX_MESSAGE_LENGTH} 個字元。`);
    return clean;
  }

  function validateMemoryCandidate(candidate) {
    if (!isObject(candidate) || !sameKeys(candidate, ["summary", "importance", "reason"])) throw new Error("每筆記憶候選項只能包含 summary、importance 與 reason。");
    const values = {};
    for (const key of ["summary", "reason"]) {
      const value = candidate[key];
      if (typeof value !== "string" || !value.trim() || value.trim().length > MAX_MEMORY_TEXT_LENGTH) throw new Error(`記憶候選項的 ${key} 必須是 1 至 ${MAX_MEMORY_TEXT_LENGTH} 個字元的文字。`);
      values[key] = value.trim();
    }
    if (!MEMORY_IMPORTANCE.includes(candidate.importance)) throw new Error("記憶候選項的 importance 只能是 ordinary、important 或 core。");
    values.importance = candidate.importance;
    return { summary: values.summary, importance: values.importance, reason: values.reason };
  }

  const memoryKey = (item) => `${item.summary}\u0000${item.importance}\u0000${item.reason}`;

  function validateMemoryCandidates(candidates) {
    if (!Array.isArray(candidates) || candidates.length > MAX_MEMORY_CANDIDATES) throw new Error(`memory_candidates 必須是至多 ${MAX_MEMORY_CANDIDATES} 筆的陣列。`);
    const clean = candidates.map(validateMemoryCandidate);
    if (new Set(clean.map(memoryKey)).size !== clean.length) throw new Error("記憶候選項不可重複。");
    return clean;
  }

  function validateMemoryCapacity(character, selected) {
    // 依角色自己的設定限制新記憶；不會刪除或改寫任何既有記憶。
    const settings = normalizeMemorySettings(character.memory_settings);
    const existing = Array.isArray(character.memories) ? character.memories : [];
    for (const importance of MEMORY_IMPORTANCE) {
      const tier = settings[importance];
      const pending = selected.filter((item) => item.importance === importance);
      const current = existing.filter((item) => isObject(item) && item.importance === importance).length;
      if (current + pending.length > tier.max_items) throw new Error(`${importance} 記憶已達 ${tier.max_items} 筆上限；本次不會自動刪除舊記憶。`);
      for (const item of pending) if (item.summary.length + item.reason.length > tier.max_chars) throw new Error(`${importance} 記憶文字超過每筆 ${tier.max_chars} 字元上限。`);
    }
  }

  function validateChatResponse(response) {
    if (!isObject(response)) throw new Error("互動回覆必須是 JSON 物件。");
    if (!sameKeys(response, ["reply", "state_proposal"]) && !sameKeys(response, ["reply", "state_proposal", "memory_candidates"])) throw new Error("互動回覆只能包含 reply、state_proposal 與 memory_candidates。");
    const reply = response.reply;
    if (typeof reply !== "string" || !reply.trim() || reply.trim().length > MAX_REPLY_LENGTH) throw new Error(`reply 必須是 1 至 ${MAX_REPLY_LENGTH} 個字元的文字。`);
    const proposal = response.state_proposal;
    return {
      reply: reply.trim(),
      state_proposal: proposal === null ? null : validateStateProposal(proposal),
      memory_candidates: validateMemoryCandidates(response.memory_candidates === undefined ? [] : response.memory_candidates),
    };
  }

  // 回傳：更新後的角色（還沒存）、驗證過的回覆、要存的記憶。
  function applyChatResponse(character, response, selectedMemoryCandidates) {
    const clean = validateChatResponse(response);
    const selected = validateMemoryCandidates(selectedMemoryCandidates);
    const available = new Set(clean.memory_candidates.map(memoryKey));
    if (selected.some((item) => !available.has(memoryKey(item)))) throw new Error("只能保存本次回覆提出的記憶候選項。");
    validateMemoryCapacity(character, selected);
    const updated = clean.state_proposal ? applyStateProposal(character, clean.state_proposal) : clone(character);
    for (const item of selected) updated.memories.push(newMemory(item.summary, item.importance, item.reason));
    return { updated, response: clean, selected };
  }

  // ---------- 關係 ----------
  function validateRelationship(value, relationshipId) {
    if (!isObject(value)) throw new Error("關係資料必須是 JSON 物件。");
    if (!sameKeys(value, ["target_name", "target_type", "dimensions", "notes"])) throw new Error("關係資料只能包含 target_name、target_type、dimensions 與 notes。");
    const { target_name: targetName, target_type: targetType, notes, dimensions } = value;
    if (typeof targetName !== "string" || !targetName.trim() || targetName.trim().length > 200) throw new Error("對象名稱必須是 1 至 200 個字元的文字。");
    if (typeof targetType !== "string" || !targetType.trim() || targetType.trim().length > 100) throw new Error("對象類型必須是 1 至 100 個字元的文字。");
    if (typeof notes !== "string" || notes.length > 4000) throw new Error("備註不能超過 4000 個字元。");
    if (!isObject(dimensions) || !sameKeys(dimensions, RELATIONSHIP_DIMENSIONS)) throw new Error("關係必須包含信任、親密、安全感、依賴與戒心五個維度。");
    const clean = {};
    for (const key of RELATIONSHIP_DIMENSIONS) {
      const number = dimensions[key];
      if (!isFiniteNumber(number) || number < 0 || number > 100) throw new Error(`${key} 必須是 0 至 100 的數字。`);
      clean[key] = number;
    }
    return {
      relationship_id: relationshipId || `relationship_${hexId()}`,
      target_name: targetName.trim(), target_type: targetType.trim(),
      dimensions: clean, notes, updated_at: timestamp(),
    };
  }

  // ---------- 給 AI 的提示詞 ----------
  // 給 AI 看的角色資料：只放開著、而且有寫內容的模組，空白模組直接跳過。
  function characterForPrompt(character) {
    const view = clone(character);
    const modules = [];
    for (const module of character.modules || []) {
      if (!isObject(module) || module.enabled === false) continue;
      const text = typeof module.text === "string" ? module.text.trim() : "";
      const data = isObject(module.data) ? module.data : {};
      if (!text && !Object.keys(data).length) continue;
      const item = { name: module.name || "" };
      if (text) item.text = text;
      if (Object.keys(data).length) item.data = data;
      if (typeof module.notes === "string" && module.notes.trim()) item.notes = module.notes.trim();
      modules.push(item);
    }
    view.modules = modules;
    return view;
  }

  function buildChatPrompt(character, recentTurns, userMessage) {
    const supplied = JSON.stringify({ character: characterForPrompt(character), recent_turns: recentTurns, user_message: userMessage });
    return `你是角色互動模擬器。請以角色自己的觀點、界線和語氣回覆使用者，
不得臆測輸入資料沒有的事實，也不必迎合使用者。你不是資料庫，不能修改角色的
profile、modules、memories、relationships 或 metadata。

只回傳 JSON 物件，不要 Markdown 或額外文字。格式必須是：
{
  "reply": "角色對使用者說的話",
  "state_proposal": null 或 {
    "summary": "簡短說明",
    "state_patch": {
      "mood": {"valence": -100 到 100，"arousal": 0 到 100},
      "psychological": {"security": 0 到 100，"anxiety": 0 到 100，"loneliness": 0 到 100，"emotional_stability": 0 到 100},
      "emotions": {"可選情緒名稱": 0 到 100},
      "custom_metrics": {"可選指標名稱": 有限數字}
    }
  },
  "memory_candidates": [
    {"summary": "值得保存的互動事實或感受", "importance": "ordinary、important 或 core", "reason": "為何值得保留"}
  ]
}
state_proposal 只在這次對話確有足夠依據的心理數值變化時提出；否則填 null。
即使提出提案，它也必須等待程式驗證與使用者確認才可能保存。
memory_candidates 最多三筆，只記錄本次對話明確出現且有長期意義的事；沒有則回傳 []。
這些只是候選項，使用者可能不選擇保存，且不得將它們當作已保存記憶。
角色資料中的 memory_settings 是各層級的筆數與每筆文字上限；候選項必須遵守它。

輸入資料：
${supplied}`;
  }

  // 解析 AI 回傳的 JSON；網頁版 AI 常用 ```json 包起來，也接受。
  function parseJsonObjectText(text) {
    if (typeof text !== "string" || !text.trim()) throw new Error("沒有收到 AI 的回覆文字。");
    let candidate = text.trim();
    if (candidate.startsWith("```") && candidate.endsWith("```")) {
      const lines = candidate.split(/\r?\n/);
      if (lines.length >= 3) candidate = lines.slice(1, -1).join("\n").trim();
    }
    let value;
    try { value = JSON.parse(candidate); } catch { throw new Error("AI 的回覆不是有效的 JSON。請確認整段都有複製到。"); }
    if (!isObject(value)) throw new Error("AI 的回覆必須是一個 JSON 物件（用 { } 包起來）。");
    return value;
  }

  const api = {
    SCHEMA_VERSION, CHAT_CONTRACT_VERSION, PRESET_MODULES, MODULE_GUIDES, MEMORY_IMPORTANCE,
    DEFAULT_MEMORY_SETTINGS, RELATIONSHIP_DIMENSIONS,
    clone, timestamp, newCharacter, newModule, newMemory, newRelationship,
    normalize, normalizeMemorySettings, validateStateProposal, applyStateProposal,
    validateUserMessage, validateMemoryCandidates, validateMemoryCapacity, validateChatResponse, applyChatResponse,
    validateRelationship, characterForPrompt, buildChatPrompt, parseJsonObjectText, memoryKey,
  };
  root.EmoCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
