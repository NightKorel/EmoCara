// EmoCara 存取層：角色和對話存在「這台裝置的瀏覽器」裡（localStorage）。
// 以後如果要改成同步到私人 repo，只要換掉這個檔案，保持下面這些函式名稱一樣就好。
(function (root) {
  "use strict";
  const PREFIX = "emocara:";
  const CHARACTER = `${PREFIX}character:`;
  const TURNS = `${PREFIX}turns:`;
  const SETTINGS = `${PREFIX}settings`;

  function storage() {
    try { return root.localStorage; } catch { throw new Error("這個瀏覽器不讓網頁存資料（可能是無痕模式）。請換一般模式再開。"); }
  }
  function read(key, fallback) {
    const raw = storage().getItem(key);
    if (raw === null) return fallback;
    try { return JSON.parse(raw); } catch { return fallback; }
  }
  function write(key, value) {
    try { storage().setItem(key, JSON.stringify(value)); }
    catch (error) {
      if (error && (error.name === "QuotaExceededError" || error.code === 22)) throw new Error("瀏覽器的儲存空間滿了，這次沒有存進去。請先匯出備份，再刪掉用不到的角色。");
      throw error;
    }
  }
  function keys(prefix) {
    const s = storage(), out = [];
    for (let i = 0; i < s.length; i++) { const key = s.key(i); if (key && key.startsWith(prefix)) out.push(key); }
    return out;
  }

  const store = {
    listCharacters() {
      return keys(CHARACTER)
        .map((key) => read(key, null))
        .filter(Boolean)
        .map((doc) => { const turns = read(TURNS + doc.character_id, []), last = Array.isArray(turns) && turns.length ? turns[turns.length - 1] : null; return { id: doc.character_id, name: doc.profile?.name || "未命名角色", created_at: doc.metadata?.created_at, updated_at: doc.metadata?.updated_at, last_chat_at: last?.created_at || null }; })
        .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
    },
    getCharacter(id) { return read(CHARACTER + id, null); },
    exists(id) { return storage().getItem(CHARACTER + id) !== null; },
    // keepTime：匯入時保留檔案裡的修改時間，才看得出哪一份比較新。
    saveCharacter(document, { keepTime = false } = {}) {
      const doc = root.EmoCore.clone(document);
      const now = root.EmoCore.timestamp();
      doc.metadata = doc.metadata || {};
      if (!doc.metadata.created_at) doc.metadata.created_at = now;
      if (!keepTime || !doc.metadata.updated_at) doc.metadata.updated_at = now;
      write(CHARACTER + doc.character_id, doc);
      return doc;
    },
    deleteCharacter(id) { storage().removeItem(CHARACTER + id); storage().removeItem(TURNS + id); },
    listTurns(id, limit = 30) { const turns = read(TURNS + id, []); return Array.isArray(turns) ? turns.slice(-limit) : []; },
    allTurns(id) { const turns = read(TURNS + id, []); return Array.isArray(turns) ? turns : []; },
    replaceTurns(id, turns) { write(TURNS + id, Array.isArray(turns) ? turns : []); },
    // 角色和這一回合一起存；先存回合，角色存失敗就把回合退掉，兩邊不會對不上。
    saveTurn(document, turn) {
      const id = document.character_id;
      const before = store.allTurns(id);
      const record = { id: `turn_${(root.crypto?.randomUUID?.() || String(Date.now())).replace(/-/g, "")}`, created_at: root.EmoCore.timestamp(), ...turn };
      write(TURNS + id, [...before, record]);
      try { return store.saveCharacter(document); }
      catch (error) { write(TURNS + id, before); throw error; }
    },
    // 回溯、開新聊天用：整份對話紀錄和角色一起換掉；角色存失敗就把對話紀錄換回去。
    saveTurnsAndCharacter(document, turns) {
      const id = document.character_id;
      const before = store.allTurns(id);
      write(TURNS + id, Array.isArray(turns) ? turns : []);
      try { return store.saveCharacter(document); }
      catch (error) { write(TURNS + id, before); throw error; }
    },
    getSettings() { return read(SETTINGS, {}) || {}; },
    saveSettings(settings) { write(SETTINGS, settings); },
  };
  root.EmoStore = store;
})(typeof window !== "undefined" ? window : globalThis);
