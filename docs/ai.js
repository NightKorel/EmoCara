// EmoCara 自動模式：直接從瀏覽器呼叫 Gemini。
// 鑰匙只存在這台裝置的瀏覽器裡（設定），不會進 GitHub，也不會送到 Google 以外的地方。
(function (root) {
  "use strict";
  const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

  async function askGemini(prompt, { apiKey, model } = {}) {
    if (!apiKey) throw new Error("還沒填 Gemini 鑰匙。請按左邊的「設定」填好，或改用手動模式。");
    const chosen = (model || DEFAULT_GEMINI_MODEL).trim();
    let response;
    try {
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(chosen)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });
    } catch {
      throw retryable(new Error("連不上 Gemini。請確認網路，或改用手動模式。"));
    }
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = body?.error?.message || `HTTP ${response.status}`;
      if (response.status === 400 && /API key/i.test(message)) throw new Error("Gemini 鑰匙好像不對，請到「設定」重新貼一次。");
      if (response.status === 404) throw new Error(`找不到模型「${chosen}」。請到「設定」換一個模型名稱。`);
      if (response.status === 429) throw retryable(new Error("Gemini 說用量太多了（可能是免費額度用完，或一下子送太多次）。等一下再試，或改用手動模式。"));
      if ([500, 502, 503, 504].includes(response.status)) throw retryable(new Error(`Gemini 那邊塞車了（${message}）。等一下再試，或改用手動模式。`));
      throw new Error(`Gemini 回報錯誤：${message}`);
    }
    const text = (body?.candidates?.[0]?.content?.parts || []).map((part) => part.text || "").join("");
    if (!text.trim()) throw new Error("Gemini 沒有回任何文字，可能被它的安全規則擋下來了。換個說法再試一次。");
    return text;
  }

  // 塞車、用量太多、連不上：可以等一下再試的錯誤。
  function retryable(error) { error.retryable = true; return error; }
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // 塞車時自動等一下再試，最多試 tries 次；每次重試前呼叫 onRetry(第幾次, 錯誤)。
  async function askGeminiWithRetry(prompt, settings, { tries = 3, delays = [3000, 6000], onRetry = () => {} } = {}) {
    for (let attempt = 1; ; attempt++) {
      try { return await askGemini(prompt, settings); }
      catch (error) {
        if (!error.retryable || attempt >= tries) throw error;
        onRetry(attempt + 1, error);
        await wait(delays[Math.min(attempt - 1, delays.length - 1)]);
      }
    }
  }

  root.EmoAI = { DEFAULT_GEMINI_MODEL, askGemini, askGeminiWithRetry };
})(typeof window !== "undefined" ? window : globalThis);
