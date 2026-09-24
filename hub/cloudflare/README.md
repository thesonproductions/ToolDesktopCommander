# OpenCommander Hub (Cloudflare Workers)

Một endpoint MCP HTTPS cố định cho ChatGPT, định tuyến lệnh tới nhiều máy của bạn (PC, Laptop…). Mỗi máy chạy `opencommander agent` và **tự kết nối ra hub** qua WebSocket — không cần tunnel, không mở cổng, không cần IP tĩnh trên máy nào.

```
ChatGPT ──HTTPS──▶  https://<hub>.workers.dev/mcp/<MCP_TOKEN>
                          │  (Durable Object giữ danh sách máy + định tuyến)
              WebSocket   │   (máy tự kết nối RA hub)
          ┌───────────────┴───────────────┐
   opencommander agent (PC)        opencommander agent (Laptop)
```

Mỗi tool có thêm tham số `machine` (vd `"PC"`, `"Laptop"`). ChatGPT gọi `list_machines` (hoặc `session_start`) để biết máy nào đang online, rồi chỉ định máy cần chạy.

## Triển khai (một lần)

Cần một tài khoản Cloudflare **miễn phí**.

```bash
cd hub/cloudflare
npm install
npx wrangler login          # mở trình duyệt, đăng nhập Cloudflare
npm run deploy              # deploy + tự sinh MCP_TOKEN / AGENT_KEY / ADMIN_KEY
```

`npm run deploy` sẽ in ra URL hub, ba secret (lưu lại ngay), và đúng các lệnh cần dán. Đổi secret sau này: `node deploy.mjs --rotate`.

Ba secret (lưu trên Cloudflare, không nằm trong code):
- `MCP_TOKEN` — nằm trong URL ChatGPT dùng.
- `AGENT_KEY` — mỗi máy dùng để kết nối vào hub.
- `ADMIN_KEY` — mở trang duyệt approval `<hub>/admin`.

## Nối ChatGPT (một lần)

Developer mode → Tạo plugin → URL: `https://<hub>.workers.dev/mcp/<MCP_TOKEN>` → Auth: **None**.

## Trên mỗi máy

```bash
opencommander config set hub.url https://<hub>.workers.dev
opencommander config set hub.agent_key <AGENT_KEY>
opencommander config set machine_name PC        # máy kia đặt Laptop
opencommander agent                             # giữ chạy (có script autostart cho Windows)
```

Windows tự chạy khi đăng nhập: `scripts\opencommander\windows\install-agent-autostart.ps1`.

## Duyệt lệnh nguy hiểm

Lệnh nguy hiểm trả `APPROVAL_REQUIRED`. Bạn duyệt ở `<hub>/admin` (nhập `ADMIN_KEY`) — ngồi máy nào cũng duyệt được cho máy nào — hoặc ngay trên máy đó (`opencommander approve <id>`), rồi bảo ChatGPT gọi lại kèm `approval_id`.

## Chi phí & giới hạn

- Cloudflare Workers gói free đủ dùng cá nhân. Durable Object dùng lớp lưu trữ SQLite (khai báo sẵn trong `wrangler.toml`).
- Một lần gọi tool tối đa ~115 giây; việc lâu hơn dùng `job_start` + `job_wait` (job chạy trên máy, sống qua cả việc agent restart).
- Máy nào tắt/ngủ thì offline; job đang chạy trên nó vẫn tiếp tục và xem lại được khi nó kết nối lại.
- Đây là guardrail, không phải sandbox. Giữ bí mật `MCP_TOKEN` và `AGENT_KEY`; ai có `MCP_TOKEN` là điều khiển được máy bạn.

## Phát triển / kiểm thử cục bộ

```bash
npm run dev                 # workerd cục bộ tại http://127.0.0.1:8787
# đặt secret cục bộ trong .dev.vars (MCP_TOKEN/AGENT_KEY/ADMIN_KEY)
```

Test tự động của agent nằm ở `test/opencommander/hub-agent.test.mjs` (dựng hub WebSocket giả bằng Node, chạy agent thật): `npm run test:oc`.
