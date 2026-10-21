# near-server

Код WebSocket-сервера NEAR. В проде крутится на **Render**:  
https://near-server.onrender.com/

## Use Cloud Server.bat

Один раз (или после смены хоста):
- проверяет, что Render жив;
- пишет `near-server.onrender.com` в `CURRENT_HOST.txt`;
- пушит на GitHub — Android/PC сами берут адрес.

Локальный Cloudflare-туннель больше не используется.

## Env (Render)

Для доски объявлений (персистентность в Supabase):

| Variable | Example |
|----------|---------|
| `SUPABASE_URL` | `https://uaxanaiurpgocfqmpvwm.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key из Project Settings → API |

Без этих переменных сервер работает, но посты только в RAM (после сна Render пропадут).

Схемы (Supabase SQL Editor, по порядку):
1. [`sql/bulletin.sql`](sql/bulletin.sql) — городская доска
2. [`sql/office_board.sql`](sql/office_board.sql) — Kanban + итоги дня (ключ = имя офиса)

## Деплой checklist (инвестор-демо)

1. Supabase → SQL Editor → Run оба `.sql` файла.
2. Render → Environment → `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` → Save.
3. Push на GitHub (`DimaRabbit/near-server`) → Render deploy.
4. https://near-server.onrender.com/ → `NEAR Server Running`.
5. В логах: `bulletin+office→Supabase` (не `RAM only`).

Presence: `move` несёт `speed/yaw/falling`; `set_skin` + поле `skin` в `update`.  
Office: при create/join/hello сервер шлёт `office_snapshot` (cards + reports).

## Игра

Все (ты, телефон, другой город): Guest → PLAY → облако.  
Первый заход после сна Render: до ~60 сек.
