# OpenCommander

Fork của [DesktopCommanderMCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) (MIT), chạy trên máy của bạn và nối vào **ChatGPT Web** qua MCP. Không giới hạn số tool call, tác vụ dài không chết khi ChatGPT timeout, và có bộ tool kiểu coding agent (verify, checkpoint, tìm symbol, parse kết quả test).

```
ChatGPT Web ──HTTPS──▶ tunnel (cloudflared / ngrok / OpenAI Secure MCP Tunnel)
                               │
                               ▼
               127.0.0.1:7800/mcp  OpenCommander (stateless HTTP MCP)
                 ├─ Guard: policy → approval → time budget → mask secrets → audit
                 ├─ Persistent Job Manager  (~/.opencommander/jobs, detached runners)
                 ├─ Coding tools: test_run / lint_run / build_run / repo_verify / patch_apply
                 ├─ Git: repo_status / repo_diff / git_checkpoint / git_rollback
                 ├─ Repo intelligence: overview / find_symbol / outline / related / search / read_ranges
                 ├─ Task state (resume sau khi đứt chat)
                 └─ Toàn bộ tool gốc của Desktop Commander (read_file, edit_block, start_process…)
               127.0.0.1:7801  Dashboard duyệt approval (chỉ local, KHÔNG tunnel cổng này)
```

## Cái gì khác so với Remote Desktop Commander

| Vấn đề | Remote DC | OpenCommander |
|---|---|---|
| Giới hạn tool call | Có quota (dịch vụ hosted) | Không, chạy local |
| Tác vụ dài / timeout | Tool call chờ process → timeout là mất | `job_start` trả `job_id` ngay; runner tách rời (detached), sống qua việc ChatGPT đứt, reload tab, restart MCP server |
| Retry bị chạy 2 lần | Có thể | `request_key` idempotent + tự dedupe lệnh giống hệt trong 20 s |
| Mất session MCP | Có thể "session not found" | HTTP **stateless**: không có session để mất |
| Output lớn | Đổ log thô vào context | Parse local → JSON gọn (pytest, jest, vitest, go, cargo, node:test, maven/gradle/dotnet, tsc/ruff/mypy/eslint/rustc…); log đọc theo tail/offset/grep |
| Verify | Nhiều lệnh rời | `repo_verify` = lint + typecheck + test (+deps/build) trong 1 call |
| Hoàn tác | Không | `git_checkpoint` / `git_rollback` (không đụng HEAD/branch/stash, rollback cũng undo được) |
| An toàn | Guardrail cơ bản | Lệnh nguy hiểm → `APPROVAL_REQUIRED`, người duyệt ngoài ChatGPT; protected paths; che secret; audit JSONL |
| Resume | Prompt lại từ đầu | `task_state_save/get` + `session_start` khôi phục trạng thái |

Giới hạn cần biết: đây vẫn là ChatGPT làm "não"; OpenCommander không thể biến ChatGPT Web thành harness Codex. Nó làm cho tool bền, gọn, và hướng dẫn model làm việc theo quy trình agent. Nếu **máy tính ngủ/tắt**, job sẽ dừng (runner bị báo `lost`) → chỉnh Power plan "never sleep when plugged in" khi chạy job dài.

## Cài đặt (Windows)

Yêu cầu: Node.js ≥ 18 (khuyên 22 LTS), Git. Tuỳ chọn: `cloudflared` (tunnel).

```powershell
cd D:\Project\ToolDesktopCommander
npm install           # tự build (script prepare); nếu không cần write_pdf có thể: set PUPPETEER_SKIP_DOWNLOAD=1
node dist\opencommander\cli.js init      # tạo ~/.opencommander/config.json + token, in hướng dẫn
node dist\opencommander\cli.js doctor    # kiểm tra node/git/ripgrep/shell/port
```

(Tuỳ chọn) `npm link` để có lệnh `opencommander` toàn cục.

### Cấu hình khuyên dùng

`%USERPROFILE%\.opencommander\config.json` (tự reload khi sửa, không cần restart):

```json
{
  "security": {
    "profile": "developer",
    "allowed_roots": ["D:\\Project"]
  },
  "jobs": { "shell": "auto" }
}
```

- `profile`: `developer` (mặc định — lệnh nguy hiểm cần duyệt), `strict` (mọi lệnh ngoài allowlist đều cần duyệt), `open` (chỉ chặn lệnh thảm hoạ + protected paths).
- `allowed_roots`: rỗng = mọi nơi (protected paths vẫn bị chặn). Nên giới hạn về thư mục project.
- Shell của job: Windows mặc định **PowerShell**, macOS/Linux là bash. Đổi bằng `jobs.shell` hoặc tham số `shell` của `job_start` (`cmd`, `pwsh`, `bash`…).
- Xem đầy đủ các key trong `src/opencommander/config.ts` (`DEFAULT_CONFIG`).

## Chạy và nối vào ChatGPT

1. Chạy server: `scripts\opencommander\windows\start-opencommander.cmd` (hoặc `node dist\opencommander\cli.js serve`).
2. Mở HTTPS tới cổng 7800 — chọn **một** cách:
   - **Cloudflare quick tunnel** (nhanh nhất): `scripts\opencommander\windows\start-tunnel-cloudflared.cmd` → lấy URL `https://xxxx.trycloudflare.com`. URL đổi mỗi lần chạy; muốn cố định thì tạo *named tunnel* (`cloudflared tunnel login`, `cloudflared tunnel create opencommander`, trỏ DNS, `cloudflared tunnel run opencommander`).
   - **ngrok**: `ngrok http 7800` (có thể dùng domain cố định).
   - **OpenAI Secure MCP Tunnel** (nếu tài khoản/workspace có): chạy `tunnel-client` với `--mcp-server-url http://127.0.0.1:7800/mcp/<token>` — không cần mở cổng ra Internet.
3. ChatGPT (web) → Settings → Apps/Plugins → Advanced → bật **Developer mode**, rồi bấm **+** / *Create* để tạo app (connector) cho MCP server của bạn (tên menu có thể khác một chút tuỳ phiên bản):
   - URL: `https://<tunnel-host>/mcp/<token>` (lấy token: `node dist\opencommander\cli.js token`)
   - Authentication: **No authentication** (bí mật nằm trong URL). Client nào gửi được header thì dùng `https://<host>/mcp` + `Authorization: Bearer <token>`.
4. Trong chat: bật connector OpenCommander ở menu Developer mode. Nên tạo một **Project** và dán nội dung `plugin/opencommander/chatgpt-project-instructions.md` vào phần Instructions để model luôn theo quy trình agent.
5. Chạy tự động khi đăng nhập Windows: `powershell -ExecutionPolicy Bypass -File scripts\opencommander\windows\install-autostart.ps1 [-TunnelName opencommander]`.

Lưu ý về gói ChatGPT: tài liệu developer mode của OpenAI ghi Plus/Pro/Business/Enterprise/Edu đều dùng được developer mode, nhưng trang Help Center lại ghi quyền write/modify đầy đủ đang rollout cho Business/Enterprise/Edu. Hãy thử tài khoản của bạn trước (bạn đang dùng Remote Desktop Commander được thì nhiều khả năng dùng được). ChatGPT sẽ hỏi xác nhận các tool không phải read-only; bạn có thể chọn "remember" trong một cuộc chat. Các tool đọc của OpenCommander đều được đánh dấu `readOnlyHint` để giảm số lần hỏi.

Bảo mật token: ai có URL chứa token là điều khiển được máy bạn. Đổi token: `node dist\opencommander\cli.js token --rotate` rồi cập nhật URL connector. **Không bao giờ** tunnel cổng dashboard 7801.

## Quy trình làm việc (model được hướng dẫn tự động)

1. `session_start` → biết job đang chạy, task đang dở, approval đang chờ.
2. `task_state_save` (goal/plan/next_steps) và cập nhật sau mỗi bước. Khi chat bị đứt: mở chat mới, nói *"tiếp tục task fix-reviewer"* → model gọi `task_state_get`.
3. Tìm hiểu: `repo_overview` → `repo_find_symbol` / `repo_search` / `repo_related` / `repo_outline` → `read_ranges`.
4. `git_checkpoint` → sửa bằng `edit_block` / `patch_apply` → `repo_verify` → sửa tiếp đến khi xanh → báo cáo kèm checkpoint id.
5. Việc lâu: `job_start(request_key=...)` → `job_wait` (mỗi lần ≤ 55 s) → `job_result`.

## Approval

Khi model gọi lệnh nguy hiểm (vd `rm -rf build`, `git reset --hard`, `git push --force`, `docker system prune`, `sudo`, `npm publish`, đọc `~/.ssh`…), nó nhận `APPROVAL_REQUIRED` + `approval_id`. Bạn duyệt bằng:

- Dashboard: http://127.0.0.1:7801/ (Approve / Deny), hoặc
- CLI: `node dist\opencommander\cli.js approve apr_xxx` (`approvals` để liệt kê, `deny` để từ chối).

Approval gắn với đúng tool + tham số, dùng 1 lần, hết hạn sau 15 phút. Các lệnh thảm hoạ (`rm -rf /`, format ổ, `mkfs`, `dd of=/dev/sd*`, fork bomb, truy cập `~/.opencommander`) bị chặn hẳn.

Đây là guardrail, **không phải sandbox**: một lệnh bị cố tình làm rối vẫn có thể lọt. Chỉ kết nối ChatGPT account của bạn, giữ token bí mật, và đặt `allowed_roots`.

## Danh sách tool mới

| Nhóm | Tool |
|---|---|
| Phiên & resume | `session_start`, `task_state_save`, `task_state_get`, `approval_status`, `audit_log` |
| Job bền | `job_start`, `job_status`, `job_wait`, `job_logs`, `job_result`, `job_cancel`, `job_list`, `job_cleanup` |
| Coding | `test_run`, `lint_run`, `build_run`, `repo_verify`, `patch_preview`, `patch_apply` |
| Git | `repo_status`, `repo_diff`, `git_checkpoint`, `git_checkpoint_list`, `git_rollback` |
| Repo intelligence | `repo_overview`, `repo_find_symbol`, `repo_outline`, `repo_related`, `repo_search`, `read_ranges` |

Cộng với các tool gốc của Desktop Commander (bỏ các tool feedback/onboarding/usage). Có thể ẩn thêm bằng `hidden_tools` trong config.

## CLI

```
opencommander serve | stdio | init | token [--rotate] | doctor
opencommander approvals | approve <id> | deny <id>
opencommander jobs [status] | job <id> | logs <id> [--tail 200] | cancel <id>
```

`stdio` dùng cho Claude Desktop / Cursor / VS Code (cùng bộ tool, cùng guard).

## Dữ liệu trên máy

`~/.opencommander/` — `config.json`, `token`, `jobs/<id>/{spec.json,state.json,output.log,artifacts/}`, `keys/` (idempotency), `approvals/`, `tasks/`, `audit/YYYY-MM-DD.jsonl`, `server.log`, `dc/` (config của core Desktop Commander). Telemetry của upstream **tắt** mặc định.

## Phát triển

```
npm run build
npm run test:oc          # 54 test: parsers, security, jobs (restart/dedupe/cancel/timeout/lost/huge logs), git+intel, HTTP e2e
npm test                 # test gốc của Desktop Commander
```

Mã OpenCommander nằm gọn trong `src/opencommander/`; thay đổi ở file upstream được giữ tối thiểu (`src/server.ts`, `src/index.ts`, `src/config.ts`, `package.json`) để merge upstream dễ:

```
git fetch upstream
git merge upstream/main
npm run build && npm run test:oc
```
