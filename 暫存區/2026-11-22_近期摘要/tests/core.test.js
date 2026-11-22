// 網頁版核心的測試。跑法：node --test tests/
// 由原本 Python 的 tests/ 改寫，檢查的規則一樣。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Core = require(path.join(__dirname, "..", "docs", "core.js"));

const {
  newCharacter, newModule, newRelationship, normalize, DEFAULT_MEMORY_SETTINGS,
  applyStateProposal, validateStateProposal, parseJsonObjectText,
  validateChatResponse, applyChatResponse, validateUserMessage, validateRelationship, characterForPrompt, buildChatPrompt,
} = Core;

// ---------- 角色資料 ----------
test("角色資料會補齊欄位，數值會被夾在範圍內", () => {
  const character = newCharacter("羅爾");
  character.state.mood = { valence: 999, arousal: -2 };
  character.state.psychological = { security: 120, anxiety: -3 };
  character.modules.push(newModule("personality"));
  const normalized = normalize(character);
  assert.equal(normalized.profile.name, "羅爾");
  assert.equal(normalized.modules[0].name, "人格特質");
  assert.deepEqual(normalized.state.mood, { valence: 100, arousal: 0 });
  assert.equal(normalized.state.psychological.security, 100);
  assert.equal(normalized.state.psychological.anxiety, 0);
  assert.equal(normalized.state.psychological.loneliness, 30);
});

test("匯入時可以換一個新 ID", () => {
  const original = normalize(newCharacter("維伊"));
  const copy = normalize(original, { generateId: true });
  assert.notEqual(copy.character_id, original.character_id);
  assert.equal(copy.profile.name, "維伊");
});

test("模組內容是陣列時會被拒絕", () => {
  const invalid = newCharacter();
  invalid.modules = [{ module_id: "m1", data: ["not an object"] }];
  assert.throws(() => normalize(invalid), /module\.data/);
});

test("記憶容量：預設值、舊資料相容、錯誤值會被拒絕", () => {
  assert.deepEqual(newCharacter("北").memory_settings, DEFAULT_MEMORY_SETTINGS);
  const legacy = newCharacter("舊角色"); delete legacy.memory_settings;
  assert.deepEqual(normalize(legacy).memory_settings, DEFAULT_MEMORY_SETTINGS);
  const invalid = newCharacter("設定錯誤"); invalid.memory_settings.ordinary.max_items = 0;
  assert.throws(() => normalize(invalid), /max_items/);
});

test("模組文字會保留，舊格式模組補上空白文字、舊內容不動", () => {
  const character = newCharacter();
  const module = newModule("free"); module.text = "話不多，但很會觀察人。";
  const oldStyle = { module_id: "m_old", type: "values", name: "價值觀", enabled: true, data: { 核心: "誠實" }, notes: "" };
  character.modules = [module, oldStyle];
  const normalized = normalize(character);
  assert.equal(normalized.modules[0].name, "自由描述");
  assert.equal(normalized.modules[0].text, "話不多，但很會觀察人。");
  assert.equal(normalized.modules[1].text, "");
  assert.deepEqual(normalized.modules[1].data, { 核心: "誠實" });
});

test("用 Python 舊版匯出的角色（沒有 text 欄位）也讀得進來", () => {
  const legacy = { schema_version: "0.1", character_id: "character_abc", profile: { name: "舊的" }, modules: [{ module_id: "m", type: "personality", name: "人格特質", enabled: true, data: {}, notes: "" }], state: { mood: { valence: 10.0, arousal: 30.0 } } };
  const normalized = normalize(legacy);
  assert.equal(normalized.character_id, "character_abc");
  assert.equal(normalized.modules[0].text, "");
  assert.deepEqual(normalized.memories, []);
});

// ---------- 給 AI 的提示詞 ----------
test("提示詞只放開著、有寫內容的模組", () => {
  const character = newCharacter();
  const written = newModule("personality"); written.text = "溫和、慢熱。";
  const empty = newModule("values");
  const turnedOff = newModule("trauma"); turnedOff.text = "小時候被丟下過。"; turnedOff.enabled = false;
  const oldStyle = newModule("goals"); oldStyle.data = { 目標: "存錢開店" };
  character.modules = [written, empty, turnedOff, oldStyle];
  const view = characterForPrompt(character);
  assert.deepEqual(view.modules.map((item) => item.name), ["人格特質", "需求與目標"]);
  assert.equal(view.modules[0].text, "溫和、慢熱。");
  assert.equal(character.modules[1].name, "價值觀");
  const prompt = buildChatPrompt(character, [], "嗨");
  assert.ok(prompt.includes("溫和、慢熱。"));
  assert.ok(!prompt.includes("小時候被丟下過"));
});

// ---------- 心理數值提案 ----------
test("合格的數值提案只會改到心理狀態", () => {
  const character = newCharacter("布萊克");
  const updated = applyStateProposal(character, { summary: "警戒感升高。", state_patch: { mood: { valence: -20 }, psychological: { anxiety: 68 } } });
  assert.equal(updated.state.mood.valence, -20);
  assert.equal(updated.state.psychological.anxiety, 68);
  assert.deepEqual(updated.profile, character.profile);
  assert.ok(updated.state.last_updated);
});

test("貼回的內容被 ```json 包住也能解析", () => {
  const parsed = parseJsonObjectText('```json\n{"summary":"稍微放鬆。","state_patch":{"mood":{"arousal":28}}}\n```');
  assert.equal(validateStateProposal(parsed).state_patch.mood.arousal, 28);
});

for (const proposal of [
  { summary: "x", state_patch: { profile: { name: "遭竄改" } } },
  { summary: "x", state_patch: { mood: { valence: 101 } } },
  { summary: "x", state_patch: { psychological: { memory: 1 } } },
  { summary: "x", state_patch: { emotions: { fear: "high" } } },
]) {
  test(`不合格的數值提案會被拒絕：${JSON.stringify(proposal.state_patch)}`, () => {
    assert.throws(() => validateStateProposal(proposal));
  });
}

// ---------- 聊天回合 ----------
test("聊天回覆：保留回話、套用合格提案、存勾選的記憶", () => {
  const character = newCharacter("羅爾");
  const memory = { summary: "對方願意等待。", importance: "ordinary", reason: "這次互動明確提及。" };
  const { updated, response, selected } = applyChatResponse(character, { reply: "我想先想一想。", state_proposal: { summary: "警戒感略升。", state_patch: { psychological: { anxiety: 42 } } }, memory_candidates: [memory] }, [memory]);
  assert.equal(response.reply, "我想先想一想。");
  assert.equal(updated.state.psychological.anxiety, 42);
  assert.deepEqual(updated.profile, character.profile);
  assert.equal(selected[0].importance, "ordinary");
  assert.equal(updated.memories[0].summary, "對方願意等待。");
  assert.equal(character.memories.length, 0);
});

for (const response of [
  { reply: "x", state_proposal: null, memory_candidates: [], profile: {} },
  { reply: "", state_proposal: null, memory_candidates: [] },
  { reply: "x", state_proposal: { summary: "x", state_patch: { profile: {} } }, memory_candidates: [] },
]) {
  test(`不安全的聊天回覆會被拒絕：${JSON.stringify(response).slice(0, 60)}`, () => {
    assert.throws(() => validateChatResponse(response));
  });
}

test("訊息不能是空白", () => {
  assert.equal(validateUserMessage("  你好  "), "你好");
  assert.throws(() => validateUserMessage("  "));
});

test("舊格式回覆（沒有記憶候選項）還是能用", () => {
  assert.deepEqual(validateChatResponse({ reply: "舊格式仍可使用。", state_proposal: null }).memory_candidates, []);
});

test("AI 沒提出的記憶不能偷存", () => {
  assert.throws(() => applyChatResponse(newCharacter("維伊"), { reply: "嗯。", state_proposal: null, memory_candidates: [] }, [{ summary: "不存在的候選項", importance: "ordinary", reason: "不應保存。" }]), /只能保存/);
});

test("記憶滿了只會拒絕新增，不會刪舊記憶", () => {
  const character = newCharacter("羅爾");
  character.memory_settings.ordinary = { max_items: 1, max_chars: 40 };
  character.memories = [{ summary: "已保存", importance: "ordinary", reason: "舊記憶" }];
  const offered = { summary: "新記憶", importance: "ordinary", reason: "本回合。" };
  assert.throws(() => applyChatResponse(character, { reply: "嗯。", state_proposal: null, memory_candidates: [offered] }, [offered]), /不會自動刪除/);
  assert.deepEqual(character.memories, [{ summary: "已保存", importance: "ordinary", reason: "舊記憶" }]);
});

// ---------- 關係 ----------
test("關係有五個維度，能通過檢查", () => {
  const relationship = newRelationship("維伊");
  const validated = validateRelationship({ target_name: relationship.target_name, target_type: relationship.target_type, dimensions: relationship.dimensions, notes: relationship.notes }, relationship.relationship_id);
  assert.equal(validated.target_name, "維伊");
  assert.deepEqual(Object.keys(validated.dimensions).sort(), ["dependence", "intimacy", "safety", "trust", "wariness"]);
});

for (const dimensions of [{ trust: 50 }, { trust: 50, intimacy: 50, safety: 50, dependence: 50, wariness: 101 }]) {
  test(`關係維度不完整或超出範圍會被拒絕：${JSON.stringify(dimensions)}`, () => {
    assert.throws(() => validateRelationship({ target_name: "某人", target_type: "person", dimensions, notes: "" }));
  });
}

// ---------- 隱藏內心（2026-11-22） ----------
test("心裡沒說出口的話會被保留，沒寫就是空的", () => {
  const clean = validateChatResponse({ reply: "沒事啊。", inner_thought: "  他剛剛是不是在試探我……先別表現出來。 ", state_proposal: null, memory_candidates: [] });
  assert.equal(clean.inner_thought, "他剛剛是不是在試探我……先別表現出來。");
  assert.equal(validateChatResponse({ reply: "嗯。", state_proposal: null }).inner_thought, "");
});

test("心裡的話格式不對會被拒絕", () => {
  assert.throws(() => validateChatResponse({ reply: "嗯。", inner_thought: { secret: 1 }, state_proposal: null }), /inner_thought/);
  assert.throws(() => validateChatResponse({ reply: "嗯。", inner_thought: "很".repeat(2001), state_proposal: null }), /inner_thought/);
  assert.throws(() => validateChatResponse({ reply: "嗯。", inner_thought: "" }), /只能包含/);
});

test("提示詞會請 AI 寫心裡的話，並把之前沒說出口的想法一起送回去", () => {
  const prompt = buildChatPrompt(newCharacter("維伊"), [{ user_message: "你今天怪怪的", character_reply: "有嗎？", inner_thought: "他是不是發現我在生氣" }], "真的沒事？");
  assert.match(prompt, /"inner_thought"/);
  assert.match(prompt, /他是不是發現我在生氣/);
});

// ---------- 時間、回溯、新聊天（2026-11-22） ----------
const { currentChatId, turnsInChat, startNewChat, freshCopy, snapshotOf, trimSnapshots, rewindKind, rewind, REWIND_LIMIT } = Core;

test("時間關著：送給 AI 的資料沒有任何時間", () => {
  const character = normalize(newCharacter("維伊"));
  const prompt = buildChatPrompt(character, [{ id: "t1", created_at: "2026-11-20T10:00:00.000Z", user_message: "嗨", character_reply: "嗯", before: snapshotOf(character) }], "在嗎");
  assert.doesNotMatch(prompt, /created_at|updated_at|2026-11-20|"time"/);
  assert.doesNotMatch(prompt, /"before"/);
  assert.match(prompt, /沒有現實時間/);
});

test("時間開著：有現在時間和每句的時間；選「剛剛」時，之前的對話算在打開那一刻", () => {
  const character = normalize({ ...newCharacter("維伊"), chat_settings: { real_time: true, time_since: "2026-11-22T12:00:00.000Z" } });
  const turns = [
    { id: "a", created_at: "2026-09-01T12:00:00.000Z", user_message: "很久以前", character_reply: "嗯" },
    { id: "b", created_at: "2026-11-22T13:00:00.000Z", user_message: "剛剛", character_reply: "嗯" },
  ];
  const view = Core.turnsForPrompt(character, turns);
  assert.equal(view[0].time, Core.describeTime("2026-11-22T12:00:00.000Z"));
  assert.equal(view[1].time, Core.describeTime("2026-11-22T13:00:00.000Z"));
  assert.match(buildChatPrompt(character, turns, "在嗎", { now: "2026-11-22T14:00:00.000Z" }), /現在的現實時間是/);
});

test("開新聊天：舊對話留在舊視窗，新視窗是空的", () => {
  const character = normalize(newCharacter("維伊"));
  assert.equal(currentChatId(character), "chat_first");
  const next = startNewChat(character);
  assert.equal(next.chats.length, 2);
  assert.notEqual(currentChatId(next), "chat_first");
  const turns = [{ id: "a", user_message: "舊的", character_reply: "嗯" }];
  assert.equal(turnsInChat(turns, "chat_first").length, 1);
  assert.equal(turnsInChat(turns, currentChatId(next)).length, 0);
});

test("不沿用記憶：複製的新角色沒有記憶、心情回初始，原本的不受影響", () => {
  const character = normalize(newCharacter("維伊"));
  character.memories.push(Core.newMemory("一起看過海", "core", "很重要"));
  character.state.mood.valence = -80;
  const copy = freshCopy(character);
  assert.notEqual(copy.character_id, character.character_id);
  assert.equal(copy.profile.name, "維伊（新的開始）");
  assert.equal(copy.memories.length, 0);
  assert.equal(copy.state.mood.valence, 0);
  assert.equal(character.memories.length, 1);
});

test("回溯：心情和記憶退回講這句之前，這句和後面的對話消失", () => {
  const start = normalize(newCharacter("維伊"));
  const after1 = Core.clone(start); after1.state.mood.valence = -50; after1.memories.push(Core.newMemory("他好像在試探我", "important", "誤會"));
  const turns = [
    { id: "t1", user_message: "第一句", character_reply: "嗯", before: snapshotOf(start) },
    { id: "t2", user_message: "第二句", character_reply: "喔", before: snapshotOf(after1) },
  ];
  const result = rewind(after1, turns, "t1");
  assert.equal(result.kind, "full");
  assert.equal(result.turns.length, 0);
  assert.equal(result.removed, 2);
  assert.equal(result.message, "第一句");
  assert.equal(result.character.state.mood.valence, 0);
  assert.equal(result.character.memories.length, 0);
});

test("回溯：舊對話沒存當時的樣子，只能退文字；舊視窗和太早的不能回溯", () => {
  const character = normalize(newCharacter("維伊"));
  const turns = [{ id: "old", user_message: "舊", character_reply: "嗯" }];
  assert.equal(rewindKind(character, turns, "old"), "text");
  assert.equal(rewindKind(startNewChat(character), turns, "old"), null);
  const many = Array.from({ length: REWIND_LIMIT + 5 }, (_, i) => ({ id: `t${i}`, user_message: String(i), character_reply: "嗯", before: snapshotOf(character) }));
  assert.equal(rewindKind(character, many, "t0"), null);
  assert.equal(rewindKind(character, many, `t${REWIND_LIMIT + 4}`), "full");
  const trimmed = trimSnapshots(many, "chat_first");
  assert.equal(trimmed.filter((turn) => "before" in turn).length, REWIND_LIMIT);
});
