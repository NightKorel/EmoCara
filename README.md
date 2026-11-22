# 情緒模擬器：模組化角色檔案與自由互動 v0.1

這是情緒模擬器的第一個可玩里程碑：一個本機執行的角色資料與自由互動工具。它還**沒有**記憶演算或自主心理活動；本版的目標是讓角色設定與聊天回合都有穩定、可攜且可擴充的地基。

## 已完成範圍

- 建立、讀取、修改與刪除角色（SQLite）。
- 編輯基本資料，且不強迫填完未知資訊。
- 新增、刪除、啟用／停用預設或自訂心理模組。
- 每個模組可儲存任意 JSON 物件與備註；適合文字、數字、標籤或巢狀資料。
- 編輯初始情緒座標、四個預設心理指標、情緒與自訂指標。
- 匯出／匯入完整角色 JSON。同 ID 匯入時會自動產生新 ID，避免覆蓋既有角色。
- 可選擇本機 Ollama 或 Gemini Developer API；預設完全停用模型。
- 模型只會提出 JSON 狀態變化提案；Python 會用欄位白名單、數值範圍與既有 schema 驗證，只有 `apply-state-proposal` 才會寫入 SQLite。
- 可為同一種狀態提案產生手動模式的完整提示詞，並驗證從網頁 AI 貼回的 JSON；提示詞產生與貼回預覽都不會呼叫網路或寫入 SQLite。
- 可自由互動：角色回覆與可選的心理數值提案共用一份 JSON 契約，會先預覽，再由使用者確認保存。
- 模型可提出至多三筆記憶候選項；候選項預設不會保存，必須逐筆勾選並和聊天回合一同確認。尚未實作記憶淡化、整合或回想。
- 每名角色可在基本資料頁調整核心／重要／普通記憶的筆數與每筆文字上限。新角色預設為 200／120／60 字元；超過上限只會拒絕新增，不會自動刪除既有記憶。
- 自動 API／本機模型與手動網頁 AI 都使用同一份完整提示詞、解析器、Python 驗證與保存流程；手動模式是預設，且完全不連網。
- 已確認的聊天回合儲存在 SQLite 的獨立資料表，不會膨脹或破壞既有角色 JSON 格式。
- 提供獨立、只讀的「觀察者」分頁，可由使用者主動查看目前心理數值、已確認記憶與關係資料的保留狀態；它不會在聊天時自動顯示。
- 可手動管理關係資料的信任、親密、安全感、依賴與戒心五個維度；目前 AI 不會自行修改這些數值。

本版刻意不做記憶整合與淡化、AI 關係演算、心理歷史分析與開啟時自主心理活動。JSON 格式已保留 `memories` 與 `relationships` 區塊，供下一階段擴充。

後續分階段規劃與擴充邊界請見 [`ROADMAP.md`](ROADMAP.md)。

## 資料設計

每位角色存成一份版本化 JSON 文件（`schema_version: "0.1"`），在 SQLite 的 `characters` 表中保存：

```text
character
├── profile        固定基本設定
├── modules[]      可增減、可停用的心理／自訂模組
├── state          可變的初始心理狀態
├── memories[]     預留給下一階段
├── relationships[] 預留給下一階段
└── metadata       建立、修改與匯入資訊
```

模組資料是 JSON 物件，不限制欄位。若要表達資訊的可信／公開狀態，建議使用：

```json
{
  "核心信念": {
    "value": "必須獨自解決問題",
    "status": "uncertain",
    "source": "user_defined",
    "notes": "角色本人不會如此描述。"
  }
}
```

`status` 可用 `known`、`unknown`、`uncertain`、`undisclosed`、`not_applicable`。本版不會將空白補成事實。

## Windows 安裝與啟動

1. 安裝 [Python 3.11 或更新版本](https://www.python.org/downloads/windows/)。安裝畫面請勾選 **Add Python to PATH**。
2. 在檔案總管開啟本專案資料夾，雙擊 `start.bat`。
3. 首次啟動會建立 `.venv` 並安裝套件。完成後瀏覽器會開啟 `http://127.0.0.1:8000`。
4. 保持命令視窗開著；關閉它會停止本機伺服器。

也可以在 PowerShell 手動執行：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --reload
```

資料庫預設存於 `data/emotional_simulator.db`；請定期使用介面中的「匯出 JSON」保存備份。它只會監聽你的電腦（`127.0.0.1`），不會上傳資料。

## Gemini（可選，不啟用不會連線）

Gemini 透過官方 `google-genai` SDK 呼叫；目前預設模型是 `gemini-3.8-flash`。模型名稱、可用額度與速率限制可能調整，實際以 Google AI Studio 顯示的專案資格為準。此專案不會建立 Cloud Billing、付款帳戶或任何雲端資源。

1. 到 [Google AI Studio API Keys](https://aistudio.google.com/api-keys) 建立 API key。不要把金鑰貼到聊天、程式碼或 Git。
2. 在專案根目錄複製 `.env.example` 成 `.env`，填入 `GEMINI_API_KEY`；`.env` 已被 Git 排除。
3. 確認 `EMOSIM_MODEL_PROVIDER=gemini`，再重新啟動 `start.bat`。首次啟動會安裝 `google-genai`。
4. 開啟 `http://127.0.0.1:8000/api/model-status`；看到 `{"provider":"gemini","ready":true}` 只代表本機設定完整，尚未發出 API 請求。
5. 只有在自由互動頁選擇「自動 API／本機模型」並按下「產生自動回覆預覽」（或呼叫 `POST /api/characters/{character_id}/chat-proposal`）時，才會向模型發出請求；預覽本身不會保存。手動模式不會連網。

若要改回完全本機模型，將 `.env` 的 `EMOSIM_MODEL_PROVIDER` 改為 `ollama`，並設定本機已下載的 `EMOSIM_OLLAMA_MODEL`。若要完全停用，設為 `disabled` 或移除該行。

免費層與隱私提醒：Google 目前把免費層定位為有限模型與速率限制的開發用途，且免費層內容可用於改進其產品。不要把不希望離開電腦的角色資料送到 Gemini；本機 Ollama 是較合適的替代方案。

## 開發與測試

```powershell
python -m pytest -q
```

測試會驗證：建立／編輯角色、模組啟停與編輯、心理狀態範圍、JSON 匯出入、SQLite 保存與刪除流程。
