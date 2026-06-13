# Hướng dẫn Xây dựng và Triển khai Codex Proxy

Tài liệu này hướng dẫn cách biên dịch và đóng gói ứng dụng Codex Proxy từ mã nguồn.

## Yêu cầu hệ thống
- **Node.js**: Phiên bản 20 hoặc mới hơn.
- **npm**: Phiên bản 10 hoặc mới hơn.
- **Rust/Cargo**: Bắt buộc phải có để biên dịch các module native `codex-tls` (Cài đặt qua [rustup](https://rustup.rs/)).

---

## 1. Cài đặt các thư viện (Dependencies)
Mở terminal tại thư mục gốc của dự án và chạy các lệnh sau để đảm bảo toàn bộ thư viện được cài đặt đầy đủ cho tất cả các thành phần:

```bash
# Cài đặt thư viện gốc
npm install

# Cài đặt thư viện cho giao diện Web
cd web
npm install
cd ..

# Cài đặt thư viện cho Native module
cd native
npm install
cd ..

# Cài đặt thư viện cho Desktop App (Electron)
cd packages/electron
npm install
cd ../..
```

---

## 2. Biên dịch Core & Web (Chế độ chạy Server độc lập)
Nếu bạn chỉ muốn chạy `codex-proxy` dưới dạng một background service (không có giao diện Desktop), thực hiện theo các bước sau:

```bash
# Bước 2a: Biên dịch addon native bằng Rust (NAPI-RS)
cd native
npm run build
cd ..

# Bước 2b: Biên dịch giao diện frontend (Vite) và backend server (TypeScript)
npm run build

# Bước 2c: Khởi chạy proxy server
npm run start
```
*Ghi chú: Lệnh `npm run build` ở thư mục gốc sẽ tự động gọi `npm run build:web` để build thư mục `web/`.*

---

## 3. Đóng gói Ứng dụng Desktop (Electron)
Nếu bạn muốn tạo file cài đặt cho người dùng Desktop (Windows, macOS, Linux), hãy đảm bảo bạn **đã hoàn tất Bước 2** ở trên để các file biên dịch cơ sở (`dist`, `public`, `native`) đã sẵn sàng.

Tiếp theo, hãy chạy lệnh tương ứng với hệ điều hành bạn muốn build:

### Dành cho macOS (Chip Intel và Apple Silicon M1/M2/M3/M4)
```bash
cd packages/electron
npm run build
npm run pack:mac
```
File cài đặt (`.dmg` và `.zip` cho cả chuẩn `arm64` và `x64`) sẽ được tạo ra tại: `packages/electron/release/`.

### Dành cho Windows
```bash
cd packages/electron
npm run build
npm run pack:win
```
File cài đặt (`.exe`) sẽ được xuất ra tại: `packages/electron/release/`.

### Dành cho Linux
```bash
cd packages/electron
npm run build
npm run pack:linux
```
File chạy dạng trực tiếp (`.AppImage`) sẽ được tạo tại: `packages/electron/release/`.

---

## 4. Triển khai (Deployment)

### Lựa chọn 1: Triển khai Backend Server (Dành cho Server/VPS)
Bạn có thể đưa proxy backend này lên các máy chủ Linux thông thường. Chỉ cần sao chép các file sau sau khi đã chạy lệnh `npm run build`:
- `dist/`
- `public/`
- `native/`
- `package.json`
- `node_modules/` (khuyến khích chỉ cài `production dependencies`)

Sử dụng PM2 để chạy tiến trình chạy ngầm liên tục:
```bash
npm install -g pm2
pm2 start dist/index.js --name "codex-proxy"
```

### Lựa chọn 2: Phân phối phần mềm Desktop
Với Desktop app, bạn chỉ việc lấy các file bản dựng (`.exe`, `.dmg`, `.AppImage`) trong thư mục `packages/electron/release/` và gửi cho người sử dụng.

*(Lưu ý trên macOS: Nếu bạn chưa cài chứng chỉ Apple Developer trong cấu hình `electron-builder.yml`, file `.dmg` sinh ra sẽ bị gắn cờ "unidentified developer". Người dùng có thể vượt qua bằng cách click chuột phải vào file và chọn "Open").*
