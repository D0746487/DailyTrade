# -*- coding: utf-8 -*-
"""台股當沖模擬器 - 本機伺服器
提供靜態網頁，並代理證交所/櫃買中心 API(避免瀏覽器 CORS 限制)。
啟動: python server.py  →  http://localhost:8800
"""
import json
import os
import re
import ssl
import threading
import time
import urllib.request
import urllib.parse
from datetime import date
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# 證交所憑證缺少 Subject Key Identifier，Python 3.13+ 預設的嚴格檢查會拒絕，
# 這裡放寬 strict flag（仍維持一般憑證鏈驗證）。
SSL_CTX = ssl.create_default_context()
SSL_CTX.verify_flags &= ~ssl.VERIFY_X509_STRICT

ROOT = os.path.dirname(os.path.abspath(__file__))

# 本機執行：預設 8800、只聽 localhost、帳戶存 data.json。
# 雲端部署（如 Render 會設定 PORT 環境變數）：自動改聽 0.0.0.0，
# 並啟用公開模式（帳戶改存訪客各自的瀏覽器，避免所有人共用同一份紀錄）。
PORT = int(os.environ.get("PORT", "8800"))
IS_CLOUD = "PORT" in os.environ
HOST = "0.0.0.0" if IS_CLOUD else "127.0.0.1"
PUBLIC_MODE = IS_CLOUD or os.environ.get("PUBLIC_MODE", "") in ("1", "true")

# 帳戶/最愛儲存（伺服器端 JSON，所有瀏覽器共用同一份）
DATA_FILE = os.path.join(ROOT, "data.json")
_data_lock = threading.Lock()


def load_state():
    try:
        with open(DATA_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return {}


def save_state(state):
    with _data_lock:
        tmp = DATA_FILE + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh, ensure_ascii=False, indent=1)
        os.replace(tmp, DATA_FILE)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def fetch_json(url, referer=None, timeout=10):
    headers = {"User-Agent": UA, "Accept": "application/json, text/plain, */*"}
    if referer:
        headers["Referer"] = referer
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=SSL_CTX) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def num(s):
    """'2,505.00' → 2505.0；無法解析回傳 None"""
    if s is None:
        return None
    s = str(s).replace(",", "").strip()
    if s in ("", "-", "--", "X", "0.00") and s != "0.00":
        return None
    try:
        return float(s)
    except ValueError:
        return None


def roc_to_iso(roc):
    """'115/07/01' → '2026-07-01'"""
    m = re.match(r"(\d+)/(\d+)/(\d+)", roc.strip())
    if not m:
        return None
    y, mo, d = int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3))
    return f"{y:04d}-{mo:02d}-{d:02d}"


def month_list(months):
    """回傳最近 N 個月的 (西元年, 月)，由舊到新"""
    today = date.today()
    y, m = today.year, today.month
    out = []
    for _ in range(months):
        out.append((y, m))
        m -= 1
        if m == 0:
            y, m = y - 1, 12
    return list(reversed(out))


def daily_tse(code, months):
    """證交所上市個股日成交資訊 (STOCK_DAY)，成交量單位轉為張"""
    candles = []
    for y, m in month_list(months):
        url = (f"https://www.twse.com.tw/exchangeReport/STOCK_DAY"
               f"?response=json&date={y:04d}{m:02d}01&stockNo={urllib.parse.quote(code)}")
        try:
            data = fetch_json(url, referer="https://www.twse.com.tw/")
        except Exception:
            continue
        if data.get("stat") != "OK":
            continue
        for row in data.get("data", []):
            t = roc_to_iso(row[0])
            o, h, l, c = num(row[3]), num(row[4]), num(row[5]), num(row[6])
            vol_shares = num(row[1])
            if t and None not in (o, h, l, c):
                candles.append({"time": t, "open": o, "high": h, "low": l,
                                "close": c,
                                "volume": round((vol_shares or 0) / 1000)})
        time.sleep(0.3)  # 證交所對頻繁請求較敏感
    return candles


def daily_otc(code, months):
    """櫃買中心上櫃個股日成交資訊，成交量單位為仟股(=張)"""
    candles = []
    for y, m in month_list(months):
        url = (f"https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock"
               f"?code={urllib.parse.quote(code)}&date={y:04d}/{m:02d}/01&response=json")
        try:
            data = fetch_json(url, referer="https://www.tpex.org.tw/")
        except Exception:
            continue
        tables = data.get("tables") or []
        rows = tables[0].get("data", []) if tables else data.get("aaData", [])
        for row in rows:
            t = roc_to_iso(row[0])
            o, h, l, c = num(row[3]), num(row[4]), num(row[5]), num(row[6])
            vol = num(row[1])
            if t and None not in (o, h, l, c):
                candles.append({"time": t, "open": o, "high": h, "low": l,
                                "close": c, "volume": round(vol or 0)})
        time.sleep(0.3)
    return candles


def intraday_history(code, market, rng):
    """分K歷史資料（證交所無此公開API，取自 Yahoo Finance 台股行情）
    回傳 1 分K，時間為 unix 秒，成交量單位為張"""
    suffix = ".TWO" if market == "otc" else ".TW"
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(code + suffix)}?interval=1m&range={rng}")
    data = fetch_json(url, timeout=15)
    result = (data.get("chart", {}).get("result") or [None])[0]
    if not result:
        return []
    ts = result.get("timestamp") or []
    q = (result.get("indicators", {}).get("quote") or [{}])[0]
    opens, highs = q.get("open") or [], q.get("high") or []
    lows, closes = q.get("low") or [], q.get("close") or []
    vols = q.get("volume") or []
    candles = []
    for i, t in enumerate(ts):
        o, h, l, c = opens[i], highs[i], lows[i], closes[i]
        if None in (o, h, l, c):
            continue
        v = vols[i] or 0
        candles.append({"time": (t // 60) * 60, "open": o, "high": h,
                        "low": l, "close": c, "volume": round(v / 1000)})
    return candles


# 上櫃股票清單快取（codeQuery 只涵蓋上市，須另行合併上櫃）
_otc_cache = {"ts": 0.0, "items": []}


def otc_list():
    now = time.time()
    if now - _otc_cache["ts"] > 3600 or not _otc_cache["items"]:
        try:
            data = fetch_json("https://www.tpex.org.tw/openapi/v1/tpex_mainboard_quotes",
                              referer="https://www.tpex.org.tw/", timeout=15)
            items = []
            for row in data:
                code = (row.get("SecuritiesCompanyCode") or "").strip()
                name = (row.get("CompanyName") or "").strip()
                if code and name:
                    items.append((code, name))
            if items:
                _otc_cache["items"] = items
                _otc_cache["ts"] = now
        except Exception:
            _otc_cache["ts"] = now  # 失敗時暫不重試，避免拖慢搜尋
    return _otc_cache["items"]


def search_suggestions(q):
    """合併證交所(上市) codeQuery 與櫃買(上櫃)清單的搜尋結果"""
    out, seen = [], set()
    try:
        url = ("https://www.twse.com.tw/rwd/zh/api/codeQuery?query="
               + urllib.parse.quote(q))
        data = fetch_json(url, referer="https://www.twse.com.tw/")
        for s in data.get("suggestions", []):
            code = s.split("\t")[0]
            if code not in seen:
                seen.add(code)
                out.append(s)
    except Exception:
        pass
    ql = q.lower()
    for code, name in otc_list():
        if code in seen:
            continue
        if code.lower().startswith(ql) or ql in name.lower():
            seen.add(code)
            out.append(f"{code}\t{name}")
        if len(out) >= 30:
            break
    return out[:30]


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        pass  # 安靜模式

    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)

        try:
            if parsed.path == "/api/state":
                if PUBLIC_MODE:
                    return self.send_json({"disabled": True})
                return self.send_json(load_state())

            if parsed.path == "/api/search":
                q = (qs.get("q") or [""])[0].strip()
                if not q:
                    return self.send_json({"suggestions": []})
                return self.send_json({"query": q,
                                       "suggestions": search_suggestions(q)})

            if parsed.path == "/api/quote":
                codes = [c.strip() for c in (qs.get("code") or [""])[0].split(",")
                         if c.strip()]
                if (not codes or len(codes) > 20 or
                        any(not re.fullmatch(r"[0-9A-Za-z]{2,8}", c) for c in codes)):
                    return self.send_json({"error": "bad code"}, 400)
                ex_ch = "|".join(f"tse_{c}.tw|otc_{c}.tw" for c in codes)
                url = ("https://mis.twse.com.tw/stock/api/getStockInfo.jsp"
                       f"?ex_ch={urllib.parse.quote(ex_ch)}&json=1&delay=0&_="
                       + str(int(time.time() * 1000)))
                data = fetch_json(url, referer="https://mis.twse.com.tw/stock/index.jsp")
                return self.send_json(data)

            if parsed.path == "/api/intraday":
                code = (qs.get("code") or [""])[0].strip()
                market = (qs.get("market") or ["tse"])[0]
                rng = (qs.get("range") or ["1d"])[0]
                if not re.fullmatch(r"[0-9A-Za-z]{2,8}", code):
                    return self.send_json({"error": "bad code"}, 400)
                if rng not in ("1d", "2d", "5d", "7d"):
                    rng = "1d"
                return self.send_json(
                    {"candles": intraday_history(code, market, rng)})

            if parsed.path == "/api/daily":
                code = (qs.get("code") or [""])[0].strip()
                market = (qs.get("market") or ["tse"])[0]
                months = min(int((qs.get("months") or ["6"])[0]), 12)
                if not re.fullmatch(r"[0-9A-Za-z]{2,8}", code):
                    return self.send_json({"error": "bad code"}, 400)
                fn = daily_otc if market == "otc" else daily_tse
                return self.send_json({"candles": fn(code, months)})

            if parsed.path == "/":
                self.path = "/index.html"
            return super().do_GET()
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/state":
                if PUBLIC_MODE:
                    return self.send_json({"error": "public mode"}, 403)
                length = int(self.headers.get("Content-Length") or 0)
                if length <= 0 or length > 2_000_000:
                    return self.send_json({"error": "bad size"}, 400)
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                if (not isinstance(body, dict) or
                        not isinstance(body.get("account"), dict) or
                        not isinstance(body.get("favorites"), list)):
                    return self.send_json({"error": "bad state"}, 400)
                save_state({"account": body["account"],
                            "favorites": body["favorites"]})
                return self.send_json({"ok": True})
            return self.send_json({"error": "not found"}, 404)
        except Exception as e:
            return self.send_json({"error": str(e)}, 500)


if __name__ == "__main__":
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    mode = "公開模式（訪客紀錄各自存瀏覽器）" if PUBLIC_MODE else "本機模式（紀錄存 data.json）"
    print(f"台股當沖模擬器已啟動 → http://localhost:{PORT}  [{mode}]")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
