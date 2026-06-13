<div align="center">

  <h1>Codex Proxy</h1>
  <h3>Trạm trung chuyển AI lập trình cá nhân của bạn</h3>
  <p>Biến Codex Desktop thành API Gateway đa giao thức — hỗ trợ OpenAI / Anthropic / Gemini / Ollama — kết nối mọi AI client.</p>

  <p>
    <img src="https://img.shields.io/badge/Runtime-Node.js_18+-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js">
    <img src="https://img.shields.io/badge/Language-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
    <img src="https://img.shields.io/badge/Framework-Hono-E36002?style=flat-square" alt="Hono">
    <img src="https://img.shields.io/badge/Docker-Supported-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker">
    <img src="https://img.shields.io/badge/Desktop-Win%20%7C%20Mac%20%7C%20Linux-8A2BE2?style=flat-square&logo=electron&logoColor=white" alt="Desktop">
  </p>

  <p>
    <a href="#-bắt-đầu-nhanh">Bắt đầu nhanh</a> &bull;
    <a href="#-tính-năng-chính">Tính năng</a> &bull;
    <a href="#-mô-hình-khả-dụng">Mô hình</a> &bull;
    <a href="#-kết-nối-client">Kết nối Client</a> &bull;
    <a href="#-cấu-hình">Cấu hình</a> &bull;
    <a href="#-api-endpoints">API</a>
  </p>

  <p>
    <a href="./README.md">简体中文</a> |
    <a href="./README_EN.md">English</a> |
    <strong>Tiếng Việt</strong>
  </p>

</div>

---

## 📋 Tổng quan

**Codex Proxy** là dịch vụ trung chuyển chạy cục bộ (local), chuyển đổi Codex Desktop Responses API thành nhiều giao thức tiêu chuẩn:

- **OpenAI** `/v1/chat/completions`
- **Anthropic** `/v1/messages`
- **Gemini** `/v1beta/models`
- **Codex Native** `/v1/responses` (passthrough)
- **Ollama Bridge** `/api/chat` (tùy chọn)

Chỉ cần một tài khoản ChatGPT (miễn phí cũng được), bạn có thể sử dụng các mô hình AI mạnh nhất của OpenAI trên Cursor, Claude Code, Continue, Cline, aider, Windsurf, Cherry Studio và mọi client tương thích.

---

## 🚀 Bắt đầu nhanh

### Yêu cầu

- Tài khoản ChatGPT (miễn phí hoặc Plus/Pro)
- Node.js 18+ (nếu chạy từ mã nguồn)

### Cách 1: Ứng dụng Desktop (Khuyên dùng cho người mới)

Tải về từ [Releases](https://github.com/icebear0828/codex-proxy/releases):

| Hệ điều hành | File |
|------|------|
| Windows | `Codex Proxy Setup x.x.x.exe` |
| macOS | `Codex Proxy-x.x.x.dmg` |
| Linux | `Codex Proxy-x.x.x.AppImage` |

Cài đặt → Mở ứng dụng → Đăng nhập bằng tài khoản ChatGPT → Truy cập `http://localhost:8080`.

### Cách 2: Docker

```bash
mkdir codex-proxy && cd codex-proxy
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/docker-compose.yml
curl -O https://raw.githubusercontent.com/icebear0828/codex-proxy/master/.env.example
cp .env.example .env
docker compose up -d
```

Mở `http://localhost:8080` để đăng nhập.

> 💡 Dữ liệu tài khoản lưu trong `data/` — restart không mất. Container khác kết nối qua IP LAN (ví dụ `192.168.x.x:8080`), không dùng `localhost`.

### Cách 3: Chạy từ mã nguồn

```bash
git clone https://github.com/icebear0828/codex-proxy.git
cd codex-proxy
npm install
cd web && npm install && cd ..
npm run dev    # Chế độ phát triển (hot reload)
```

> **Cần Rust toolchain** để biên dịch TLS addon:
> ```bash
> curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
> cd native && npm install && npm run build && cd ..
> ```

### Xác minh hoạt động

```bash
curl http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Xin chào!"}],"stream":true}'
```

Thay `your-api-key` bằng key hiển thị trên Dashboard (`http://localhost:8080`).

---

## 🌟 Tính năng chính

### 🔌 Tương thích đa giao thức

| Giao thức | Endpoint | Mô tả |
|-----------|----------|--------|
| OpenAI | `/v1/chat/completions` | Chat Completions API |
| Anthropic | `/v1/messages` | Messages API |
| Gemini | `/v1beta/models/:model:generateContent` | Gemini API |
| Codex Native | `/v1/responses` | Passthrough trực tiếp |
| Ollama | `localhost:11434/api/chat` | Bridge tùy chọn |

- SSE streaming đầy đủ
- Structured Outputs (`json_object` / `json_schema`)
- Function Calling / Tool Use (mọi giao thức)
- Chuyển đổi giao thức tự động hai chiều

### 🔐 Quản lý tài khoản & Luân chuyển thông minh

- **OAuth PKCE** — Đăng nhập một click qua trình duyệt
- **Đa tài khoản** — Hỗ trợ nhiều tài khoản đồng thời
- **4 chiến lược luân chuyển**:
  - `least_used` (mặc định) — Ưu tiên tài khoản ít sử dụng nhất, đa yếu tố
  - `adaptive` — Tính điểm tổng hợp: quota 40% + load 25% + LRU 20% + reset 15%
  - `round_robin` — Luân phiên đều
  - `sticky` — Bám tài khoản gần nhất (tối ưu prompt cache)
- **Plan Routing** — Tự động route theo plan (free/plus/team/pro)
- **Token tự động gia hạn** — JWT hết hạn sẽ được refresh tự động
- **Bỏ qua tài khoản hết quota** — `skip_exhausted: true`
- **Phát hiện cấm** — 403 → đánh dấu banned, 401 → hết hạn + đổi tài khoản

### 🛡️ Chống phát hiện & Giả lập giao thức

- **Rust Native TLS** — Fingerprint TLS khớp chính xác Codex Desktop thật
- **Headers đầy đủ** — `originator`, `User-Agent`, `x-codex-turn-state`, v.v.
- **Cookie persistence** — Tự động thu thập và phát lại Cloudflare Cookie
- **Chế độ Stealth**:
  - Khoảng cách yêu cầu tối thiểu (3000ms)
  - Installation ID riêng biệt mỗi tài khoản
  - Jitter giống người dùng thật
  - Giới hạn đồng thời mỗi tài khoản = 1
  - Tự động tạm dừng khi vượt ngưỡng theo giờ

### 🌐 Pool Proxy

- Gán proxy riêng cho từng tài khoản
- 4 chế độ: Global Default / Direct / Auto / Chỉ định
- Health check định kỳ + thủ công
- Tự động đánh dấu proxy không khả dụng

### 🔄 Tự phục hồi (Self-Healing)

- **Circuit Breaker** — Ngắt mạch khi lỗi liên tiếp, tự khôi phục
- **Stream Recovery** — Tự retry khi stream đứt ở giai đoạn chưa commit
- **Model Fallback** — Tự chuyển sang model dự phòng khi model chính lỗi/chậm
- **Cascading Ban Defense** — Xóa `previous_response_id` khi failover tránh liên lụy
- **Auto-Recovery** — Thăm dò tài khoản bị vô hiệu hóa mỗi 6 giờ
- **Wait Queue** — Chờ tài khoản thay vì trả 503 ngay lập tức

### 📊 Giám sát & Phân tích

- Dashboard web real-time (Preact SPA)
- Thống kê token usage theo thời gian
- Per-model request counters
- Prompt cache hit rate tracking
- Webhook notifications (ntfy/Slack/Discord/HTTP)
- Request logs với body capture tùy chọn

### 🖼️ Tạo hình ảnh

Hỗ trợ `image_generation` tool qua `/v1/responses` — backend `gpt-image-2`:

```bash
curl -N http://localhost:8080/v1/responses \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-5.5",
    "stream": true,
    "input": [{"role":"user","content":"Vẽ một vòng tròn đỏ trên nền trắng."}],
    "tools": [{"type":"image_generation","size":"1024x1024"}]
  }'
```

> Cần tài khoản Plus trở lên. Kích thước hỗ trợ: 1024×1024, 1024×1536, 2048×2048, 3840×2160 (4K), v.v.

---

## 📦 Mô hình khả dụng

| Mô hình | Mức suy luận | Context | Max Output | Ghi chú |
|---------|-------------|---------|------------|---------|
| `gpt-5.5` | low/medium/high/xhigh | 272K | 128K | Flagship — mã hóa phức tạp, nghiên cứu |
| `gpt-5.4` | low/medium/high/xhigh | 272K (max 1M) | 128K | Mặc định — mã hóa hàng ngày |
| `gpt-5.4-mini` | low/medium/high/xhigh | 400K | 128K | Phiên bản nhẹ của 5.4 |
| `gpt-5.3-codex` | low/medium/high/xhigh | 400K | 128K | Tối ưu lập trình |
| `gpt-5.2` | low/medium/high/xhigh | 400K | 128K | Tác vụ chuyên nghiệp + agent dài |
| `gpt-5-codex` | low/medium/high | 400K | 128K | GPT-5 tối ưu code |
| `gpt-5-codex-mini` | medium/high | — | — | Nhẹ, dùng cho CLI |
| `gpt-oss-120b` | low/medium/high | 131K | — | Open source 120B |
| `gpt-oss-20b` | low/medium/high | 131K | — | Open source 20B |
| `gpt-image-2` | — | — | — | Tạo hình ảnh |

**Hậu tố (suffix)**:
- `-fast` — Bật chế độ Fast
- `-high` / `-low` — Thay đổi mức suy luận
- Ví dụ: `gpt-5.4-fast`, `gpt-5.4-high-fast`

---

## 🔗 Kết nối Client

> API Key lấy từ Dashboard `http://localhost:8080`. Model mặc định: `gpt-5.4`.

### Claude Code (CLI)

```bash
export ANTHROPIC_BASE_URL=http://localhost:8080
export ANTHROPIC_API_KEY=your-api-key
claude
```

Mapping khuyên dùng: Opus → `gpt-5.5`, Sonnet → `gpt-5.4`, Haiku → `gpt-5.3-codex`.

### Codex CLI

`~/.codex/config.toml`:
```toml
[model_providers.proxy_codex]
name = "Codex Proxy"
base_url = "http://localhost:8080/v1"
wire_api = "responses"

[model_providers.proxy_codex.http_headers]
Authorization = "Bearer your-api-key"

[profiles.default]
model = "gpt-5.4"
model_provider = "proxy_codex"
```

### Codex Desktop (Ứng dụng chính thức)

Dùng cùng file `~/.codex/config.toml` như Codex CLI ở trên. Restart ứng dụng sau khi sửa.

### Claude Desktop

Bật Developer Mode → Configure Third-Party Inference:
- **Endpoint**: `http://127.0.0.1:8080`
- **API Key**: API key của bạn
- **Model**: `claude-opus-4-7` / `claude-sonnet-4-6` / `claude-haiku-4-5`

Hoặc sửa file cấu hình:
```json
{
  "inferenceProvider": "gateway",
  "inferenceGatewayBaseUrl": "http://127.0.0.1:8080",
  "inferenceGatewayApiKey": "your-api-key",
  "inferenceModels": ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"]
}
```

### Cursor

Settings → Models → OpenAI API:
- **Base URL**: `http://localhost:8080/v1`
- **API Key**: key của bạn
- **Model**: `gpt-5.4`

### Windsurf

Settings → AI Provider → OpenAI Compatible:
- **API Base URL**: `http://localhost:8080/v1`
- **API Key**: key của bạn
- **Model**: `gpt-5.4`

### Cline (VSCode)

Cline sidebar → Settings:
- **Provider**: OpenAI Compatible
- **Base URL**: `http://localhost:8080/v1`
- **API Key**: key của bạn
- **Model ID**: `gpt-5.4`

### Continue (VSCode)

`~/.continue/config.json`:
```json
{
  "models": [{
    "title": "Codex",
    "provider": "openai",
    "model": "gpt-5.4",
    "apiBase": "http://localhost:8080/v1",
    "apiKey": "your-api-key"
  }]
}
```

### aider

```bash
aider --openai-api-base http://localhost:8080/v1 \
      --openai-api-key your-api-key \
      --model openai/gpt-5.4
```

### Cherry Studio

Cài đặt → Dịch vụ Model → Thêm:
- **Loại**: OpenAI
- **API URL**: `http://localhost:8080/v1`
- **API Key**: key của bạn
- **Model**: `gpt-5.4`

### Ollama-compatible Client

Bật Ollama Bridge trong Dashboard → Settings. Sau đó:

```bash
# Kiểm tra model
curl http://localhost:11434/api/tags

# Chat
curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5.4","messages":[{"role":"user","content":"Hello!"}],"stream":true}'
```

### SDK (Python / Node.js)

**Python:**
```python
from openai import OpenAI
client = OpenAI(base_url="http://localhost:8080/v1", api_key="your-api-key")
for chunk in client.chat.completions.create(
    model="gpt-5.4", messages=[{"role": "user", "content": "Xin chào!"}], stream=True
):
    print(chunk.choices[0].delta.content or "", end="")
```

**Node.js:**
```typescript
import OpenAI from "openai";
const client = new OpenAI({ baseURL: "http://localhost:8080/v1", apiKey: "your-api-key" });
const stream = await client.chat.completions.create({
  model: "gpt-5.4", messages: [{ role: "user", content: "Hello!" }], stream: true,
});
for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || "");
}
```

---

## ⚙️ Cấu hình

> **Quan trọng**: Không sửa `config/default.yaml` — file này bị ghi đè khi cập nhật. Dùng Dashboard hoặc tạo `data/local.yaml` để ghi đè cấu hình.

### Cấu hình chính

| Mục | Key | Mô tả |
|-----|-----|--------|
| Server | `server.host` | Địa chỉ lắng nghe (mặc định `127.0.0.1`) |
| | `server.port` | Cổng (mặc định `8080`) |
| | `server.proxy_api_key` | Mật khẩu API (⚠️ đặt giá trị mạnh!) |
| Model | `model.default` | Model mặc định (`gpt-5.4`) |
| | `model.aliases` | Ánh xạ tên model |
| Auth | `auth.rotation_strategy` | `least_used` / `adaptive` / `round_robin` / `sticky` |
| | `auth.max_concurrent_per_account` | Đồng thời tối đa mỗi tài khoản (mặc định `3`) |
| | `auth.tier_priority` | Thứ tự ưu tiên plan: `["pro","plus","free"]` |
| Quota | `quota.skip_exhausted` | Bỏ qua tài khoản hết quota (`true`) |
| | `quota.global_concurrency` | Giới hạn đồng thời toàn cục (`100`) |
| TLS | `tls.proxy_url` | URL proxy upstream |
| Stealth | `stealth.enabled` | Bật chế độ tàng hình |
| Ollama | `ollama.enabled` | Bật Ollama Bridge |
| | `ollama.port` | Cổng Ollama (mặc định `11434`) |

### Ánh xạ Model (Aliases)

Trong `data/local.yaml`:
```yaml
model:
  aliases:
    claude-opus-4-7: gpt-5.5
    claude-sonnet-4-6: gpt-5.4
    claude-haiku-4-5: gpt-5.3-codex
    my-deepseek: deepseek-chat
```

Bên trái = tên client gửi, bên phải = model thực tế. Hỗ trợ chain mapping và provider prefix (`openai:gpt-4o`, `anthropic:claude-sonnet-4-5`).

### Chiến lược luân chuyển

| Chiến lược | Tốt cho | Prompt Cache | Cân bằng Quota |
|-----------|---------|-------------|----------------|
| `least_used` | Đa năng (mặc định) | ⭐⭐ | ⭐⭐⭐ |
| `adaptive` | Pool 6+ tài khoản | ⭐⭐ | ⭐⭐⭐ |
| `round_robin` | Pool đồng nhất | ⭐ | ⭐⭐ |
| `sticky` | 1-2 tài khoản | ⭐⭐⭐ | ⭐ |

### Chế độ Stealth

```yaml
stealth:
  enabled: true
  min_request_interval_ms: 3000
  max_concurrent_per_account: 1
  per_account_installation_id: true
  humanlike_jitter: true
  hourly_request_warn: 100
  hourly_request_throttle: 200
  hourly_request_pause: 500
```

### Model Fallback

Tự động chuyển sang model dự phòng khi model chính lỗi:

```yaml
model_fallback:
  gpt-5.5:
    fallbacks: ["gpt-5.4", "gpt-5.4-mini"]
    error_threshold: 3
    latency_threshold_ms: 30000
    recovery_probe_interval_ms: 120000
```

### Provider bên thứ ba

```yaml
providers:
  openai:
    api_key: "sk-..."
    base_url: "https://api.openai.com/v1"
  anthropic:
    api_key: "sk-ant-..."
  custom:
    deepseek:
      api_key: "sk-..."
      base_url: "https://api.deepseek.com/v1"
      models: ["deepseek-chat"]

model_routing:
  deepseek-chat: deepseek
```

### Truy cập mạng LAN

```yaml
server:
  host: "0.0.0.0"  # Mở cho mạng LAN
```

> ⚠️ Khi bind `0.0.0.0`, hãy chắc chắn đã đặt `proxy_api_key` mạnh!

### Biến môi trường

| Biến | Ghi đè |
|------|--------|
| `PORT` | `server.port` |
| `CODEX_PROXY_HOST` | `server.host` |
| `HTTPS_PROXY` | `tls.proxy_url` |
| `OLLAMA_BRIDGE_ENABLED` | `ollama.enabled` |
| `OLLAMA_BRIDGE_PORT` | `ollama.port` |

---

## 📡 API Endpoints

### Giao thức chính

| Endpoint | Method | Mô tả |
|----------|--------|--------|
| `/v1/chat/completions` | POST | OpenAI Chat API |
| `/v1/messages` | POST | Anthropic Messages API |
| `/v1/responses` | POST | Codex Responses (passthrough) |
| `/v1beta/models/:model:generateContent` | POST | Gemini API |
| `/v1/models` | GET | Danh sách model |
| `/v1/models/catalog` | GET | Catalog đầy đủ |
| `/v1/embeddings` | POST | Embeddings (chỉ API key pool) |

### Quản lý tài khoản

| Endpoint | Method | Mô tả |
|----------|--------|--------|
| `/auth/login` | GET | Đăng nhập OAuth |
| `/auth/accounts` | GET | Danh sách tài khoản |
| `/auth/accounts` | POST | Thêm tài khoản |
| `/auth/accounts/import` | POST | Import hàng loạt |
| `/auth/accounts/export` | GET | Export tài khoản |
| `/auth/accounts/batch-delete` | POST | Xóa hàng loạt |
| `/auth/accounts/:id/quota` | GET | Kiểm tra quota |

### API Keys bên thứ ba

| Endpoint | Method | Mô tả |
|----------|--------|--------|
| `/auth/api-keys` | GET/POST | Quản lý API keys |
| `/auth/api-keys/import` | POST | Import cấu hình |
| `/auth/api-keys/export` | GET | Export cấu hình |

### Quản trị

| Endpoint | Method | Mô tả |
|----------|--------|--------|
| `/health` | GET | Health check cơ bản |
| `/health/detailed` | GET | Health chi tiết (memory, circuit breaker, cache) |
| `/admin/rotation-settings` | GET/POST | Cấu hình luân chuyển |
| `/admin/usage-stats/summary` | GET | Tổng hợp sử dụng |
| `/admin/usage-stats/history` | GET | Lịch sử sử dụng |
| `/admin/logs` | GET | Nhật ký yêu cầu |
| `/admin/account-scoring` | GET | Điểm số tài khoản real-time |

### Pool Proxy

| Endpoint | Method | Mô tả |
|----------|--------|--------|
| `/api/proxies` | GET/POST | Danh sách / Thêm proxy |
| `/api/proxies/:id/check` | POST | Health check proxy |
| `/api/proxies/check-all` | POST | Check tất cả |
| `/api/proxies/assign` | POST | Gán proxy cho tài khoản |

### Batch (Xử lý nền)

| Endpoint | Method | Mô tả |
|----------|--------|--------|
| `/v1/batch/submit` | POST | Gửi job xử lý nền |
| `/v1/batch/:id` | GET | Lấy kết quả |

---

## 🏗️ Kiến trúc hệ thống

```
┌─────────────────────────────────────────────────────────┐
│  Client (Cursor / Claude Code / Continue / SDK / ...)   │
│       │                                                 │
│  POST /v1/chat/completions (OpenAI)                     │
│  POST /v1/messages         (Anthropic)                  │
│  POST /v1/responses        (Codex passthrough)          │
│  POST /gemini/*            (Gemini)                     │
│       ▼                                                 │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────────┐  │
│  │  Router  │→ │ Translation  │→ │  Native TLS      │  │
│  │  (Hono)  │  │ Multi↔Codex  │  │  (Rust addon)    │  │
│  └──────────┘  └──────────────┘  └────────┬─────────┘  │
│                                            │            │
│  ┌──────────┐  ┌──────────────┐  ┌────────▼─────────┐  │
│  │   Auth   │  │  Fingerprint │  │   WS Pool        │  │
│  │ OAuth/RT │  │ TLS/Headers  │  │ Prompt Cache Pin  │  │
│  └──────────┘  └──────────────┘  └──────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
              chatgpt.com/backend-api
```

### Quy trình xử lý yêu cầu

1. **Nhận yêu cầu** — Client gửi request ở bất kỳ giao thức nào
2. **Xác thực** — Kiểm tra API key
3. **Chuyển đổi giao thức** — Dịch sang định dạng Codex Responses
4. **Chọn tài khoản** — Luân chuyển thông minh (affinity → rotation → fallback)
5. **Gửi upstream** — Qua WS Pool hoặc HTTP SSE với TLS fingerprint chính xác
6. **Stream về client** — Chuyển đổi ngược + heartbeat + error injection
7. **Ghi nhận** — Usage stats, prompt cache tracking, circuit breaker update

### Cơ chế retry

```
Lỗi 401 → Expire token + đổi tài khoản
Lỗi 402 → Hết quota + đổi tài khoản
Lỗi 403 (CF) → CF cooldown (10→30→90→120s) + đổi tài khoản
Lỗi 403 (ban) → Đánh dấu banned + đổi tài khoản
Lỗi 429 → Backoff + đổi tài khoản
Lỗi 5xx → Circuit breaker + retry tối đa 10 lần
previous_response_not_found → Xóa prev_id + retry cùng tài khoản
Stream đứt (chưa commit) → Retry trong suốt cùng tài khoản
```

---

## 🔒 Bảo mật

### Đã có

- ✅ So sánh timing-safe cho API key
- ✅ API key random 192-bit mỗi tài khoản
- ✅ TLS fingerprint khớp chính xác Codex Desktop
- ✅ Installation ID riêng mỗi tài khoản (stealth mode)
- ✅ Client diversity (User-Agent đa dạng)
- ✅ Rate limiting (50 burst / 10 refill per phút)
- ✅ GC cho rate limiter buckets (tránh memory leak)
- ✅ Log thất bại xác thực (IP + timestamp)
- ✅ Cảnh báo khi `proxy_api_key` không được đặt

### Khuyến nghị bảo mật

1. **Luôn đặt `proxy_api_key`** — Không để null/empty
2. **Không expose port ra internet** nếu không qua reverse proxy + HTTPS
3. **Dùng stealth mode** khi có nhiều tài khoản
4. **Giám sát `/health/detailed`** — Theo dõi circuit breaker và memory

---

## 📈 Giám sát

### Health Check

```bash
# Cơ bản
curl http://localhost:8080/health

# Chi tiết (memory, circuit breaker, cache, model counters)
curl http://localhost:8080/health/detailed
```

Response chi tiết bao gồm:
- `pool` — Số tài khoản active/expired/banned/disabled
- `concurrency` — Slots hiện tại / tối đa / đang chờ
- `ws_pool` — Số kết nối WebSocket
- `memory` — RSS, heap used/total (MB)
- `circuit_breakers` — Tổng số, số đang open
- `response_cache` — Entries + MB cached
- `model_requests` — Request count và error count mỗi model

### Webhook

Cấu hình trong `data/local.yaml`:
```yaml
notifications:
  webhook_url: "https://ntfy.sh/your-topic"
```

Sự kiện: `account_disabled`, `account_recovered`, `quota_warning`, `quota_exhausted`, `all_accounts_down`, `stealth_pause`, `circuit_open`.

### Account Scoring

```bash
curl http://localhost:8080/admin/account-scoring | jq
```

Hiển thị điểm số real-time mỗi tài khoản: eligibility, quota headroom, load, recency, reset proximity.

---

## 🔧 Xử lý sự cố

### "No available accounts" (503)

**Nguyên nhân**: Tất cả tài khoản đều exhausted/banned/disabled.

**Giải pháp**:
- Kiểm tra `/health/detailed` → xem trạng thái pool
- Thêm tài khoản mới
- Chờ rate limit reset (thường 1-60 phút)
- Kiểm tra quota: `GET /auth/accounts/:id/quota`

### "All accounts paused" (429 từ proxy)

**Nguyên nhân**: Stealth mode đạt ngưỡng `hourly_request_pause`.

**Giải pháp**:
- Tăng `stealth.hourly_request_pause` hoặc đặt 0 để tắt
- Thêm nhiều tài khoản
- Giảm lưu lượng client

### Prompt cache hit rate thấp

**Nguyên nhân**: Conversation bị bounce giữa các tài khoản khác nhau.

**Giải pháp**:
- Kiểm tra session affinity hoạt động: `/admin/account-scoring`
- Dùng `sticky` strategy nếu chỉ có 1-2 tài khoản
- Giữ instructions ổn định (thay đổi instructions = cache miss)

### Cloudflare challenge liên tục

**Nguyên nhân**: IP bị CF nghi ngờ.

**Giải pháp**:
- Thêm proxy pool với IP khác
- Cooldown tự động: 10s → 30s → 90s → 120s, reset sau 1h
- Kiểm tra: `/admin/account-scoring` → `cf_cooldown`

---

## 📋 Yêu cầu hệ thống

| Thành phần | Yêu cầu |
|-----------|---------|
| Node.js | 18+ (khuyên 20+) |
| Rust | Chỉ cần nếu chạy từ mã nguồn |
| Tài khoản ChatGPT | Miễn phí hoặc Plus/Pro |
| RAM | ~100-200MB (tùy số tài khoản) |
| Docker | Tùy chọn |

---

## 📝 Lưu ý quan trọng

- Codex API là **streaming-only** — `stream: false` sẽ được proxy thu thập nội bộ rồi trả JSON đầy đủ
- Fingerprint tự động cập nhật khi Codex Desktop phát hành phiên bản mới
- Windows cần Rust toolchain để biên dịch native addon; Docker/Desktop đã có sẵn
- Giới hạn retry: tối đa 10 lần mỗi yêu cầu
- Timeout stream: tự động kill sau 5 phút không có dữ liệu từ upstream
- Response cache: tối đa 500 entries / 50MB

---

## 📄 Giấy phép

**Non-Commercial License**:
- ✅ Cho phép: Học tập, nghiên cứu, triển khai cá nhân
- ❌ Cấm: Mọi hình thức thương mại (bán, cho thuê, tích hợp sản phẩm thu phí)

Dự án không liên kết với OpenAI. Người dùng tự chịu rủi ro và tuân thủ điều khoản dịch vụ của OpenAI.

---

<div align="center">
  <sub>Built with Hono + TypeScript + Rust | Powered by Codex Desktop API</sub>
</div>
